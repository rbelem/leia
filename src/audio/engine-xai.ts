// SPDX-License-Identifier: MPL-2.0
/**
 * xAI (Grok) TTS engine (#01). Provider TTS via the v1 REST API: one POST
 * per chunk to /v1/tts, RAW binary MP3 response (no JSON envelope) →
 * audioHost playback. No timestamps in the response — sentence-granularity
 * marching highlight only (ADR-0003), so `wordTiming: false` and NO word
 * events ever. `rate` has no API field — accepted and ignored.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const XAI_TTS_URL = "https://api.x.ai/v1/tts";
export const XAI_DEFAULT_VOICE = "eve";
export const XAI_LANGUAGE = "en"; // ponytail: constructor option when a second language is wanted

export const XAI_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000, // matches the sibling HTTP-MP3 engines; session chunks are ≤250, so this only trips on misuse
};

/**
 * Curated voice list — xAI documents no voice-list endpoint; all 28 ids from
 * docs.x.ai (2026-08). ponytail: static list; refresh if xAI documents a
 * list endpoint.
 */
export const XAI_VOICES: string[] = [
  "eve", // default
  "carina",
  "zagan",
  "helix",
  "orion",
  "luna",
  "iris",
  "altair",
  "zenith",
  "perseus",
  "helios",
  "lux",
  "kepler",
  "rigel",
  "cosmo",
  "celeste",
  "ursa",
  "sirius",
  "lumen",
  "castor",
  "naksh",
  "atlas",
  "aurora",
  "liora",
  "ara",
  "leo",
  "rex",
  "sal",
];

export interface XaiEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class XaiEngine implements TextEngine {
  readonly family = "xai";
  readonly capabilities = XAI_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  constructor(opts: XaiEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    return XAI_VOICES.map((name) => ({ name, lang: "en-US", localService: false, family: "xai" }));
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
      fail("xAI API key not set — providers settings");
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(XAI_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice_id: options.voiceName ?? XAI_DEFAULT_VOICE,
          language: XAI_LANGUAGE,
        }),
      });
    } catch (err) {
      fail(`xAI request failed: ${String(err)}`);
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

/**
 * Non-OK responses carry xAI's error JSON — `{"error": "<string>",
 * "code": ...}` (docs.x.ai), which also accepts the OpenAI-style
 * `{error:{message}}`. Fall back to the status.
 */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) return body.error;
      const message = (body.error as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message.length > 0) return message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `xAI error ${resp.status}`;
}
