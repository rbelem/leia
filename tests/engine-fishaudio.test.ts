// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FISH_CAPABILITIES,
  FISH_MAX_CHARS,
  FISH_MODELS_URL,
  FISH_TTS_MODEL,
  FISH_TTS_URL,
  FishAudioEngine,
} from "../src/audio/engine-fishaudio";
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

describe("FishAudioEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getVoices: marketplace models → trained, non-dmca items with the model id as name", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(`${FISH_MODELS_URL}?page_size=100&sort_by=task_count&page_number=1`);
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fk1" });
        return jsonResponse({
          items: [
            { _id: "abc123", title: "Alto", state: "trained", languages: ["en"], dmca_taken_down: false },
            { _id: "def456", title: "Training", state: "training", languages: ["zh"], dmca_taken_down: null },
            { _id: "ghi789", title: "Takedown", state: "trained", languages: ["de"], dmca_taken_down: true },
            { _id: 42, title: "Bad id", state: "trained", languages: ["ko"], dmca_taken_down: false },
            { _id: "jkl000", title: "Kansai", state: "trained", languages: ["ja-JP"], dmca_taken_down: false },
            { _id: "mno111", title: "Mystery", state: "trained", languages: [], dmca_taken_down: null },
            { _id: "pqr222", title: "", state: "trained", languages: ["en"], dmca_taken_down: false },
            { _id: "stu333", state: "trained", languages: ["en"], dmca_taken_down: false },
          ],
          total: 8,
          has_more: false,
        });
      },
    ]);
    const engine = new FishAudioEngine({ getKey: async () => "fk1", fetchImpl, audioHost: makeHost() });

    expect(await engine.getVoices()).toEqual([
      { name: "abc123", title: "Alto", lang: "en-US", localService: false, family: "fishaudio" },
      { name: "jkl000", title: "Kansai", lang: "ja-JP", localService: false, family: "fishaudio" },
      { name: "mno111", title: "Mystery", lang: "und", localService: false, family: "fishaudio" },
      { name: "pqr222", title: undefined, lang: "en-US", localService: false, family: "fishaudio" },
      { name: "stu333", title: undefined, lang: "en-US", localService: false, family: "fishaudio" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("getVoices caches per key within the TTL — the second open fetches nothing", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ items: [{ _id: "abc123", title: "Alto", state: "trained", languages: ["en"] }] }),
    ]);
    const engine = new FishAudioEngine({ getKey: async () => "fk1", fetchImpl, audioHost: makeHost() });

    const first = await engine.getVoices();
    const second = await engine.getVoices();

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("getVoices refetches after a failure and for a different key", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("nope", { status: 500 }),
      () => jsonResponse({ items: [{ _id: "abc123", title: "Alto", state: "trained", languages: ["en"] }] }),
      () => jsonResponse({ items: [{ _id: "def456", title: "Other", state: "trained", languages: ["en"] }] }),
    ]);
    let key = "fk1";
    const engine = new FishAudioEngine({ getKey: async () => key, fetchImpl, audioHost: makeHost() });

    // 500 is not cached — the next open refetches and succeeds.
    expect(await engine.getVoices()).toEqual([]);
    expect(await engine.getVoices()).toEqual([
      { name: "abc123", title: "Alto", lang: "en-US", localService: false, family: "fishaudio" },
    ]);
    // A different key must not be served the previous key's cached list.
    key = "fk2";
    expect(await engine.getVoices()).toEqual([
      { name: "def456", title: "Other", lang: "en-US", localService: false, family: "fishaudio" },
    ]);
    expect(calls).toHaveLength(3);
  });

  it("getVoices: no key → [] with no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new FishAudioEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    expect(await engine.getVoices()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("getVoices: non-OK, malformed envelope, and throwing fetch all → []", async () => {
    const f500 = makeFetch([() => jsonResponse({ message: "boom" }, 500)]);
    const e500 = new FishAudioEngine({ getKey: async () => "k", fetchImpl: f500.fetchImpl, audioHost: makeHost() });
    expect(await e500.getVoices()).toEqual([]);

    const fun = makeFetch([() => jsonResponse({ items: "nope" })]);
    const eUn = new FishAudioEngine({ getKey: async () => "k", fetchImpl: fun.fetchImpl, audioHost: makeHost() });
    expect(await eUn.getVoices()).toEqual([]);

    const fth = makeFetch([() => Promise.reject(new Error("net down"))]);
    const eTh = new FishAudioEngine({ getKey: async () => "k", fetchImpl: fth.fetchImpl, audioHost: makeHost() });
    expect(await eTh.getVoices()).toEqual([]);
  });

  it("happy path: POST /v1/tts (bearer + json + model header) → binary mp3 play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(FISH_TTS_URL);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer fk1",
          "Content-Type": "application/json",
          model: FISH_TTS_MODEL,
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          text: "Hello world.",
          format: "mp3",
          mp3_bitrate: 128,
          normalize: true,
          latency: "balanced",
          chunk_length: 300,
          reference_id: "abc123",
          prosody: { speed: 1.5 },
        });
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "fk1", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: "abc123", rate: 1.5 }));
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

  it("null voiceName omits reference_id (Fish default voice); rate 1 omits prosody", async () => {
    const { fetchImpl } = makeFetch([
      (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect("reference_id" in body).toBe(false);
        expect("prosody" in body).toBe(false);
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
  });

  it("prosody.speed clamps to the API's 0.5–2 range", async () => {
    const seen: unknown[] = [];
    const { fetchImpl } = makeFetch([
      (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).prosody);
        return mp3Response(MP3_BYTES);
      },
      (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).prosody);
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Fast.", 1, { voiceName: null, rate: 3 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    await eventsA;

    const eventsB = collect(engine.speak("Slow.", 2, { voiceName: null, rate: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[1].finish();
    await vi.advanceTimersByTimeAsync(0);
    await eventsB;

    expect(seen).toEqual([{ speed: 2 }, { speed: 0.5 }]);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new FishAudioEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "Fish Audio API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("JSON error body {message} surfaces as the error message", async () => {
    const { fetchImpl, calls } = makeFetch([() => jsonResponse({ message: "Invalid API key" }, 401)]);
    const engine = new FishAudioEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 3, message: "Invalid API key" }]);
    expect(calls).toHaveLength(1);
  });

  it("JSON error body {error:{message}} (sibling shape) surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ error: { message: "quota exceeded" } }, 402)]);
    const engine = new FishAudioEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 4, message: "quota exceeded" }]);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 429,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "Fish Audio error 429" }]);
  });

  it("request failure → error event", async () => {
    const { fetchImpl } = makeFetch([() => Promise.reject(new Error("net down"))]);
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 6, message: "Fish Audio request failed: Error: net down" },
    ]);
  });

  it("stalled synthesis aborts at the timeout → error event invites resume", async () => {
    // A fetch that never answers but honors the abort signal, like a hung TLS stream.
    const { fetchImpl, calls } = makeFetch([
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ]);
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost(), ttsTimeoutMs: 50 });

    const events = collect(engine.speak("Hi.", 7, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(200);
    expect(await events).toEqual([
      { type: "error", speakId: 7, message: "Fish Audio synthesis timed out after 1s — resume to retry" },
    ]);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("text over 2000 chars → error before the request; exactly 2000 is allowed", async () => {
    const { fetchImpl, calls } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const long = "x".repeat(FISH_MAX_CHARS + 1);
    const events = collect(engine.speak(long, 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      {
        type: "error",
        speakId: 8,
        message: `Fish Audio text too long (${FISH_MAX_CHARS + 1} > ${FISH_MAX_CHARS} chars)`,
      },
    ]);
    expect(calls).toHaveLength(0);

    const boundary = "x".repeat(FISH_MAX_CHARS);
    const events2 = collect(engine.speak(boundary, 9, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // boundary length goes to the API
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events2).toEqual([
      { type: "start", speakId: 9 },
      { type: "end", speakId: 9 },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 10, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start fired once audio lands
    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 10 },
      { type: "cancelled", speakId: 10 },
    ]);
  });

  it("a new speak preempts: old stream cancelled, old audio stopped, only the new chunk plays", async () => {
    const held = deferred<Response>();
    const { fetchImpl } = makeFetch([
      () => held.promise, // chunk A — held until B starts
      () => mp3Response(MP3_BYTES),
    ]);
    const host = makeHost();
    const engine = new FishAudioEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

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

  it("capabilities: no word timing (no timestamps — sentence granularity), no streaming", () => {
    expect(FISH_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
