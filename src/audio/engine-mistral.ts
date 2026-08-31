// SPDX-License-Identifier: MPL-2.0
/**
 * Mistral (Voxtral) TTS engine (#02). Provider TTS via the v1 REST API: one
 * POST per chunk to /audio/speech (stream:false), JSON response whose
 * `audio_data` is BASE64-MP3 — decoded to bytes before audioHost playback
 * (the one twist vs. the raw-binary siblings). No timestamps —
 * sentence-granularity marching highlight only (ADR-0003), so
 * `wordTiming: false` and NO word events ever. `rate` has no API field —
 * accepted and ignored. Content-moderation rejections arrive as ordinary
 * 400s and surface inline through errorDetail.
 *
 * Voices are managed via Mistral's separate Voices API (saved profiles); no
 * list/fetch here — the engine speaks with MISTRAL_DEFAULT_VOICE unless the
 * caller picks one. Runs in any DOM-ish context (Firefox event page, Chrome
 * offscreen doc): fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const MISTRAL_TTS_URL = "https://api.mistral.ai/v1/audio/speech";
export const MISTRAL_MODEL = "voxtral-mini-tts-2603";
export const MISTRAL_DEFAULT_VOICE = "default"; // Decision (#02): anonymous/default voice_id — swap for a saved Voices API profile id if Mistral rejects it

export const MISTRAL_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000, // matches the sibling HTTP-MP3 engines; the ~300-word practical limit is looser than session chunking
};

export interface MistralEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class MistralEngine implements TextEngine {
  readonly family = "mistral";
  readonly capabilities = MISTRAL_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  constructor(opts: MistralEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  /** Single curated default voice — Mistral voice profiles live in their Voices API. */
  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    return [{ name: MISTRAL_DEFAULT_VOICE, lang: "en-US", localService: false, family: "mistral" }];
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
      fail("Mistral API key not set — providers settings");
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(MISTRAL_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          model: MISTRAL_MODEL,
          voice_id: options.voiceName ?? MISTRAL_DEFAULT_VOICE,
          response_format: "mp3",
          stream: false,
        }),
      });
    } catch (err) {
      fail(`Mistral request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    const envelope = (await resp.json()) as { audio_data?: unknown };
    if (!this.isCurrent(speakId)) return;
    const audioData = envelope.audio_data;
    if (typeof audioData !== "string" || audioData.length === 0) {
      fail("Mistral returned no audio payload");
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(audioData);
    } catch (err) {
      fail(`Mistral audio payload was not valid base64: ${String(err)}`);
      return;
    }
    const playback = this.audioHost.play(bytes, "audio/mpeg");
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

/**
 * Non-OK responses carry Mistral's error JSON — top-level `message`
 * (docs.mistral.ai) or an `error` field that is either a string or an
 * `{message}` object. Content-moderation 400s surface through this path.
 * Fall back to the status.
 */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as unknown;
      const message = pickErrorMessage(body);
      if (message) return message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `Mistral error ${resp.status}`;
}

/** First plausible human-readable message in a Mistral error body, if any. */
function pickErrorMessage(body: unknown): string | null {
  const b = body as { message?: unknown; error?: unknown };
  if (typeof b.message === "string" && b.message.length > 0) return b.message;
  if (typeof b.error === "string" && b.error.length > 0) return b.error;
  const message = (b.error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return null;
}

/** ~5-line base64 decoder — no Buffer in the extension bundle. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
