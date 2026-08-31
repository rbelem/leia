// SPDX-License-Identifier: MPL-2.0
/**
 * kitten-local engine tests (ticket 06). Real ONNX inference is not unit-test
 * territory (manual smoke: `leia:probe-kitten`) — covered here are the pure
 * halves (voice mapping, Float32→PCM16→WAV encoding, cache keys/validation,
 * phoneme encoding) and the engine's contract behavior against a scripted
 * worker double: start/end delivery, preemption, cancel, init/synth failures,
 * stale-result discard.
 */
import { describe, expect, it, vi } from "vitest";
import {
  KITTEN_ASSETS,
  KITTEN_LANG,
  KITTEN_SAMPLE_RATE,
  KITTEN_VOICE_NAMES,
  cacheKey,
  cacheRange,
  float32ToPcm16,
  readTokenizerVocab,
  resolveVoiceEmbedding,
  validateAsset,
} from "../src/audio/kitten/assets";
import { KITTEN_CAPABILITIES } from "../src/audio/kitten/engine-kitten";
import { encodePhonemes, kittenInputIds } from "../src/audio/kitten/phoneme-tokens";
import { KittenEngine } from "../src/audio/kitten/engine-kitten";
import type { KittenWorkerReply, KittenWorkerRequest } from "../src/audio/kitten/protocol";
import { pcmToWav } from "../src/audio/engine-gemini";
import { collect, tick } from "./fakes";

// jsdom has no IndexedDB — stub the one IDBKeyRange shape cacheRange uses.
vi.stubGlobal("IDBKeyRange", {
  bound: (lo: string, hi: string) => ({ lower: lo, upper: hi, includes: (k: string) => k >= lo && k <= hi }),
});

// --- pure halves -----------------------------------------------------------

describe("kitten voice mapping", () => {
  it("exposes the 8 nano voices as local voices of the kitten-local family", async () => {
    const engine = new KittenEngine({ workerFactory: () => null as unknown as Worker });
    const voices = await engine.getVoices();
    expect(voices.map((v) => v.name)).toEqual([...KITTEN_VOICE_NAMES]);
    for (const v of voices) {
      expect(v.lang).toBe(KITTEN_LANG);
      expect(v.localService).toBe(true);
      expect(v.family).toBe("kitten-local");
    }
  });

  it("declares free/local, no word timing, 1000-char utterance cap", () => {
    expect(KITTEN_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
      maxUtteranceChars: 1000,
    });
  });

  it("resolves voice embeddings case-insensitively", () => {
    const json = { Bella: [1, 2], luna: [3, 4] };
    expect(Array.from(resolveVoiceEmbedding(json, "Bella")!)).toEqual([1, 2]);
    expect(Array.from(resolveVoiceEmbedding(json, "Luna")!)).toEqual([3, 4]);
    expect(resolveVoiceEmbedding(json, "nope")).toBeNull();
  });

  it("reads the flat vocab out of tokenizer.json shapes", () => {
    expect(readTokenizerVocab({ model: { vocab: { a: 1 } } })).toEqual({ a: 1 });
    expect(readTokenizerVocab({ vocab: { b: 2 } })).toEqual({ b: 2 });
    expect(() => readTokenizerVocab({})).toThrow(/vocab/);
  });
});

describe("kitten WAV encoding", () => {
  it("converts Float32 [-1,1] to clamped 16-bit LE PCM", () => {
    const pcm = float32ToPcm16(Float32Array.of(0, 1, -1, 0.5, 2, -2));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff); // +1 clamps to max
    expect(view.getInt16(4, true)).toBe(-0x8000); // -1 clamps to min
    expect(view.getInt16(6, true)).toBe(Math.trunc(0.5 * 0x7fff)); // setInt16 truncates
    expect(view.getInt16(8, true)).toBe(0x7fff);
    expect(view.getInt16(10, true)).toBe(-0x8000);
  });

  it("wraps samples in a 24 kHz mono WAV header (gemini pcmToWav path)", () => {
    const wav = pcmToWav(float32ToPcm16(Float32Array.of(0.25, -0.25)), KITTEN_SAMPLE_RATE);
    const text = String.fromCharCode(...wav.slice(0, 4));
    expect(text).toBe("RIFF");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(24_000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(wav.byteLength).toBe(44 + 4);
  });
});

describe("kitten cache keying + validation", () => {
  it("keys records by URL + byte length and ranges over them", () => {
    expect(cacheKey(KITTEN_ASSETS.model.url, 24_000_000)).toBe(`${KITTEN_ASSETS.model.url}#24000000`);
    const range = cacheRange(KITTEN_ASSETS.model.url);
    expect(range.includes(cacheKey(KITTEN_ASSETS.model.url, 1))).toBe(true);
    expect(range.includes(cacheKey(`${KITTEN_ASSETS.model.url}x`, 1))).toBe(false);
  });

  it("accepts parseable JSON, rejects truncated/malformed payloads", () => {
    const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(validateAsset("json", bytes('{"a":1}'))).toBe(true);
    expect(validateAsset("json", bytes('{"a":'))).toBe(false);
    expect(validateAsset("json", new Uint8Array(0))).toBe(false);
  });

  it("rejects model payloads below the corruption floor", () => {
    expect(validateAsset("model", new Uint8Array(10_000_000))).toBe(true);
    expect(validateAsset("model", new Uint8Array(1_000))).toBe(false);
  });

  it("pins the demo asset URLs with HF resolve fallbacks", () => {
    expect(KITTEN_ASSETS.model.url).toBe(
      "https://raw.githubusercontent.com/clowerweb/kitten-tts-web-demo/main/public/tts-model/model_quantized.onnx",
    );
    expect(KITTEN_ASSETS.model.fallbacks[0]).toContain("huggingface.co/KittenML/kitten-tts-nano-0.1/resolve/main");
    for (const spec of Object.values(KITTEN_ASSETS)) expect(spec.fallbacks.length).toBe(1);
  });
});

describe("kitten phoneme encoding", () => {
  it("greedy longest-match encodes and skips unknown symbols", () => {
    const vocab = { abc: 1, a: 2, b: 3, c: 4 };
    expect(encodePhonemes(vocab, "abc")).toEqual([1]); // longest match wins
    expect(encodePhonemes(vocab, "ab")).toEqual([2, 3]);
    expect(encodePhonemes(vocab, "axb")).toEqual([2, 3]); // x skipped
    expect(encodePhonemes(vocab, "")).toEqual([]);
  });

  it("pads ids with 0 at both ends and keeps the length even", () => {
    expect(Array.from(kittenInputIds([5, 6]))).toEqual([0n, 5n, 6n, 0n]);
    // 0 + 1 id + 0 = odd → extra pad
    expect(Array.from(kittenInputIds([7]))).toEqual([0n, 7n, 0n, 0n]);
  });
});

// --- engine contract behavior (scripted worker double) ----------------------

/** Minimal Worker double: records requests, replies are driven by the test. */
class FakeKittenWorker {
  sent: KittenWorkerRequest[] = [];
  private messageListener: ((ev: MessageEvent<KittenWorkerReply>) => void) | null = null;
  private errorListener: (() => void) | null = null;

  constructor(private onSpawn?: (w: FakeKittenWorker) => void) {
    this.onSpawn?.(this);
  }

  addEventListener(type: "message" | "error", fn: never): void {
    if (type === "message") this.messageListener = fn as (ev: MessageEvent<KittenWorkerReply>) => void;
    if (type === "error") this.errorListener = fn as () => void;
  }
  postMessage(msg: KittenWorkerRequest): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  reply(reply: KittenWorkerReply): void {
    this.messageListener?.({ data: reply } as MessageEvent<KittenWorkerReply>);
  }
  crash(): void {
    this.errorListener?.();
  }
}

interface Harness {
  engine: KittenEngine;
  spawned: FakeKittenWorker[];
  /** Latest spawned worker (shorthand). */
  worker(): FakeKittenWorker;
  playCalls: Array<{ bytes: Uint8Array; mime: string }>;
}

function makeHarness(opts?: { failAudioHost?: boolean }): Harness {
  const spawned: FakeKittenWorker[] = [];
  const playCalls: Array<{ bytes: Uint8Array; mime: string }> = [];
  const engine = new KittenEngine({
    workerFactory: () => new FakeKittenWorker((w) => spawned.push(w)) as unknown as Worker,
    audioHost: {
      play(bytes: Uint8Array, mime: string) {
        if (opts?.failAudioHost) throw new Error("audio host down");
        playCalls.push({ bytes, mime });
        return { stop: () => {}, done: Promise.resolve() };
      },
    },
  });
  return { engine, spawned, worker: () => spawned[spawned.length - 1], playCalls };
}

/** Drive a speak() through init + synth with the given samples. */
async function speakThrough(h: Harness, text: string, speakId: number, samples: number[]): Promise<unknown[]> {
  const iter = h.engine.speak(text, speakId, { voiceName: "Luna", rate: 1 });
  const done = collect(iter);
  await tick();
  expect(h.worker().sent[0].type).toBe("init");
  h.worker().reply({ type: "ready", inputNames: ["input_ids", "styles", "speed"] });
  await tick();
  h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.from(samples).buffer });
  return done;
}

describe("KittenEngine contract behavior", () => {
  it("speaks a chunk: init → synth → start → end, and plays 24 kHz WAV", async () => {
    const h = makeHarness();
    const events = await speakThrough(h, "hello", 1, [0, 0.5, -0.5]);
    expect(events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
    expect(h.playCalls).toHaveLength(1);
    const { bytes, mime } = h.playCalls[0];
    expect(mime).toBe("audio/wav");
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(KITTEN_SAMPLE_RATE);
    // Synth request carries text, resolved voice and clamped speed.
    const synth = h.worker().sent[1];
    expect(synth).toMatchObject({ type: "synth", reqId: 1, text: "hello", voice: "Luna", speed: 1 });
  });

  it("defaults to the first nano voice and clamps rate into the model range", async () => {
    const h = makeHarness();
    const iter = h.engine.speak("x", 1, { voiceName: null, rate: 9 });
    const done = collect(iter);
    await tick();
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    await done;
    expect(h.worker().sent[1]).toMatchObject({ voice: "Bella", speed: 2 });
  });

  it("preempts: a newer speak cancels the older stream and playback", async () => {
    const h = makeHarness();
    const first = collect(h.engine.speak("one", 1, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();

    const second = collect(h.engine.speak("two", 2, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer }); // stale (reqId 1)
    await tick();
    h.worker().reply({ type: "audio", reqId: 2, audio: Float32Array.of(0).buffer });
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(await second).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
    // Exactly one playback survived: the second chunk's.
    expect(h.playCalls).toHaveLength(1);
  });

  it("cancel() mid-synthesis yields cancelled and discards the late audio", async () => {
    const h = makeHarness();
    const events = collect(h.engine.speak("slow", 7, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.engine.cancel();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer }); // arrives after cancel
    expect(await events).toEqual([{ type: "cancelled", speakId: 7 }]);
    expect(h.playCalls).toHaveLength(0);
  });

  it("surfaces init failure as an error event and respawns a fresh worker next speak", async () => {
    const h = makeHarness();
    const events = collect(h.engine.speak("x", 1, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().reply({ type: "error", message: "kitten asset unavailable: http://model" });
    expect(await events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("asset unavailable") }]);
    expect(h.spawned).toHaveLength(1);

    // Next speak gets a new worker and retries init. The failed speak never
    // reached requestSynth, so the retry's synth is reqId 1.
    const retry = collect(h.engine.speak("x", 2, { voiceName: null, rate: 1 }));
    await tick();
    expect(h.spawned).toHaveLength(2);
    expect(h.worker().sent[0].type).toBe("init");
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    expect(await retry).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("surfaces synth failure as an error event", async () => {
    const h = makeHarness();
    const events = collect(h.engine.speak("x", 1, { voiceName: "Nope", rate: 1 }));
    await tick();
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.worker().reply({ type: "error", reqId: 1, message: "kitten voice not found in voices.json: Nope" });
    expect(await events).toEqual([
      { type: "error", speakId: 1, message: expect.stringContaining("voice not found") },
    ]);
    expect(h.playCalls).toHaveLength(0);
  });

  it("recovers after a worker crash (next speak respawns)", async () => {
    const h = makeHarness();
    const events = collect(h.engine.speak("x", 1, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().crash();
    expect(await events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("crashed") }]);
    expect(h.spawned).toHaveLength(1);
    const retry = collect(h.engine.speak("x", 2, { voiceName: null, rate: 1 }));
    await tick();
    expect(h.spawned).toHaveLength(2);
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    expect(await retry).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("reports an audio-host failure as an error event", async () => {
    const h = makeHarness({ failAudioHost: true });
    const events = collect(h.engine.speak("x", 1, { voiceName: null, rate: 1 }));
    await tick();
    h.worker().reply({ type: "ready", inputNames: [] });
    await tick();
    h.worker().reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    expect(await events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("audio host down") }]);
  });
});
