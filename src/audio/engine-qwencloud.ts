// SPDX-License-Identifier: MPL-2.0
/**
 * QwenCloud TTS engine (Alibaba Qwen-TTS family). Provider TTS via the
 * DashScope-style REST API: one POST per chunk to the multimodal-generation
 * endpoint returns a JSON envelope whose `output.audio.url` points at a WAV
 * file (24h expiry, OSS host) — a second GET fetches the bytes for
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

export const QWENCLOUD_TTS_URL =
  "https://maas.qwencloudapi.com/api/v1/services/aigc/multimodal-generation/generation";
export const QWENCLOUD_MODEL = "qwen3-tts-flash"; // low-latency tier; plus tier targets audiobook production
export const QWENCLOUD_DEFAULT_VOICE = "Cherry";
export const QWENCLOUD_MAX_CHARS = 600; // API input limit; session chunks are ≤250, so this only trips on misuse

export const QWENCLOUD_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/**
 * Curated voice list — QwenCloud documents no voice-list endpoint; the 10
 * voices confirmed for qwen3-tts-flash in the Qwen-TTS voice list
 * (docs.qwencloud.com, 2026-10). ponytail: static list; refresh if
 * QwenCloud documents a list endpoint.
 */
export const QWENCLOUD_VOICES: string[] = [
  "Cherry", // default
  "Serena",
  "Ethan",
  "Chelsie",
  "Momo",
  "Vivian",
  "Moon",
  "Maia",
  "Kai",
  "Nofish",
];

export interface QwenCloudEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class QwenCloudEngine implements TextEngine {
  readonly family = "qwencloud";
  readonly capabilities = QWENCLOUD_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  constructor(opts: QwenCloudEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    return QWENCLOUD_VOICES.map((name) => ({ name, lang: "en-US", localService: false, family: "qwencloud" }));
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
      fail("QwenCloud API key not set — providers settings");
      return;
    }
    if (text.length > QWENCLOUD_MAX_CHARS) {
      fail(`QwenCloud text too long (${text.length} > ${QWENCLOUD_MAX_CHARS} chars)`);
      return;
    }

    // Step 1: synthesize → JSON envelope with a temporary audio URL.
    let resp: Response;
    try {
      resp = await this.fetchImpl(QWENCLOUD_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: QWENCLOUD_MODEL,
          input: {
            text,
            voice: options.voiceName ?? QWENCLOUD_DEFAULT_VOICE,
          },
        }),
      });
    } catch (err) {
      fail(`QwenCloud request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    let audioUrl: unknown;
    try {
      const body = (await resp.json()) as { output?: { audio?: { url?: unknown } } };
      audioUrl = body.output?.audio?.url;
    } catch {
      fail("QwenCloud response is not JSON");
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (typeof audioUrl !== "string" || audioUrl.length === 0) {
      fail("QwenCloud response has no audio url");
      return;
    }

    // Step 2: download the WAV bytes from the result URL.
    let audio: Response;
    try {
      audio = await this.fetchImpl(audioUrl);
    } catch (err) {
      fail(`QwenCloud audio download failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!audio.ok) {
      fail(`QwenCloud audio error ${audio.status}`);
      return;
    }
    const buf = await audio.arrayBuffer();
    if (!this.isCurrent(speakId)) return;
    const mime = audioMime(audio);
    const playback = this.audioHost.play(new Uint8Array(buf), mime);
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

/** Result URLs are .wav; trust a declared audio/* content-type, else default. */
function audioMime(resp: Response): string {
  const ct = resp.headers.get("content-type")?.split(";")[0].trim() ?? "";
  return ct.startsWith("audio/") ? ct : "audio/wav";
}

/** Non-OK responses carry DashScope's top-level `{code, message}` JSON; fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length > 0) return body.message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `QwenCloud error ${resp.status}`;
}
