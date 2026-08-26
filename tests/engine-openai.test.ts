import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_CAPABILITIES,
  OPENAI_DEFAULT_VOICE,
  OPENAI_FALLBACK_VOICES,
  OPENAI_MAX_CHARS,
  OPENAI_MODEL,
  OPENAI_TTS_URL,
  OPENAI_VOICES_URL,
  OpenAIEngine,
} from "../src/audio/engine-openai";
import type { Playback } from "../src/audio/engine-minimax";

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

describe("OpenAIEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: POST /audio/speech (bearer, model, default voice, mp3) → binary play → start → end; no word events", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(OPENAI_TTS_URL);
        expect(init?.headers).toMatchObject({ Authorization: "Bearer k123", "Content-Type": "application/json" });
        expect(JSON.parse(String(init?.body))).toEqual({
          model: OPENAI_MODEL,
          voice: OPENAI_DEFAULT_VOICE, // null voiceName → alloy
          input: "Hello world.",
          response_format: "mp3",
        });
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: MP3_BYTES, mime: "audio/mpeg" }]);
    expect(calls).toHaveLength(1);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("custom voiceName is forwarded as the voice field", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(OPENAI_TTS_URL);
        expect(JSON.parse(String(init?.body)).voice).toBe("nova");
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("X.", 1, { voiceName: "nova", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new OpenAIEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "OpenAI API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("JSON error body {error:{message}} surfaces as the error message", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ error: { message: "Invalid API key provided" } }, 401),
    ]);
    const engine = new OpenAIEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Invalid API key provided" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 429,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 4, message: "OpenAI error 429" }]);
  });

  it("text over 4096 chars → error before the request; exactly 4096 is allowed", async () => {
    const { fetchImpl, calls } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const long = "x".repeat(OPENAI_MAX_CHARS + 1);
    const events = collect(engine.speak(long, 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      {
        type: "error",
        speakId: 5,
        message: `OpenAI text too long (${OPENAI_MAX_CHARS + 1} > ${OPENAI_MAX_CHARS} chars)`,
      },
    ]);
    expect(calls).toHaveLength(0);

    const boundary = "x".repeat(OPENAI_MAX_CHARS);
    const events2 = collect(engine.speak(boundary, 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // boundary length goes to the API
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events2).toEqual([
      { type: "start", speakId: 6 },
      { type: "end", speakId: 6 },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 7, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start fired once audio lands
    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "cancelled", speakId: 7 },
    ]);
  });

  it("a new speak preempts: old stream cancelled, old audio stopped, only the new chunk plays", async () => {
    const held = deferred<Response>();
    const { fetchImpl } = makeFetch([
      () => held.promise, // chunk A — held until B starts
      () => mp3Response(MP3_BYTES),
    ]);
    const host = makeHost();
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    held.resolve(mp3Response(MP3_BYTES)); // A's fetch resolves after the preempt
    await vi.advanceTimersByTimeAsync(500);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1); // only B played
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("request failure → error event", async () => {
    const { fetchImpl } = makeFetch([() => Promise.reject(new Error("net down"))]);
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 8, message: "OpenAI request failed: Error: net down" },
    ]);
  });

  it("getVoices: no key → []; live list → mapped; 404 / unshaped / throw → curated fallback", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ voices: ["alloy", "nova"] }), // live list
    ]);
    const engine = new OpenAIEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });
    expect(await engine.getVoices()).toEqual([
      { name: "alloy", lang: "en-US", localService: false, family: "openai" },
      { name: "nova", lang: "en-US", localService: false, family: "openai" },
    ]);
    expect(calls[0].url).toBe(OPENAI_VOICES_URL);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer k" });

    // 404 → curated fallback
    const { fetchImpl: f404 } = makeFetch([() => jsonResponse({ error: {} }, 404)]);
    const e404 = new OpenAIEngine({ getKey: async () => "k", fetchImpl: f404, audioHost: makeHost() });
    expect((await e404.getVoices()).map((v) => v.name)).toEqual(OPENAI_FALLBACK_VOICES);

    // Unshaped body → curated fallback
    const { fetchImpl: fun } = makeFetch([() => jsonResponse({ voices: [{ id: 1 }] })]);
    const eUn = new OpenAIEngine({ getKey: async () => "k", fetchImpl: fun, audioHost: makeHost() });
    expect((await eUn.getVoices()).map((v) => v.name)).toEqual(OPENAI_FALLBACK_VOICES);
    expect((await eUn.getVoices())[0]).toEqual({
      name: "alloy",
      lang: "en-US",
      localService: false,
      family: "openai",
    });

    // Throwing fetch → curated fallback
    const { fetchImpl: fth } = makeFetch([() => Promise.reject(new Error("net down"))]);
    const eTh = new OpenAIEngine({ getKey: async () => "k", fetchImpl: fth, audioHost: makeHost() });
    expect((await eTh.getVoices()).map((v) => v.name)).toEqual(OPENAI_FALLBACK_VOICES);

    const noKey = new OpenAIEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });
    expect(await noKey.getVoices()).toEqual([]);
  });

  it("capabilities: no word timing (no timestamps — sentence granularity), no streaming", () => {
    expect(OPENAI_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
    });
  });
});