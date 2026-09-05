// SPDX-License-Identifier: MPL-2.0
/**
 * Direct tests for the kitten synthesis worker (src/audio/kitten/worker.ts)
 * — previously 0%. The worker module is imported for its `self.onmessage`
 * handler; tests dispatch messages into it and read `self.postMessage`
 * replies. onnxruntime-web, phonemizer, and the IndexedDB store are mocked
 * (fakes + call records); fetch is stubbed per test for the asset-fallback
 * paths. Module state (the ORT session / vocab / voices cache and the
 * serialization chain) resets via vi.resetModules + fresh import per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KITTEN_ASSETS } from "../src/audio/kitten/assets";
import type { KittenWorkerRequest } from "../src/audio/kitten/protocol";

const ortState = vi.hoisted(() => ({
  create: null as null | ((bytes: ArrayBuffer, opts: unknown) => Promise<unknown>),
  createCalls: [] as Array<{ bytes: ArrayBuffer; opts: unknown }>,
  run: null as null | ((feed: Record<string, unknown>) => Promise<unknown>),
  tensors: [] as Array<{ type: string; data: unknown; dims: number[] }>,
}));

const idbState = vi.hoisted(() => ({
  records: new Map<string, ArrayBuffer[]>(),
  gets: [] as string[],
  puts: [] as Array<{ url: string; byteLength: number; bytes: ArrayBuffer }>,
  deletes: [] as string[],
}));

vi.mock("onnxruntime-web/wasm", () => ({
  env: { wasm: {} },
  Tensor: class {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
      ortState.tensors.push(this);
    }
  },
  InferenceSession: {
    create: (bytes: ArrayBuffer, opts: unknown) => {
      ortState.createCalls.push({ bytes, opts });
      return ortState.create!(bytes, opts);
    },
    // `run` is read off the session instance created by `create` (stubbed below).
  },
}));

vi.mock("phonemizer", () => ({
  phonemize: async (text: string) => [text],
}));

vi.mock("../src/audio/kitten/idb", () => ({
  idbGetRecords: async (url: string) => {
    idbState.gets.push(url);
    return idbState.records.get(url) ?? [];
  },
  idbPutAsset: async (url: string, byteLength: number, bytes: ArrayBuffer) => {
    idbState.puts.push({ url, byteLength, bytes });
  },
  idbDeleteAsset: async (url: string) => {
    idbState.deletes.push(url);
  },
}));

type Reply = Record<string, unknown> & { type: string };
let replies: Reply[];
let transfers: Transferable[][];
const MODEL_BYTES = new Uint8Array(10_000_001).buffer;
const VOICES_JSON = JSON.stringify({ "expr-voice-2-f": [[0.1, 0.2, 0.3]] });
const TOKENIZER_JSON = JSON.stringify({ model: { vocab: { h: 1, ə: 2, l: 3, oʊ: 4 } } });
const jsonBytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

const sessionStub = (inputNames: string[]): unknown => ({
  inputNames,
  run: (feed: Record<string, unknown>) => ortState.run!(feed),
});

let posted: unknown;
void posted;

type WorkerModule = typeof import("../src/audio/kitten/worker");

const load = async (): Promise<WorkerModule> => {
  vi.resetModules();
  return import("../src/audio/kitten/worker");
};

const dispatch = (msg: KittenWorkerRequest): void => {
  (globalThis as unknown as { onmessage: ((ev: { data: KittenWorkerRequest }) => void) | null }).onmessage?.({
    data: msg,
  });
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  ortState.create = async (_bytes, opts) => sessionStub(String((opts as { executionProviders?: string[] }).executionProviders?.[0]) === "wasm" ? ["input_ids", "style", "speed"] : []);
  ortState.createCalls = [];
  ortState.run = async () => ({ audio: { data: Float32Array.of(0.25, -0.25) } });
  ortState.tensors = [];
  idbState.records = new Map([
    [KITTEN_ASSETS.model.url, [MODEL_BYTES]],
    [KITTEN_ASSETS.voices.url, [jsonBytes(VOICES_JSON)]],
    [KITTEN_ASSETS.tokenizer.url, [jsonBytes(TOKENIZER_JSON)]],
  ]);
  idbState.gets = [];
  idbState.puts = [];
  idbState.deletes = [];
  replies = [];
  transfers = [];
  posted = undefined;
  vi.stubGlobal("postMessage", (msg: Reply, opts?: { transfer?: Transferable[] }) => {
    posted = msg;
    replies.push(msg);
    transfers.push(opts?.transfer ?? []);
  });
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in this test");
  });
  await load();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const readyReplies = (): Reply[] => replies.filter((r) => r.type === "ready");
const errorReplies = (): Reply[] => replies.filter((r) => r.type === "error");

describe("kitten worker: init handshake", () => {
  it("replies ready with the session's input names", async () => {
    dispatch({ type: "init" });
    await tick();
    expect(readyReplies()).toEqual([{ type: "ready", inputNames: ["input_ids", "style", "speed"] }]);
    expect(ortState.createCalls).toEqual([{ bytes: MODEL_BYTES, opts: { executionProviders: ["wasm"] } }]);
  });

  it("caches the session: a second init does not re-create or refetch", async () => {
    dispatch({ type: "init" });
    await tick();
    dispatch({ type: "init" });
    await tick();
    expect(readyReplies()).toHaveLength(2);
    expect(idbState.gets).toHaveLength(3); // model + voices + tokenizer, once
    expect(ortState.createCalls).toHaveLength(1);
  });

  it("reports asset unavailability as an error reply", async () => {
    idbState.records.clear();
    dispatch({ type: "init" });
    await tick();
    const err = errorReplies()[0];
    expect(err.type).toBe("error");
    expect(err.reqId).toBeUndefined();
    expect(String(err.message)).toContain("asset unavailable");
  });
});

describe("kitten worker: asset pipeline (empty/corrupt cache → fetch → cache)", () => {
  beforeEach(() => {
    idbState.records.clear(); // force the network path for every asset
  });

  it("falls through !ok responses to the fallback URL and stores the fetched bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.endsWith("voices.json") ? VOICES_JSON : u.endsWith("tokenizer.json") ? TOKENIZER_JSON : null;
      if (body === null && !u.endsWith("model_quantized.onnx")) throw new Error(`unexpected ${u}`);
      const primary = u === KITTEN_ASSETS.model.url || u === KITTEN_ASSETS.voices.url || u === KITTEN_ASSETS.tokenizer.url;
      if (primary) return { ok: false } as unknown as Response; // pinned URL 500s
      const bytes2 = u.endsWith("model_quantized.onnx")
        ? MODEL_BYTES
        : jsonBytes(body!);
      return { ok: true, arrayBuffer: async () => bytes2 } as unknown as Response;
    }));
    dispatch({ type: "init" });
    await tick();
    expect(readyReplies()).toHaveLength(1);
    expect(idbState.deletes).toEqual([KITTEN_ASSETS.model.url, KITTEN_ASSETS.voices.url, KITTEN_ASSETS.tokenizer.url]);
    const puts = new Map(idbState.puts.map((p) => [p.url, p]));
    expect(puts.get(KITTEN_ASSETS.model.url)).toMatchObject({ byteLength: MODEL_BYTES.byteLength });
    expect(new TextDecoder().decode(puts.get(KITTEN_ASSETS.voices.url)!.bytes)).toBe(VOICES_JSON);
  });

  it("drops a corrupted cache record and refetches (validation rejects short model payloads)", async () => {
    idbState.records = new Map([
      [KITTEN_ASSETS.model.url, [new Uint8Array(1000).buffer]], // below the corruption floor
      [KITTEN_ASSETS.voices.url, [jsonBytes(VOICES_JSON)]],
      [KITTEN_ASSETS.tokenizer.url, [jsonBytes(TOKENIZER_JSON)]],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("model_quantized.onnx")) {
        return { ok: true, arrayBuffer: async () => MODEL_BYTES } as unknown as Response;
      }
      throw new Error(`unexpected ${url}`);
    }));
    dispatch({ type: "init" });
    await tick();
    expect(readyReplies()).toHaveLength(1);
    expect(idbState.deletes).toEqual([KITTEN_ASSETS.model.url]);
    expect(idbState.puts).toHaveLength(1);
  });

  it("skips fetched payloads that fail validation and tries the next URL", async () => {
    idbState.records.clear();
    let modelFetches = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("model_quantized.onnx")) {
        modelFetches += 1;
        // First response (pinned URL) delivers a too-short model → invalid.
        return {
          ok: true,
          arrayBuffer: async () => (modelFetches === 1 ? new Uint8Array(50).buffer : MODEL_BYTES),
        } as unknown as Response;
      }
      if (u.endsWith("voices.json")) return { ok: true, arrayBuffer: async () => jsonBytes(VOICES_JSON) } as unknown as Response;
      if (u.endsWith("tokenizer.json")) return { ok: true, arrayBuffer: async () => jsonBytes(TOKENIZER_JSON) } as unknown as Response;
      throw new Error(`unexpected ${u}`);
    }));
    dispatch({ type: "init" });
    await tick();
    expect(readyReplies()).toHaveLength(1);
    expect(modelFetches).toBe(2); // pinned rejected, HF fallback accepted
  });

  it("survives a rejecting fetch and reports unavailability when every URL fails", async () => {
    idbState.records.clear();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("conn reset"); // exercised catch → next URL
      return { ok: false } as unknown as Response;
    }));
    dispatch({ type: "init" });
    await tick();
    const err = errorReplies()[0];
    expect(String(err.message)).toContain("asset unavailable");
  });
});

describe("kitten worker: synthesis", () => {
  beforeEach(async () => {
    dispatch({ type: "init" });
    await tick();
    replies = [];
    transfers = [];
  });

  it("synthesizes: phonemes → tokens → ORT run → Float32 reply with a transferred copy", async () => {
    dispatch({ type: "synth", reqId: 1, text: "həloʊ", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    await tick(); // the tail chain (init → synth) settles over two macrotasks
    expect(replies).toEqual([
      { type: "audio", reqId: 1, audio: expect.any(ArrayBuffer) },
    ]);
    const audio = replies[0].audio as ArrayBuffer;
    expect(new Float32Array(audio)).toEqual(Float32Array.of(0.25, -0.25));
    expect(transfers[0]).toEqual([audio]); // the copy is transferred, not the original
  });

  it("feeds input_ids/styles/speed tensors shaped per the graph declaration", async () => {
    let captured: Record<string, unknown> | null = null;
    ortState.run = async (feed) => {
      captured = feed;
      return { audio: { data: Float32Array.of(1) } };
    };
    dispatch({ type: "synth", reqId: 2, text: "həloʊ", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    const f = captured!;
    const ids = f["input_ids"] as { type: string; dims: number[]; data: ArrayLike<bigint> };
    expect(ids.type).toBe("int64");
    expect(ids.dims).toEqual([1, 6]); // 0 + h ə l oʊ + 0 (even padding)
    expect(Array.from(ids.data)).toEqual([0n, 1n, 2n, 3n, 4n, 0n]);
    const style = f["style"] as { type: string; dims: number[]; data: ArrayLike<number> };
    expect(style.type).toBe("float32");
    expect(style.dims).toEqual([1, 3]);
    // Float32 precision: 0.1/0.2/0.3 are not exact in binary.
    expect(Array.from(style.data).map((v) => Math.round(v * 100) / 100)).toEqual([0.1, 0.2, 0.3]);
    const speed = f["speed"] as { dims: number[]; data: ArrayLike<number> };
    expect(speed.dims).toEqual([1]); // rank-1 speed vector (live ORT rank error)
    // Unmatched input names get no tensor.
    expect(f["nonexistent"]).toBeUndefined();
  });

  it("clamps speed into the model range [0.5, 2]", async () => {
    let captured: Record<string, unknown> | null = null;
    ortState.run = async (feed) => {
      captured = feed;
      return { audio: { data: Float32Array.of(1) } };
    };
    dispatch({ type: "synth", reqId: 1, text: "h", voice: "expr-voice-2-f", speed: 0.1 });
    await tick();
    await tick();
    expect(Array.from((captured!["speed"] as { data: Float32Array }).data)).toEqual([0.5]);

    dispatch({ type: "synth", reqId: 2, text: "h", voice: "expr-voice-2-f", speed: 9 });
    await tick();
    await tick();
    expect(Array.from((captured!["speed"] as { data: Float32Array }).data)).toEqual([2]);
  });

  it("rejects synthesis before init (worker not initialized)", async () => {
    await load(); // fresh module: no init yet
    dispatch({ type: "synth", reqId: 9, text: "h", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    await tick();
    expect(errorReplies()).toEqual([{ type: "error", reqId: 9, message: expect.stringContaining("not initialized") }]);
  });

  it("reports an unknown voice", async () => {
    dispatch({ type: "synth", reqId: 3, text: "h", voice: "nope", speed: 1 });
    await tick();
    await tick();
    expect(errorReplies()).toEqual([
      { type: "error", reqId: 3, message: expect.stringContaining("voice not found in voices.json: nope") },
    ]);
  });

  it("reports an empty or non-float model output as no audio", async () => {
    ortState.run = async () => ({ audio: { data: new Float32Array(0) } });
    dispatch({ type: "synth", reqId: 1, text: "h", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    await tick();
    expect(errorReplies()[0].message).toContain("produced no audio");

    ortState.run = async () => ({ audio: { data: "not float32" } });
    dispatch({ type: "synth", reqId: 2, text: "h", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    await tick();
    expect(errorReplies()[1].message).toContain("produced no audio");
  });

  it("serializes: a synth sent before init still runs after the init completes", async () => {
    await load(); // fresh module
    dispatch({ type: "init" });
    dispatch({ type: "synth", reqId: 1, text: "h", voice: "expr-voice-2-f", speed: 1 });
    await tick();
    await tick();
    // Init reply first, then the queued synth — one inference at a time.
    expect(replies.map((r) => r.type)).toEqual(["ready", "audio"]);
  });

  it("ignores unknown message types without replying", async () => {
    dispatch({ type: "mystery" } as unknown as KittenWorkerRequest);
    await tick();
    expect(replies).toEqual([]);
  });
});
