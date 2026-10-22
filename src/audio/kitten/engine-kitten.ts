// SPDX-License-Identifier: MPL-2.0
/**
 * KittenEngine (kitten-local family, ticket 06): zero-install on-device TTS.
 * ONNX Runtime Web (WASM) + phonemizer run inside a dedicated Worker so the
 * audio-owner context (Chrome offscreen doc / Firefox event page) stays
 * message-responsive during inference; this class is a thin RPC wrapper in
 * the exact gemini-engine shape (EventStream bridging, preempt/cancel/isCurrent,
 * audioHost.play) — inference arrives as Float32 PCM, gets wrapped in a WAV
 * header (gemini's pcmToWav, 24 kHz), and plays as audio/wav.
 *
 * First-use disclosure: the ~25 MB model download happens inside the worker
 * on the first speak/preview (IndexedDB-cached afterwards); the popup shows
 * a family hint (FAMILY_HINTS) so the download is never discovered by
 * silence. The worker is lazy: getVoices() is static and costs nothing.
 *
 * Implements prefetch() (pipelining, ADR-0003 — ElevenLabs pattern): a
 * single-entry cache of the finished WAV — the latest prefetch wins — that a
 * later speak() with identical text+options plays without touching the
 * worker; a mismatching speak() or cancel() discards it. On-device inference
 * is the slow path (0.5–3 s per sentence), so pipelining hides the
 * between-chunks gap. The worker stays one-inference-at-a-time: a prefetch
 * queues behind the active speak's synth and runs during its playback.
 */
import { EventStream } from "../../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "../engine-minimax";
import { pcmToWav } from "../engine-gemini";
import {
  KITTEN_DEFAULT_VOICE,
  KITTEN_LANG,
  KITTEN_MAX_UTTERANCE_CHARS,
  KITTEN_SAMPLE_RATE,
  KITTEN_VOICE_NAMES,
  float32ToPcm16,
} from "./assets";
import type { KittenWorkerReply, KittenWorkerRequest } from "./protocol";

export const KITTEN_FAMILY = "kitten-local";

export const KITTEN_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "free",
  privacyClass: "local",
  maxUtteranceChars: KITTEN_MAX_UTTERANCE_CHARS,
};

/**
 * Worker URL via the raw platform globals — no polyfill import here so the
 * module (and its tests) load outside extension contexts. Both targets the
 * engine runs in (Chrome offscreen doc, Firefox event page) expose one of
 * the two namespaces.
 */
function defaultWorkerFactory(): Worker {
  const g = globalThis as {
    browser?: { runtime?: { getURL?: (p: string) => string } };
    chrome?: { runtime?: { getURL?: (p: string) => string } };
  };
  const getURL = g.browser?.runtime?.getURL ?? g.chrome?.runtime?.getURL;
  if (!getURL) throw new Error("kitten-local: no extension runtime — engine needs an offscreen/event-page context");
  return new Worker(getURL("audio/kitten/worker.js"));
}

export interface KittenEngineOptions {
  /** Worker seam for tests; default spawns the bundled kitten worker. */
  workerFactory?: () => Worker;
  audioHost?: AudioHost;
}

interface Pending {
  resolve: (samples: Float32Array) => void;
  reject: (err: Error) => void;
}

export class KittenEngine implements TextEngine {
  readonly family = KITTEN_FAMILY;
  readonly capabilities = KITTEN_CAPABILITIES;
  private readonly workerFactory: () => Worker;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;

  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((err: Error) => void) | null = null;
  private reqId = 0;
  private pending = new Map<number, Pending>();
  /** Finished WAV for chunk pipelining (ADR-0003): one entry, latest
   * prefetch wins; cancel() discards it. The key pins text+voice+rate so a
   * mismatching speak() can never serve stale audio. */
  private cache: { cacheKey: string; wav: Uint8Array } | null = null;
  private cacheEpoch = 0;

  constructor(opts: KittenEngineOptions = {}) {
    this.workerFactory = opts.workerFactory ?? defaultWorkerFactory;
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  /** Static: the 8 bundled nano voices — no worker, no download. */
  getVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(
      KITTEN_VOICE_NAMES.map((name) => ({ name, lang: KITTEN_LANG, localService: true, family: this.family })),
    );
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

  /**
   * Synthesize ahead for a FUTURE speak() with identical text+options
   * (pipelining, ADR-0003). Best-effort: a failed synthesis stores nothing
   * and the later speak() synthesizes on demand.
   */
  async prefetch(text: string, options: SpeakOptions): Promise<void> {
    const epoch = this.cacheEpoch;
    try {
      await this.ensureWorker();
      const samples = await this.requestSynth(text, this.voiceName(options), clampRate(options.rate));
      if (this.cacheEpoch !== epoch) return;
      this.cache = { cacheKey: this.cacheKey(text, options), wav: toWav(samples) };
    } catch {
      // best-effort — a later speak() synthesizes on demand
    }
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
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

    const cached = this.cachedFor(text, options);
    if (cached) {
      await this.deliver(cached, speakId, stream, fail);
      return;
    }

    let samples: Float32Array;
    try {
      await this.ensureWorker();
      if (!this.isCurrent(speakId)) return;
      samples = await this.requestSynth(text, this.voiceName(options), clampRate(options.rate));
    } catch (err) {
      if (!this.isCurrent(speakId)) return;
      fail(`kitten-local: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    await this.deliver(toWav(samples), speakId, stream, fail);
  }

  /** Shared playback tail: play a finished WAV, emit start/end, close. */
  private async deliver(
    wav: Uint8Array,
    speakId: number,
    stream: EventStream<EngineEvent>,
    fail: (message: string) => void,
  ): Promise<void> {
    let playback: Playback;
    try {
      playback = this.audioHost.play(wav, "audio/wav");
    } catch (err) {
      // AudioHost failed to start (e.g. no Audio element) — contract says the
      // stream must still terminate with an error event.
      fail(`kitten-local: audio playback failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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

  /** Spawn (or reuse) the worker and wait for its init handshake. */
  private ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return this.ready;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener("message", (ev: MessageEvent<KittenWorkerReply>) => this.onReply(ev.data));
    worker.addEventListener("error", () => this.onWorkerCrash());
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.post({ type: "init" });
    return this.ready;
  }

  private requestSynth(text: string, voice: string, speed: number): Promise<Float32Array> {
    const reqId = ++this.reqId;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.post({ type: "synth", reqId, text, voice, speed });
    });
  }

  private post(msg: KittenWorkerRequest): void {
    this.worker?.postMessage(msg);
  }

  private onReply(reply: KittenWorkerReply): void {
    if (reply.type === "ready") {
      this.resolveReady?.();
      return;
    }
    if (reply.type === "error" && reply.reqId === undefined) {
      // Init failure: drop the worker so the next speak starts fresh.
      this.rejectReady?.(new Error(reply.message));
      this.resetWorker();
      return;
    }
    if (reply.type === "audio") {
      this.pending.get(reply.reqId)?.resolve(new Float32Array(reply.audio));
      this.pending.delete(reply.reqId);
      return;
    }
    if (reply.type === "error" && typeof reply.reqId === "number") {
      this.pending.get(reply.reqId)?.reject(new Error(reply.message));
      this.pending.delete(reply.reqId);
    }
  }

  private onWorkerCrash(): void {
    for (const p of this.pending.values()) p.reject(new Error("kitten worker crashed"));
    this.pending.clear();
    this.rejectReady?.(new Error("kitten worker crashed"));
    this.resetWorker();
  }

  private resetWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private voiceName(options: SpeakOptions): string {
    return options.voiceName ?? KITTEN_DEFAULT_VOICE;
  }

  private cacheKey(text: string, options: SpeakOptions): string {
    return `${text}|${this.voiceName(options)}|${clampRate(options.rate)}`;
  }

  /**
   * Serve the pipelining cache when text+options match (ElevenLabs pattern).
   * A mismatching speak() discards the entry (ADR-0003 — latest prefetch
   * wins; nothing stale survives to a later speak). A matching speak()
   * keeps it: the next prefetch overwrites it and cancel() clears it.
   */
  private cachedFor(text: string, options: SpeakOptions): Uint8Array | null {
    const entry = this.cache;
    if (!entry) return null;
    const match = entry.cacheKey === this.cacheKey(text, options);
    if (!match) this.cache = null;
    return match ? entry.wav : null;
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

function toWav(samples: Float32Array): Uint8Array {
  return pcmToWav(float32ToPcm16(samples), KITTEN_SAMPLE_RATE);
}

function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}
