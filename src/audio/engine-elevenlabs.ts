/**
 * ElevenLabs engine (T8, #9). Provider TTS via the v1 REST API — one POST
 * per chunk to the with-timestamps variant, which returns JSON with base64
 * MP3 audio + per-character alignment; word events are grouped from the
 * alignment on whitespace and scheduled against the audio start when the
 * response lands (MiniMax-style anchoring, so a slow synthesis doesn't delay
 * the march). A binary MP3 response (or missing alignment) plays with no
 * word events — `wordTiming` stays true, the events are just absent.
 *
 * Implements prefetch() (pipelining, ADR-0003): a `text|voice|rate`-keyed
 * cache of decoded audio bytes that a later speak() with identical
 * text+options consumes instead of re-synthesizing; cancel() discards it.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";
export type { AudioHost, Playback };

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_VOICES_URL = `${ELEVENLABS_BASE_URL}/v1/voices`;
export const ELEVENLABS_TTS_URL = `${ELEVENLABS_BASE_URL}/v1/text-to-speech`;
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
export const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel

export const ELEVENLABS_CAPABILITIES: EngineCapabilities = {
  wordTiming: true,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
};

/**
 * ElevenLabs voices carry a display-name language label (e.g. "Portuguese"),
 * not a BCP-47 tag; map the common names onto tags so the picker can group.
 * Unmapped labels fall back to "und".
 */
const LANGUAGE_TAGS: Record<string, string> = {
  arabic: "ar-SA",
  chinese: "zh-CN",
  czech: "cs-CZ",
  danish: "da-DK",
  dutch: "nl-NL",
  english: "en-US",
  finnish: "fi-FI",
  french: "fr-FR",
  german: "de-DE",
  greek: "el-GR",
  hindi: "hi-IN",
  indonesian: "id-ID",
  italian: "it-IT",
  japanese: "ja-JP",
  korean: "ko-KR",
  malay: "ms-MY",
  norwegian: "nb-NO",
  polish: "pl-PL",
  portuguese: "pt-BR",
  romanian: "ro-RO",
  russian: "ru-RU",
  slovak: "sk-SK",
  spanish: "es-ES",
  swedish: "sv-SE",
  tagalog: "tl-PH",
  thai: "th-TH",
  turkish: "tr-TR",
  ukrainian: "uk-UA",
  vietnamese: "vi-VN",
};

interface ElevenLabsVoiceDef {
  voice_id?: unknown;
  labels?: { language?: unknown };
}

interface ElevenLabsAlignment {
  characters?: unknown;
  character_start_times_seconds?: unknown;
  character_end_times_seconds?: unknown;
}

interface ElevenLabsTimestampsResponse {
  audio_base64?: unknown;
  audio?: unknown;
  alignment?: unknown;
}

export interface ElevenLabsEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class ElevenLabsEngine implements TextEngine {
  readonly family = "elevenlabs";
  readonly capabilities = ELEVENLABS_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private wordTimers: number[] = [];
  /** Decoded audio for chunk pipelining (ADR-0003); cancel() discards it. */
  private readonly cache = new Map<string, Uint8Array>();
  private cacheEpoch = 0;

  constructor(opts: ElevenLabsEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    try {
      const resp = await this.fetchImpl(ELEVENLABS_VOICES_URL, { headers: { "X-Api-Key": key } });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { voices?: ElevenLabsVoiceDef[] };
      if (!Array.isArray(data.voices)) return [];
      return data.voices
        .filter(
          (v): v is ElevenLabsVoiceDef & { voice_id: string } =>
            typeof v?.voice_id === "string" && v.voice_id.length > 0,
        )
        .map((v) => ({
          name: v.voice_id,
          lang: langTag(v.labels?.language),
          localService: false,
          family: "elevenlabs",
        }));
    } catch {
      return [];
    }
  }

  /**
   * Synthesize ahead for a FUTURE speak() with identical text+options
   * (pipelining, ADR-0003). Best-effort: a missing key or failed request
   * stores nothing and the later speak() synthesizes on demand.
   */
  async prefetch(text: string, options: SpeakOptions): Promise<void> {
    const key = await this.getKey();
    if (!key) return;
    const epoch = this.cacheEpoch;
    try {
      const resp = await this.fetchImpl(this.ttsUrl(options.voiceName), {
        method: "POST",
        headers: { "X-Api-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify(this.requestBody(text, options)),
      });
      if (!resp.ok) return;
      const audio = await this.parseAudio(resp);
      if (audio && this.cacheEpoch === epoch) this.cache.set(this.cacheKey(text, options), audio.bytes);
    } catch {
      // best-effort — a later speak() fetches on demand
    }
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like WebSpeechEngine: close the old stream + stop its audio.
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
    this.clearWordTimers();
    this.cacheEpoch += 1; // discard in-flight prefetch results too
    this.cache.clear();
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
      fail("ElevenLabs API key not set — providers settings");
      return;
    }

    let playback: Playback;
    let alignment: unknown = undefined;
    const cached = this.cache.get(this.cacheKey(text, options));
    if (cached) {
      playback = this.audioHost.play(cached, "audio/mpeg");
    } else {
      let resp: Response;
      try {
        resp = await this.fetchImpl(this.ttsUrl(options.voiceName), {
          method: "POST",
          headers: { "X-Api-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify(this.requestBody(text, options)),
        });
      } catch (err) {
        fail(`ElevenLabs request failed: ${String(err)}`);
        return;
      }
      if (!this.isCurrent(speakId)) return;
      if (!resp.ok) {
        fail(await errorDetail(resp));
        return;
      }
      const audio = await this.parseAudio(resp);
      if (!audio) {
        fail("ElevenLabs returned no audio payload");
        return;
      }
      playback = this.audioHost.play(audio.bytes, "audio/mpeg");
      alignment = audio.alignment;
    }
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    const playResolvedAt = Date.now();
    stream.push({ type: "start", speakId });
    if (alignment !== undefined) this.scheduleWords(alignment, speakId, stream, playResolvedAt);

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  /**
   * Group alignment characters into words on whitespace and schedule one
   * word event per word, anchored at the first word's start relative to
   * play resolution (elapsed synthesis time subtracted, MiniMax-style).
   */
  private scheduleWords(
    alignment: unknown,
    speakId: number,
    stream: EventStream<EngineEvent>,
    playResolvedAt: number,
  ): void {
    const a = alignment as ElevenLabsAlignment;
    const chars = a.characters;
    const starts = a.character_start_times_seconds;
    const ends = a.character_end_times_seconds;
    // Character arrays are parallel; any mismatch means we can't trust them.
    if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return;
    if (chars.length !== starts.length || chars.length !== ends.length) return;

    const words: Array<{ begin: number; end: number; time: number }> = [];
    let runStart = -1;
    let runTime = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      const t = starts[i];
      if (typeof ch !== "string" || typeof t !== "number") return; // malformed — drop all timing
      if (/\s/.test(ch)) {
        if (runStart >= 0) {
          words.push({ begin: runStart, end: i, time: runTime });
          runStart = -1;
        }
      } else if (runStart < 0) {
        runStart = i;
        runTime = t;
      }
    }
    if (runStart >= 0) words.push({ begin: runStart, end: chars.length, time: runTime });

    const firstTime = words[0]?.time;
    if (typeof firstTime !== "number") return;
    const elapsed = Date.now() - playResolvedAt;
    for (const w of words) {
      const delay = Math.max(0, Math.round((w.time - firstTime) * 1000) - elapsed);
      this.wordTimers.push(
        setTimeout(() => {
          stream.push({ type: "word", speakId, begin: w.begin, end: w.end });
        }, delay),
      );
    }
  }

  private ttsUrl(voiceName: string | null): string {
    return `${ELEVENLABS_TTS_URL}/${voiceName ?? ELEVENLABS_DEFAULT_VOICE}/with-timestamps`;
  }

  private requestBody(text: string, options: SpeakOptions): Record<string, unknown> {
    return {
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        speed: clampRate(options.rate),
      },
      output_format: ELEVENLABS_OUTPUT_FORMAT,
    };
  }

  private cacheKey(text: string, options: SpeakOptions): string {
    return `${text}|${options.voiceName ?? ""}|${options.rate}`;
  }

  private clearWordTimers(): void {
    for (const t of this.wordTimers) clearTimeout(t);
    this.wordTimers = [];
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }

  /** Decode a TTS response: JSON (with-timestamps) or raw binary MP3. */
  private async parseAudio(resp: Response): Promise<{ bytes: Uint8Array; alignment?: unknown } | null> {
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      let data: ElevenLabsTimestampsResponse;
      try {
        data = (await resp.json()) as ElevenLabsTimestampsResponse;
      } catch {
        return null;
      }
      const audio = data.audio_base64 ?? data.audio; // response-version drift: both keys have been seen
      if (typeof audio !== "string" || audio.length === 0) return null;
      return { bytes: base64ToBytes(audio), alignment: data.alignment };
    }
    // Binary MP3 (plain endpoint) — no timestamps available.
    const buf = await resp.arrayBuffer();
    return { bytes: new Uint8Array(buf) };
  }
}

/** Non-OK responses carry a JSON `detail` string; fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { detail?: unknown };
      if (typeof body.detail === "string" && body.detail.length > 0) return body.detail;
    } catch {
      // fall through to the generic status message
    }
  }
  return `ElevenLabs error ${resp.status}`;
}

/** ElevenLabs accepts 0.5–2.0 for the voice-settings speed field. */
function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

function langTag(display: unknown): string {
  if (typeof display !== "string") return "und";
  return LANGUAGE_TAGS[display.toLowerCase()] ?? "und";
}

/** ~10-line base64 decoder — no Buffer in the extension bundle. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}