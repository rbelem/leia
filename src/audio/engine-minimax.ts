/**
 * MiniMax Speech-2.8 engine (T20). Provider TTS via the t2a_v2 API:
 * one POST per chunk (stream:false), hex-encoded MP3 response, and — when
 * subtitles are enabled with type "word" — a SIGNED URL whose JSON payload
 * carries per-word timing (millisecond floats + char offsets into the input
 * text). Word events are scheduled against the audio start so the march
 * layer can highlight word-by-word.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";

export const MINIMAX_TTS_URL = "https://api.minimax.io/v1/t2a_v2";
export const MINIMAX_MODEL = "speech-2.8-hd"; // ponytail: constructor option when a second model is wanted
export const MINIMAX_MAX_CHARS = 10_000;

export const MINIMAX_CAPABILITIES: EngineCapabilities = {
  wordTiming: true,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000, // whole paragraphs in one request; API limit is 10k
};

interface MiniMaxVoiceDef {
  id: string;
  lang: string;
}

/**
 * Curated system voices — MiniMax has no documented voice-list endpoint
 * (GET /v1/voice_list 404s on api.minimax.io as of 2026-08-26; each id below
 * was live-verified against t2a_v2). All ids sound Chinese (zh-CN).
 * ponytail: static list until MiniMax documents the endpoint — refresh by
 * live-verifying candidate ids against t2a_v2.
 */
export const SYSTEM_VOICES: MiniMaxVoiceDef[] = [
  { id: "male-qn-qingse", lang: "zh-CN" },
  { id: "female-shaonv", lang: "zh-CN" },
  { id: "audiobook_female_1", lang: "zh-CN" },
  { id: "male-qn-qingse-jingpin", lang: "zh-CN" },
  { id: "male-qn-badao", lang: "zh-CN" },
  { id: "female-yujie", lang: "zh-CN" },
  { id: "audiobook_male_1", lang: "zh-CN" },
  { id: "audiobook_female_2", lang: "zh-CN" },
];

export interface Playback {
  stop(): void;
  /** Resolves when playback finishes (or fails); pending while playing. */
  done: Promise<void>;
  /** Media clock in ms (audio.currentTime×1000), when the host exposes one.
   * The visible page's word march re-anchors from this via clock polls —
   * reading it is synchronous truth even in a throttled background page. */
  clockMs?: () => number;
}

export interface AudioHost {
  play(bytes: Uint8Array, mime: string): Playback;
}

/** DOM default host: Blob → objectURL → `new Audio()`. */
export const DOM_AUDIO_HOST: AudioHost = {
  play(bytes: Uint8Array, mime: string): Playback {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    const audio = new Audio(url);
    // done is created up-front: finish() may fire synchronously (play throw)
    // and must always have its resolver ready.
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = finish;
    audio.onerror = finish;
    try {
      const p = audio.play();
      if (p) p.catch(finish); // autoplay blocked — treat as finished
    } catch {
      finish();
    }
    const clockMs = (): number => audio.currentTime * 1000;
    return {
      stop: () => { audio.pause(); finish(); },
      done,
      clockMs,
    };
  },
};

interface MiniMaxEnvelope {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: { audio?: string; subtitle_file?: string };
}

interface MiniMaxWord {
  word_begin?: number;
  word_end?: number;
  time_begin?: number;
}

interface MiniMaxSegment {
  timestamped_words?: MiniMaxWord[];
}

export interface MiniMaxEngineOptions {
  getKey: () => Promise<string | null>;
  /** When set, getVoices() keeps only voices whose lang starts with its script prefix. */
  locale?: string;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class MiniMaxEngine implements TextEngine {
  readonly family = "minimax";
  readonly capabilities = MINIMAX_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly locale?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: {
    speakId: number;
    stream: EventStream<EngineEvent>;
    playback: Playback | null;
  } | null = null;

  constructor(opts: MiniMaxEngineOptions) {
    this.getKey = opts.getKey;
    this.locale = opts.locale;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    const prefix = this.locale?.split("-")[0].toLowerCase();
    return SYSTEM_VOICES.filter((v) => !prefix || v.lang.toLowerCase().startsWith(prefix))
      .map((v) => ({ name: v.id, lang: v.lang, localService: false, family: "minimax" }));
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
  }

  // --- internals ---

  private async run(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
  ): Promise<void> {
    const fail = (message: string): void => {
      // NOTE: active?.speakId === speakId is always true here — each fail
      // site sits behind an isCurrent() guard over the same this.active.
      // The mismatch half of this condition is defensive only.
      stream.push({ type: "error", speakId, message });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };

    const key = await this.getKey();
    if (!this.isCurrent(speakId)) return;
    if (!key) {
      fail("MiniMax API key not set — providers settings (T14)");
      return;
    }
    if (text.length > MINIMAX_MAX_CHARS) {
      fail(`MiniMax text too long (${text.length} > ${MINIMAX_MAX_CHARS} chars)`);
      return;
    }

    let envelope: MiniMaxEnvelope;
    try {
      const resp = await this.fetchImpl(MINIMAX_TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          text,
          stream: false,
          voice_setting: { voice_id: options.voiceName ?? SYSTEM_VOICES[0].id, speed: clampRate(options.rate) },
          audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1, output_format: "hex" },
          subtitle_enable: true,
          subtitle_type: "word",
        }),
      });
      envelope = (await resp.json()) as MiniMaxEnvelope;
    } catch (err) {
      fail(`MiniMax request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (envelope.base_resp && envelope.base_resp.status_code !== 0) {
      fail(envelope.base_resp.status_msg ?? `MiniMax error ${envelope.base_resp.status_code}`);
      return;
    }

    const hex = envelope.data?.audio;
    if (typeof hex !== "string" || hex.length === 0) {
      fail("MiniMax returned no audio payload");
      return;
    }
    const playback = this.audioHost.play(hexToBytes(hex), "audio/mpeg");
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    stream.push({ type: "start", speakId });

    void this.scheduleWords(envelope.data?.subtitle_file, speakId, stream, playback);
    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

/** Fetch the subtitle file and ship the chunk's word timeline once. */
  private async scheduleWords(
    subtitleUrl: unknown,
    speakId: number,
    stream: EventStream<EngineEvent>,
    playback: Playback,
  ): Promise<void> {
    let segments: MiniMaxSegment[] = [];
    try {
      if (typeof subtitleUrl !== "string") return;
      const resp = await this.fetchImpl(subtitleUrl);
      if (!resp.ok) return;
      const data: unknown = await resp.json();
      if (!Array.isArray(data)) return;
      segments = data as MiniMaxSegment[];
    } catch {
      return;
    }
    const words: MiniMaxWord[] = [];
    for (const seg of segments) {
      if (Array.isArray(seg.timestamped_words)) words.push(...seg.timestamped_words);
    }
    const firstTime = words[0]?.time_begin;
    if (typeof firstTime !== "number") return;
    const due = words
      .filter((w) => {
        const { word_begin: begin, word_end: end, time_begin: t } = w;
        return typeof begin === "number" && typeof end === "number" && typeof t === "number" && end > begin;
      })
      .map((w) => ({ begin: w.word_begin as number, end: w.word_end as number, t: w.time_begin as number }))
      .sort((a, b) => a.t - b.t);
    if (due.length === 0) return;

    // Ship the WHOLE timeline once: the visible content page marches words
    // locally via rAF, re-anchoring from live clock polls (content/march.ts).
    // Hidden background pages clamp timers (1s → 30s), so scheduling
    // per-word here lags the voice by seconds.
    const timeline = due.map(({ begin, end, t }) => ({ begin, end, t: t - firstTime }));
    if (!this.isCurrent(speakId)) return;
    stream.push({
      type: "timeline",
      speakId,
      words: timeline,
      anchorWall: Date.now(),
      anchorClock: playback.clockMs?.() ?? 0,
    });
  }

  /** Media clock (ms) of the active chunk's audio, for the march's poll. */
  currentClockMs(): number | null {
    return this.active?.playback?.clockMs?.() ?? null;
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

function clampRate(rate: number): number {
  // Guard non-finite (API rejects NaN speed) — mirrors the utterance.rate clamp.
  const r = Number.isFinite(rate) ? rate : 1;
  return Math.min(2, Math.max(0.5, r));
}

/** ~8-line hex decoder — no Buffer in the extension bundle. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}