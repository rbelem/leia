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
 * Voices are the ACCOUNT'S saved voices (Mistral console / Le Chat voice
 * library): getVoices() live-fetches GET /v1/audio/voices with the stored
 * key, and speak() with no selected voice falls back to the account's first
 * saved voice. Runs in any DOM-ish context (Firefox event page, Chrome
 * offscreen doc): fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const MISTRAL_TTS_URL = "https://api.mistral.ai/v1/audio/speech";
export const MISTRAL_VOICES_URL = "https://api.mistral.ai/v1/audio/voices";
export const MISTRAL_MODEL = "voxtral-mini-tts-2603";

export const MISTRAL_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000, // matches the sibling HTTP-MP3 engines; the ~300-word practical limit is looser than session chunking
};

export interface MistralVoiceDef {
  id: string;
  name?: string;
  languages?: string[];
}

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

  /** The account's saved voices — created in Mistral's console / Le Chat voice library. */
  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    return this.fetchVoices(key);
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

    let voiceId = options.voiceName;
    if (!voiceId) {
      // No voice selected: fall back to the account's first saved voice.
      const voices = await this.fetchVoices(key);
      if (!this.isCurrent(speakId)) return;
      voiceId = voices[0]?.name;
      if (!voiceId) {
        fail("No Mistral voices found — create one in the Mistral console (Le Chat voice library)");
        return;
      }
    }

    const result = await this.fetchAudio(text, voiceId, key);
    if (!this.isCurrent(speakId)) return;
    if (typeof result === "string") {
      fail(result);
      return;
    }

    const playback = this.audioHost.play(result, "audio/mpeg");
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

  /** GET /audio/voices → the account's saved voices; [] on failure/malformed. */
  private async fetchVoices(key: string): Promise<VoiceInfo[]> {
    try {
      const resp = await this.fetchImpl(MISTRAL_VOICES_URL, { headers: { Authorization: `Bearer ${key}` } });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { items?: unknown };
      if (!Array.isArray(data.items)) return [];
      return data.items
        .filter((v): v is MistralVoiceDef & { id: string } => typeof v?.id === "string" && v.id.length > 0)
        .map((v) => ({
          name: v.id, // VoiceInfo.name carries the voice_id (picker round-trips it as voiceName)
          lang: typeof v.languages?.[0] === "string" ? v.languages[0] : "en",
          localService: false,
          family: "mistral",
        }));
    } catch {
      return [];
    }
  }

  /** POST /audio/speech → decoded MP3 bytes, or a human-readable error string. */
  private async fetchAudio(text: string, voiceId: string, key: string): Promise<Uint8Array | string> {
    try {
      const resp = await this.fetchImpl(MISTRAL_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          model: MISTRAL_MODEL,
          voice_id: voiceId,
          response_format: "mp3",
          stream: false,
        }),
      });
      if (!resp.ok) return await errorDetail(resp);
      const envelope = (await resp.json()) as { audio_data?: unknown };
      const audioData = envelope.audio_data;
      if (typeof audioData !== "string" || audioData.length === 0) return "Mistral returned no audio payload";
      return base64ToBytes(audioData);
    } catch (err) {
      return `Mistral request failed: ${String(err)}`;
    }
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
