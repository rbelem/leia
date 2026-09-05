// SPDX-License-Identifier: MPL-2.0
// Race-matrix coverage for cancel()/preempt() landing mid-flight in the
// OpenAI and MiniMax engines. Stubs are self-contained copies:
//   collect/jsonResponse/mp3Response/StubPlayback/StubHost/makeHost/
//   deferred/MP3_BYTES — tests/engine-openai.test.ts L15-93
//   StubProgressive/makeProgressiveHost/gateableResponse —
//   tests/engine-minimax.test.ts L103-167
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_TTS_URL, OpenAIEngine } from "../src/audio/engine-openai";
import {
  MINIMAX_TTS_URL,
  MiniMaxEngine,
  type AudioHost,
  type Playback,
  type ProgressivePlayback,
} from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

function mp3Response(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "audio/mpeg" : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

/** Response whose headers resolved but whose body read is still pending. */
function heldBodyResponse(bufGate: { promise: Promise<ArrayBuffer> }): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "audio/mpeg" : null) },
    arrayBuffer: () => bufGate.promise,
  } as unknown as Response;
}

interface StubPlayback extends Playback {
  stopCalls: number;
  finish(): void;
}

interface StubHost {
  played: Array<{ bytes: Uint8Array; mime: string }>;
  playbacks: StubPlayback[];
  play(bytes: Uint8Array, mime: string): StubPlayback;
}

function makeHost(): StubHost {
  const played: StubHost["played"] = [];
  const playbacks: StubPlayback[] = [];
  return {
    played,
    playbacks,
    play(bytes: Uint8Array, mime: string): StubPlayback {
      played.push({ bytes, mime });
      let resolveDone!: () => void;
      const pb: StubPlayback = {
        stopCalls: 0,
        done: new Promise((r) => (resolveDone = r)),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        finish: () => resolveDone(),
      };
      playbacks.push(pb);
      return pb;
    },
  };
}

function makeFetch(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return h(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33]);
const mp3Buffer = (): ArrayBuffer =>
  MP3_BYTES.buffer.slice(MP3_BYTES.byteOffset, MP3_BYTES.byteOffset + MP3_BYTES.byteLength) as ArrayBuffer;

// --- streaming (progressive host) harness (from engine-minimax.test.ts) ---

interface StubProgressive extends ProgressivePlayback {
  stopCalls: number;
  endCalls: number;
  appended: Uint8Array[];
  finish(): void;
  /** Media-clock test hook: sets the clock read at timeline-push time. */
  clockTo(ms: number): void;
}

function makeProgressiveHost(): { host: AudioHost; playbacks: StubProgressive[] } {
  const playbacks: StubProgressive[] = [];
  const host: AudioHost = {
    play(): Playback {
      throw new Error("batch play() must not run when playProgressive exists");
    },
    playProgressive(): ProgressivePlayback {
      let resolveDone!: () => void;
      let time = 0;
      const pb: StubProgressive = {
        stopCalls: 0,
        endCalls: 0,
        appended: [],
        done: new Promise<void>((r) => (resolveDone = r)),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        append: (chunk) => {
          pb.appended.push(chunk);
        },
        end: () => {
          pb.endCalls += 1;
        },
        finish: () => resolveDone(),
        clockTo: (ms) => {
          time = ms;
        },
      };
      pb.clockMs = () => time;
      playbacks.push(pb);
      return pb;
    },
  };
  return { host, playbacks };
}

/** Chunked 200 whose body the test feeds chunk by chunk. */
function gateableResponse(): {
  resp: Response;
  enqueue(text: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    resp: { ok: true, body: stream } as unknown as Response,
    enqueue: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

describe("engine race matrix (cancel/preempt mid-flight)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("OpenAI cancel-during-getKey: cancelled event, no fetch ever fires", async () => {
    // getKey gates everything: run() awaits the key, then isCurrent() exits
    // silently — cancel during the pending key produces the cancelled event
    // and the fetch is never reached.
    const keyGate = deferred<string | null>();
    const { fetchImpl, calls } = makeFetch([]); // must never be reached
    const engine = new OpenAIEngine({ getKey: () => keyGate.promise, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Slow key.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // parked awaiting the key gate
    engine.cancel();
    keyGate.resolve("k"); // late key must not trigger a fetch
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("OpenAI cancel-during-arrayBuffer: headers arrived, body never becomes audio", async () => {
    // fetch() resolves, but arrayBuffer() is still pending when cancel()
    // lands: the body resolves into a void — no playback, no start event.
    const bufGate = deferred<ArrayBuffer>();
    const { fetchImpl, calls } = makeFetch([(url) => {
      expect(url).toBe(OPENAI_TTS_URL);
      return heldBodyResponse(bufGate);
    }]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // fetch resolved; body read pending
    expect(calls).toHaveLength(1);
    expect(host.played).toHaveLength(0);

    engine.cancel();
    bufGate.resolve(mp3Buffer()); // body lands after the cancel — must be dropped
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(0);
    expect(await events).toEqual([{ type: "cancelled", speakId: 2 }]);
  });

  it("OpenAI cancel-during-play: reentrant cancel stops the just-created playback", async () => {
    // Host that cancels the engine mid-play (mirror of the MiniMax batch
    // test): run()'s post-play isCurrent() guard stops the orphan playback,
    // and start never fires.
    const { fetchImpl } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    let engine!: OpenAIEngine;
    const cancelDuringPlay = {
      play(bytes: Uint8Array, mime: string): Playback {
        const pb = host.play(bytes, mime);
        engine.cancel();
        return pb;
      },
    };
    engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: cancelDuringPlay });

    const events = collect(engine.speak("Race.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1); // play() ran before the cancel landed
    expect(host.playbacks[0].stopCalls).toBe(1); // guard stopped the orphan playback
    expect(await events).toEqual([{ type: "cancelled", speakId: 3 }]);
  });

  it("second-speak-during-arrayBuffer: old speak cancelled, its late body never plays", async () => {
    // Preempt lands while A awaits arrayBuffer() (fetch already returned).
    // A's stream closes cancelled; when its body finally resolves, the
    // post-buffer isCurrent() check drops it — only B's chunk ever plays.
    const bufGate = deferred<ArrayBuffer>();
    const { fetchImpl } = makeFetch([
      () => heldBodyResponse(bufGate), // chunk A — body held until B is playing
      () => mp3Response(MP3_BYTES),
      () => jsonResponse([]), // spare — never fetched
    ]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // A: fetched, body read pending
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(host.played).toHaveLength(1); // only B so far

    bufGate.resolve(mp3Buffer()); // A's body resolves AFTER the preempt
    await vi.advanceTimersByTimeAsync(0);
    expect(host.played).toHaveLength(1); // A's late audio dropped

    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("MiniMax streamed first-fragment preempt: reentrant cancel via playProgressive stops the fresh playback", async () => {
    // The first streamed fragment opens playback; the host's
    // playProgressive wrapper cancels the engine mid-call (external stop
    // racing the first byte). absorbStreamObject's isCurrent() guard stops
    // the orphan playback and returns before start/append ever fire.
    const gate = gateableResponse();
    const { fetchImpl } = makeFetch([
      (url) => {
        expect(url).toBe(MINIMAX_TTS_URL);
        return gate.resp;
      },
      () => jsonResponse([]), // spare — never fetched
    ]);
    const { host, playbacks } = makeProgressiveHost();
    let engine!: MiniMaxEngine;
    const cancelDuringFirstFragment: AudioHost = {
      play(): Playback {
        throw new Error("batch play() must not run when playProgressive exists");
      },
      playProgressive(mime: string): ProgressivePlayback {
        const pb = host.playProgressive!(mime);
        engine.cancel();
        return pb;
      },
    };
    engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: cancelDuringFirstFragment });

    const events = collect(engine.speak("Hello world.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // headers only — nothing playable yet
    expect(playbacks).toHaveLength(0);

    gate.enqueue(`{"data":{"audio":"ff00"}}`); // first fragment triggers the wrapper
    await vi.advanceTimersByTimeAsync(0);

    expect(playbacks).toHaveLength(1); // playback opened before the cancel landed
    expect(playbacks[0].appended).toHaveLength(0); // fragment dropped — cancelled before append
    expect(playbacks[0].stopCalls).toBe(1); // guard stopped the orphan playback
    expect(await events).toEqual([{ type: "cancelled", speakId: 5 }]); // no start
  });
});
