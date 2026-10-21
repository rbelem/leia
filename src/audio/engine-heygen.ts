// SPDX-License-Identifier: MPL-2.0
/**
 * HeyGenVoiceEngine (heygen family): HeyGen Voice text to speech.
 *
 * HeyGen's in-house voice model, reached through the same adapter interface
 * as every other provider engine (ADR-0003). The catalog is public, so the
 * picker lists voices without a key being saved; synthesis needs one.
 *
 * Shape of the API (HeyGen external API v1, 2026-10):
 *   GET  /v3/models/audio/voices?type=public  -> { data: ModelAudioVoice[] }
 *   POST /v3/models/audio/tts                 -> { data: { audio_url, duration,
 *                                                      original_words? } }
 *
 * The model is a request field, not a voice field: `heygen-voice-1` (standard),
 * `heygen-voice-1-turbo` (faster, instant voices) and `heygen-voice-1-turbo-free`
 * (free until 2026-11-30, shared capacity — it can answer 429 even below the
 * per-user limit). `heygen-voice-1` is the default here: a promo model that
 * expires would break every reader who saved a key.
 *
 * Word timing: the response carries `original_words` (word text + start/end
 * seconds) when the request sets `with_timestamps`. The engine maps those words
 * onto character offsets in the submitted text, because the marching highlight
 * marks text by offset, not by time. A word whose text does not appear in the
 * source is dropped rather than guessed.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export type { AudioHost, Playback };

export const HEYGEN_BASE_URL = "https://api.heygen.com";
export const HEYGEN_VOICES_URL = `${HEYGEN_BASE_URL}/v3/models/audio/voices`;
export const HEYGEN_TTS_URL = `${HEYGEN_BASE_URL}/v3/models/audio/tts`;

/** Nadine — a public HeyGen Voice voice that needs no clone. */
export const HEYGEN_DEFAULT_VOICE = "83548de556df48ba8c09c42a57c51d85";

export const HEYGEN_MODELS = ["heygen-voice-1", "heygen-voice-1-turbo", "heygen-voice-1-turbo-free"] as const;
export type HeyGenModel = (typeof HEYGEN_MODELS)[number];
export const HEYGEN_DEFAULT_MODEL: HeyGenModel = "heygen-voice-1";

export const HEYGEN_CAPABILITIES: EngineCapabilities = {
  wordTiming: true,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
};

interface HeyGenVoiceDef {
  voice_id?: string;
  name?: string;
  language?: string | null;
  status?: string;
}

interface HeyGenWordTiming {
  text?: string;
  start_time?: number;
  end_time?: number;
}

interface HeyGenSpeechData {
  audio_url?: string;
  duration?: number;
  original_words?: HeyGenWordTiming[] | null;
}

export interface HeyGenEngineOptions {
  getKey: () => Promise<string | null>;
  /** Voice model to request; defaults to `heygen-voice-1`. */
  model?: HeyGenModel;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class HeyGenVoiceEngine implements TextEngine {
  readonly family = "heygen";
  readonly capabilities = HEYGEN_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly model: HeyGenModel;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private wordTimers: ReturnType<typeof setTimeout>[] = [];
  /** Decoded audio for chunk pipelining (ADR-0003): one entry, latest
   * prefetch wins; cancel() discards it. `apiKey` pins the entry to the
   * key that synthesized it so a key change cannot serve stale audio. */
  private cache: { apiKey: string; cacheKey: string; bytes: Uint8Array } | null = null;
  private cacheEpoch = 0;

  constructor(opts: HeyGenEngineOptions) {
    this.getKey = opts.getKey;
    this.model = opts.model ?? HEYGEN_DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    try {
      const resp = await this.fetchImpl(`${HEYGEN_VOICES_URL}?type=public&limit=100`, {
        headers: { "X-Api-Key": key },
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { data?: HeyGenVoiceDef[] };
      if (!Array.isArray(data.data)) return [];
      return data.data
        .filter(
          (v): v is HeyGenVoiceDef & { voice_id: string } =>
            typeof v?.voice_id === "string" &&
            v.voice_id.length > 0 &&
            // Only ACTIVE voices speak; PENDING clones and FAILED ones do not.
            v.status === "ACTIVE",
        )
        .map((v) => ({
          name: v.voice_id,
          title: v.name ?? v.voice_id,
          lang: v.language ?? "",
          localService: false,
          family: "heygen",
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
      const bytes = await this.synthesize(key, text, options);
      if (bytes && this.cacheEpoch === epoch) {
        this.cache = { apiKey: key, cacheKey: this.cacheKey(text, options), bytes };
      }
    } catch {
      // best-effort — a later speak() fetches on demand
    }
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like the other provider engines: close the old stream + stop its audio.
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
    this.cache = null;
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
      fail("HeyGen API key not set — providers settings");
      return;
    }

    let playback: Playback;
    let words: HeyGenWordTiming[] | null = null;
    const cached = this.cachedFor(key, text, options);
    if (cached) {
      playback = this.audioHost.play(cached, "audio/wav");
    } else {
      let bytes: Uint8Array | null;
      let timings: HeyGenWordTiming[] | null;
      try {
        ({ bytes, timings } = await this.synthesizeWithTimings(key, text, options));
      } catch (err) {
        fail(`HeyGen request failed: ${String(err)}`);
        return;
      }
      if (!this.isCurrent(speakId)) return;
      if (!bytes) {
        fail("HeyGen returned no audio payload");
        return;
      }
      playback = this.audioHost.play(bytes, "audio/wav");
      words = timings;
    }
    this.active = { speakId, stream, playback };
    const playResolvedAt = Date.now();
    stream.push({ type: "start", speakId });
    if (words) this.scheduleWords(text, words, speakId, stream, playResolvedAt);

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  /**
   * Map the response's word timings onto character offsets in `text`, then
   * schedule one word event per word, anchored at the first word's start
   * relative to play resolution (the synthesis time is subtracted, so the
   * highlight starts with the audio rather than behind it).
   */
  private scheduleWords(
    text: string,
    words: HeyGenWordTiming[],
    speakId: number,
    stream: EventStream<EngineEvent>,
    playResolvedAt: number,
  ): void {
    const marks: Array<{ begin: number; end: number; time: number }> = [];
    let cursor = 0;
    for (const w of words) {
      const word = typeof w?.text === "string" ? w.text : "";
      if (word.length === 0) continue;
      const at = text.indexOf(word, cursor);
      if (at < 0) continue; // the response's segmentation does not match the source — skip, never guess
      cursor = at + word.length;
      const time = typeof w.start_time === "number" ? w.start_time : undefined;
      if (time === undefined) continue;
      marks.push({ begin: at, end: at + word.length, time });
    }
    const firstTime = marks[0]?.time;
    if (typeof firstTime !== "number") return;
    const elapsed = Date.now() - playResolvedAt;
    for (const m of marks) {
      const delay = Math.max(0, Math.round((m.time - firstTime) * 1000) - elapsed);
      this.wordTimers.push(
        setTimeout(() => {
          stream.push({ type: "word", speakId, begin: m.begin, end: m.end });
        }, delay),
      );
    }
  }

  private async synthesize(key: string, text: string, options: SpeakOptions): Promise<Uint8Array | null> {
    const { bytes } = await this.synthesizeWithTimings(key, text, options);
    return bytes;
  }

  /**
   * One synthesis round trip: POST the speech request, then fetch the audio
   * the response points at. HeyGen returns a URL, not bytes.
   */
  private async synthesizeWithTimings(
    key: string,
    text: string,
    options: SpeakOptions,
  ): Promise<{ bytes: Uint8Array | null; timings: HeyGenWordTiming[] | null }> {
    const resp = await this.fetchImpl(HEYGEN_TTS_URL, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(this.requestBody(text, options)),
    });
    if (!resp.ok) throw new Error(await errorDetail(resp));
    const body = (await resp.json()) as { data?: HeyGenSpeechData };
    const audioUrl = body.data?.audio_url;
    if (typeof audioUrl !== "string" || audioUrl.length === 0) {
      return { bytes: null, timings: null };
    }
    const audio = await this.fetchImpl(audioUrl);
    if (!audio.ok) return { bytes: null, timings: null };
    const buf = await audio.arrayBuffer();
    const words = Array.isArray(body.data?.original_words) ? body.data!.original_words! : null;
    return { bytes: new Uint8Array(buf), timings: words };
  }

  private requestBody(text: string, options: SpeakOptions): Record<string, unknown> {
    return {
      text,
      voice_id: options.voiceName ?? HEYGEN_DEFAULT_VOICE,
      model: this.model,
      // Word timings for the marching highlight; the API omits them otherwise.
      with_timestamps: true,
    };
  }

  private cacheKey(text: string, options: SpeakOptions): string {
    return `${text}|${options.voiceName ?? ""}|${this.model}`;
  }

  /**
   * Serve the pipelining cache when text+options+key all match. A
   * mismatching speak() discards the entry (ADR-0003 — latest prefetch
   * wins; nothing stale survives to a later speak). A matching speak()
   * keeps it: the next prefetch overwrites it and cancel() clears it.
   */
  private cachedFor(apiKey: string, text: string, options: SpeakOptions): Uint8Array | null {
    const entry = this.cache;
    if (!entry) return null;
    const match = entry.apiKey === apiKey && entry.cacheKey === this.cacheKey(text, options);
    if (!match) this.cache = null;
    return match ? entry.bytes : null;
  }

  private clearWordTimers(): void {
    for (const t of this.wordTimers) clearTimeout(t);
    this.wordTimers = [];
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

/** Non-OK responses carry a JSON `error` object; fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { error?: { message?: unknown; code?: unknown } };
      const message = body.error?.message;
      if (typeof message === "string" && message.length > 0) {
        const code = typeof body.error?.code === "string" ? ` (${body.error.code})` : "";
        return `HeyGen ${resp.status}${code}: ${message}`;
      }
    } catch {
      // fall through to the generic status message
    }
  }
  return `HeyGen ${resp.status}: ${resp.statusText || "request failed"}`;
}
