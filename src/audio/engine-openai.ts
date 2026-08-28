// SPDX-License-Identifier: MPL-2.0
/**
 * OpenAI TTS engine (T10, #11). Provider TTS via the v1 REST API: one POST
 * per chunk to /audio/speech, binary MP3 response → audioHost playback.
 * no timestamps in the response — sentence-granularity marching highlight
 * only (ADR-0003), so `wordTiming: false` and NO word events ever.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
export const OPENAI_VOICES_URL = "https://api.openai.com/v1/audio/voices";
export const OPENAI_MODEL = "gpt-4o-mini-tts";
export const OPENAI_DEFAULT_VOICE = "alloy";
export const OPENAI_MAX_CHARS = 4096; // OpenAI input limit; session chunks are ≤250, so this only trips on misuse

export const OPENAI_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/**
 * Curated fallback list (used when GET /audio/voices 404s/unshapes):
 * the 10 canonical tts-1 voices. ponytail: ember/jasmine/verse (gpt-4o-era)
 * deliberately excluded to keep the picker stable — add when the API list
 * is confirmed live.
 */
export const OPENAI_FALLBACK_VOICES: string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];

export interface OpenAIEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class OpenAIEngine implements TextEngine {
  readonly family = "openai";
  readonly capabilities = OPENAI_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  constructor(opts: OpenAIEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    try {
      const resp = await this.fetchImpl(OPENAI_VOICES_URL, { headers: { Authorization: `Bearer ${key}` } });
      if (resp.ok) {
        const data = (await resp.json()) as { voices?: unknown };
        if (Array.isArray(data.voices) && data.voices.every((v): v is string => typeof v === "string")) {
          return data.voices.map((name) => ({ name, lang: "en-US", localService: false, family: "openai" }));
        }
      }
    } catch {
      // fall through to the curated list
    }
    return OPENAI_FALLBACK_VOICES.map((name) => ({ name, lang: "en-US", localService: false, family: "openai" }));
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like the sibling engines: close the old stream + stop its audio.
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      wasActive.playback?.stop();
    }
    void this.run(text, speakId, options, stream);
    return stream;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
  }

  // --- internals ---

  private async run(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
  ): Promise<void> {
    const fail = (message: string): void => {
      stream.push({ type: "error", speakId, message });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };

    const key = await this.getKey();
    if (!this.isCurrent(speakId)) return;
    if (!key) {
      fail("OpenAI API key not set — providers settings");
      return;
    }
    if (text.length > OPENAI_MAX_CHARS) {
      fail(`OpenAI text too long (${text.length} > ${OPENAI_MAX_CHARS} chars)`);
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(OPENAI_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          voice: options.voiceName ?? OPENAI_DEFAULT_VOICE,
          input: text,
          response_format: "mp3",
        }),
      });
    } catch (err) {
      fail(`OpenAI request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    const buf = await resp.arrayBuffer();
    if (!this.isCurrent(speakId)) return;
    const playback = this.audioHost.play(new Uint8Array(buf), "audio/mpeg");
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    stream.push({ type: "start", speakId });

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

/** Non-OK responses carry a JSON `error.message`; fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string" && body.error.message.length > 0) return body.error.message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `OpenAI error ${resp.status}`;
}