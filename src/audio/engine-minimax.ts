// SPDX-License-Identifier: MPL-2.0
/**
 * MiniMax Speech-2.8 engine (T20). Provider TTS via the t2a_v2 API, in two
 * transports picked per speak from the host's capabilities:
 *
 * - Streaming (host has AudioHost.playProgressive): POST with stream:true +
 *   subtitle_type "word_streaming"; the HTTP-chunked body is a series of
 *   JSON objects whose `data.audio` hex fragments are appended to a
 *   MediaSource-backed playback as they arrive (first-audio ≈ first byte).
 * - Batch (no progressive seam): one POST per chunk (stream:false),
 *   hex-encoded MP3 response.
 *
 * Both transports — when subtitles are enabled — get a SIGNED URL whose
 * JSON payload carries per-word timing (millisecond floats + char offsets
 * into the input text). Word events are scheduled against the audio start
 * so the march layer can highlight word-by-word.
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
  // HTTP-chunked t2a_v2 (stream:true) via AudioHost.playProgressive; hosts
  // without the seam silently get the exact legacy batch path below.
  streaming: true,
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

/** Playback fed incrementally: audio chunks arrive as the network streams. */
export interface ProgressivePlayback extends Playback {
  append(chunk: Uint8Array): void;
  /** All chunks delivered — flush the tail and finish when drained. */
  end(): void;
}

export interface AudioHost {
  play(bytes: Uint8Array, mime: string): Playback;
  /** Optional incremental playback (MediaSource-backed). Engines fall back
   * to whole-clip play() when the property is absent. */
  playProgressive?(mime: string): ProgressivePlayback;
}

/** Copy a view into its own ArrayBuffer (media APIs choke on shared pools). */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** MediaSource-backed progressive playback: hex-decoded MP3 fragments are
 * appended as they stream in; appends queue while the SourceBuffer is
 * updating; end() drains the queue, then closes the stream. */
function domPlayProgressive(mime: string): ProgressivePlayback {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const audio = new Audio(url);
  // done is created up-front: finish() may fire synchronously (play throw,
  // addSourceBuffer failure) and must always have its resolver ready.
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  let finished = false;
  let buffer: SourceBuffer | null = null;
  const queue: Uint8Array[] = [];
  let streamEnded = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    URL.revokeObjectURL(url);
    resolve();
  };
  audio.onended = finish;
  audio.onerror = finish;

  const flush = (): void => {
    if (finished) return; // stopped/errored: drop whatever is queued
    const sb = buffer;
    if (!sb || sb.updating) return;
    const chunk = queue.shift();
    if (chunk !== undefined) {
      try {
        sb.appendBuffer(toBuffer(chunk));
      } catch {
        finish();
      }
      return;
    }
    if (streamEnded && ms.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {
        finish();
      }
    }
  };

  ms.addEventListener("sourceopen", () => {
    try {
      buffer = ms.addSourceBuffer(mime);
    } catch {
      finish();
      return;
    }
    buffer.addEventListener("updateend", flush);
    buffer.addEventListener("error", finish);
    flush();
  });

  try {
    const p = audio.play();
    if (p) p.catch(finish); // autoplay blocked — treat as finished
  } catch {
    finish();
  }

  return {
    stop: () => { audio.pause(); finish(); },
    done,
    clockMs: () => audio.currentTime * 1000,
    append(chunk: Uint8Array): void {
      queue.push(chunk);
      flush();
    },
    end(): void {
      streamEnded = true;
      flush();
    },
  };
}

/** Progressive support gate for this context (jsdom/tests lack MediaSource). */
const MEDIA_SOURCE_READY =
  typeof MediaSource === "function" &&
  typeof MediaSource.isTypeSupported === "function" &&
  MediaSource.isTypeSupported("audio/mpeg");

/** DOM default host: Blob → objectURL → `new Audio()`, plus MediaSource
 * streaming where available. playProgressive is OMITTED (not a throwing
 * stub) when unsupported, so engines fall back to whole-clip play(). */
export const DOM_AUDIO_HOST: AudioHost = {
  play(bytes: Uint8Array, mime: string): Playback {
    const buf = toBuffer(bytes);
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
  ...(MEDIA_SOURCE_READY ? { playProgressive: domPlayProgressive } : {}),
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
    /** Streaming fetch abort handle: lets cancel()/preempt break a pending
     * body read instead of waiting for the connection to drain. */
    abort?: AbortController;
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
    this.active = { speakId, stream, playback: null, abort: new AbortController() };
    if (wasActive) {
      // Preempt like WebSpeechEngine: close the old stream + stop its audio.
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      wasActive.abort?.abort();
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
      active.abort?.abort();
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

    // Transport picked per speak: hosts with the progressive seam stream
    // (first audio at first byte); hosts without it run today's exact
    // batch path (identical request, events, and timing anchors).
    const playProgressive = this.audioHost.playProgressive?.bind(this.audioHost);
    if (playProgressive) {
      await this.runStreamed(text, speakId, options, stream, key, playProgressive, fail);
      return;
    }
    await this.runBatch(text, speakId, options, stream, key, fail);
  }

  /** Legacy batch path (stream:false → one envelope → one play). Kept
   * verbatim for hosts without playProgressive. */
  private async runBatch(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
    key: string,
    fail: (message: string) => void,
  ): Promise<void> {
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

  /**
   * HTTP-chunked streaming: stream:true t2a_v2 emits JSON objects back to
   * back; each `data.audio` is an independently hex-encoded MP3 fragment
   * appended to the progressive playback as it arrives. The websocket
   * variant (wss://api.minimax.io/ws/v1/t2a_v2) stays unbuilt — its
   * subtitle delivery is undocumented; revisit if MiniMax documents it.
   */
  private async runStreamed(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
    key: string,
    playProgressive: (mime: string) => ProgressivePlayback,
    fail: (message: string) => void,
  ): Promise<void> {
    const signal = this.active?.abort?.signal;
    let resp: Response;
    try {
      resp = await this.fetchImpl(MINIMAX_TTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          text,
          stream: true,
          voice_setting: { voice_id: options.voiceName ?? SYSTEM_VOICES[0].id, speed: clampRate(options.rate) },
          audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1, output_format: "hex" },
          subtitle_enable: true,
          subtitle_type: "word_streaming",
        }),
        signal,
      });
    } catch (err) {
      if (!this.isCurrent(speakId)) return; // aborted by cancel/preempt — already terminal
      fail(`MiniMax request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    const reader = resp.body?.getReader();
    if (!reader) {
      fail("MiniMax returned no stream body");
      return;
    }

    const session = { playback: null as ProgressivePlayback | null, subtitleFile: null as string | null };
    if (await this.consumeStream(reader, speakId, stream, session, playProgressive, fail)) return;

    const playback = session.playback;
    if (!playback) {
      fail("MiniMax returned no audio payload"); // stream closed before any audio fragment
      return;
    }
    playback.end();
    if (session.subtitleFile !== null) {
      void this.scheduleWords(session.subtitleFile, speakId, stream, playback, true);
    }
    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  /** Pump the chunked body: parse incremental JSON objects, append hex
   * audio, collect the signed subtitle URL. Returns true when the speak is
   * already terminal (failed or cancelled) and runStreamed must exit. */
  private async consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    speakId: number,
    stream: EventStream<EngineEvent>,
    session: { playback: ProgressivePlayback | null; subtitleFile: string | null },
    playProgressive: (mime: string) => ProgressivePlayback,
    fail: (message: string) => void,
  ): Promise<boolean> {
    const splitter = new JsonStreamObjects();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.isCurrent(speakId)) {
          void reader.cancel().catch(() => {});
          return true;
        }
        for (const obj of splitter.push(decoder.decode(value, { stream: true }))) {
          if (this.absorbStreamObject(obj, speakId, stream, session, playProgressive, fail)) {
            void reader.cancel().catch(() => {});
            return true;
          }
        }
      }
      decoder.decode(); // flush a multi-byte tail split across chunks
    } catch (err) {
      if (!this.isCurrent(speakId)) return true; // aborted by cancel/preempt
      session.playback?.stop();
      fail(`MiniMax stream failed: ${String(err)}`);
      return true;
    }
    return false;
  }

  /** Handle one streamed JSON envelope; returns true when terminal. */
  private absorbStreamObject(
    obj: unknown,
    speakId: number,
    stream: EventStream<EngineEvent>,
    session: { playback: ProgressivePlayback | null; subtitleFile: string | null },
    playProgressive: (mime: string) => ProgressivePlayback,
    fail: (message: string) => void,
  ): boolean {
    const env = obj as MiniMaxEnvelope;
    const code = env.base_resp?.status_code;
    if (typeof code === "number" && code !== 0) {
      session.playback?.stop();
      fail(env.base_resp?.status_msg ?? `MiniMax error ${code}`);
      return true;
    }
    const sub = env.data?.subtitle_file;
    if (session.subtitleFile === null && typeof sub === "string") session.subtitleFile = sub;

    const hex = env.data?.audio;
    if (typeof hex !== "string" || hex.length === 0) return false;
    let pb = session.playback;
    if (!pb) {
      // First fragment: open playback + push start (batch parity — start
      // only fires once the payload is known to be valid).
      pb = playProgressive("audio/mpeg");
      session.playback = pb;
      if (!this.isCurrent(speakId)) {
        pb.stop();
        return true;
      }
      if (this.active?.speakId === speakId) this.active.playback = pb;
      stream.push({ type: "start", speakId });
    }
    pb.append(hexToBytes(hex));
    return false;
  }

/** Fetch the subtitle file and ship the chunk's word timeline once.
 * `deferToPlaying` (streaming path only): the progressive media clock reads
 * 0 while the SourceBuffer starves, so wait for it to actually move before
 * anchoring the timeline on it. */
  private async scheduleWords(
    subtitleUrl: unknown,
    speakId: number,
    stream: EventStream<EngineEvent>,
    playback: Playback,
    deferToPlaying = false,
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

    let anchorClock = playback.clockMs?.() ?? 0;
    if (deferToPlaying) {
      const playing = await this.firstPlayingClock(playback);
      if (playing === null) return; // playback finished/failed before any audio sounded
      anchorClock = playing;
    }
    stream.push({
      type: "timeline",
      speakId,
      words: timeline,
      anchorWall: Date.now(),
      anchorClock,
    });
  }

  /** First media-clock reading past zero — audio actually audible — or
   * null if playback finished first. 50ms poll is fine for an anchor: the
   * march re-syncs via live clock polls anyway. */
  private async firstPlayingClock(playback: Playback): Promise<number | null> {
    let over = false;
    void playback.done.then(() => { over = true; });
    for (;;) {
      const ms = playback.clockMs?.() ?? 0;
      if (ms > 0) return ms;
      if (over) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
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

/**
 * Incremental scanner for the stream:true body: complete top-level JSON
 * objects pulled out of a chunked text stream (MiniMax emits them back to
 * back, no delimiters, and network chunks don't respect object bounds).
 * String/escape-aware, so braces inside JSON strings don't confuse it.
 */
class JsonStreamObjects {
  private buf = "";

  /** Feed new text; returns every object completed by it. */
  push(text: string): unknown[] {
    this.buf += text;
    const out: unknown[] = [];
    for (;;) {
      const obj = this.next();
      if (obj === null) return out;
      out.push(obj);
    }
  }

  /** Next complete object, or null while the buffer holds a partial one. */
  private next(): unknown {
    const open = this.buf.indexOf("{");
    if (open < 0) {
      this.buf = ""; // leading junk/whitespace before any object
      return null;
    }
    this.buf = this.buf.slice(open);
    let depth = 0;
    let j = 0;
    while (j < this.buf.length) {
      const ch = this.buf[j];
      if (ch === '"') {
        j = this.skipString(j);
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const text = this.buf.slice(0, j + 1);
          this.buf = this.buf.slice(j + 1);
          return JSON.parse(text) as unknown;
        }
      }
      j += 1;
    }
    return null; // object still incomplete — wait for more text
  }

  /** Index just past the closing quote of the string opening at `open`. */
  private skipString(open: number): number {
    for (let i = open + 1; i < this.buf.length; i += 1) {
      if (this.buf[i] === "\\") {
        i += 1; // skip the escaped char
        continue;
      }
      if (this.buf[i] === '"') return i + 1;
    }
    return this.buf.length; // unterminated — rescan when more text arrives
  }
}