// SPDX-License-Identifier: MPL-2.0
/**
 * Google Gemini TTS engine (#03). Provider TTS via the generativelanguage
 * REST API: one POST per chunk to /v1beta/interactions (x-goog-api-key
 * header — no Bearer), JSON response whose audio (BASE64 RAW PCM: 16-bit
 * signed LE, rate from the payload, mono) lives in steps[].content[] under
 * type "audio" (older interaction variants put it at interaction.output_
 * audio — kept as a fallback). The engine prepends a canonical 44-byte
 * RIFF/WAVE header and plays audio/wav (the twist vs. the MP3 siblings). No timestamps — sentence-granularity marching highlight
 * only (ADR-0003), so `wordTiming: false` and NO word events ever. `rate`
 * has no API field — accepted and ignored.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
// Live-verified 2026-09-01; gemini-3.1-flash-tts-preview also verified 200 —
// no stable (non-preview) TTS model name exists yet.
export const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
export const GEMINI_DEFAULT_VOICE = "Kore";
export const GEMINI_SAMPLE_RATE = 24_000;

export const GEMINI_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000, // API doc limit is 4000 bytes; the sibling 2000-char chunking fits inside it
};

/**
 * Curated voice list — 30 prebuilt names from the speech-generation docs;
 * no documented voice-list endpoint. ponytail: static list; refresh if the
 * docs grow a list endpoint.
 */
export const GEMINI_VOICES: string[] = [
  "Kore", // default
  "Puck",
  "Charon",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Autonoe",
  "Callirrhoe",
  "Despina",
  "Enceladus",
  "Erinome",
  "Gacrux",
  "Iapetus",
  "Laomedeia",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zubenelgenubi",
];

export interface GeminiEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class GeminiEngine implements TextEngine {
  readonly family = "gemini";
  readonly capabilities = GEMINI_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  constructor(opts: GeminiEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    return GEMINI_VOICES.map((name) => ({ name, lang: "en-US", localService: false, family: "gemini" }));
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
      fail("Gemini API key not set — providers settings");
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(GEMINI_TTS_URL, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GEMINI_TTS_MODEL,
          input: text,
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice: options.voiceName ?? GEMINI_DEFAULT_VOICE }] },
        }),
      });
    } catch (err) {
      fail(`Gemini request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    const envelope = (await resp.json()) as GeminiEnvelope;
    if (!this.isCurrent(speakId)) return;
    const stepsAudio = pickStepsAudio(envelope);
    const audioData = stepsAudio ? stepsAudio.data : envelope.interaction?.output_audio?.data; // legacy fallback
    if (typeof audioData !== "string" || audioData.length === 0) {
      fail("Gemini returned no audio content item in steps");
      return;
    }
    // The audio item advertises its sample rate — honor it (default 24 kHz).
    const sampleRate =
      stepsAudio && typeof stepsAudio.sample_rate === "number" ? stepsAudio.sample_rate : GEMINI_SAMPLE_RATE;

    let bytes: Uint8Array;
    try {
      bytes = pcmToWav(base64ToBytes(audioData), sampleRate);
    } catch (err) {
      fail(`Gemini audio payload was not valid base64: ${String(err)}`);
      return;
    }
    const playback = this.audioHost.play(bytes, "audio/wav");
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
 * Google APIs error envelope — `{error: {code, message, status}}`; also
 * accepts a string `error` or a top-level `message`. Quota/bad-key failures
 * surface through this path. Fall back to the status.
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
  return `Gemini error ${resp.status}`;
}

/** First plausible human-readable message in a Google error body, if any. */
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

const WAV_HEADER_BYTES = 44;

interface GeminiAudioContent {
  type?: unknown;
  data?: unknown;
  sample_rate?: unknown;
}

interface GeminiEnvelope {
  /** Real 200 shape (verified 2026-09-01): audio lives in steps[].content[]. */
  steps?: Array<{ content?: GeminiAudioContent[] }>;
  /** Older interaction variants: top-level output_audio. Kept as fallback. */
  interaction?: { output_audio?: { data?: unknown } };
}

/** First real audio item in steps[].content[] — null when none is usable. */
function pickStepsAudio(envelope: GeminiEnvelope): GeminiAudioContent | null {
  for (const step of envelope.steps ?? []) {
    for (const item of step.content ?? []) {
      if (item.type === "audio" && typeof item.data === "string" && item.data.length > 0) return item;
    }
  }
  return null;
}

/** Canonical 44-byte RIFF/WAVE header for 16-bit signed LE mono PCM. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number = GEMINI_SAMPLE_RATE): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) wav[offset + i] = s.charCodeAt(i);
  };
  const u16 = (offset: number, v: number): void => view.setUint16(offset, v, true);
  const u32 = (offset: number, v: number): void => view.setUint32(offset, v, true);
  ascii(0, "RIFF");
  u32(4, 36 + pcm.length); // riffSize
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  u32(16, 16); // fmt chunk size
  u16(20, 1); // PCM
  u16(22, 1); // mono
  u32(24, sampleRate);
  u32(28, sampleRate * 2); // byteRate = rate × channels × bytesPerSample
  u16(32, 2); // blockAlign = channels × bytesPerSample
  u16(34, 16); // bits per sample
  ascii(36, "data");
  u32(40, pcm.length);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}
