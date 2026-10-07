// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QWENCLOUD_CAPABILITIES,
  QWENCLOUD_DEFAULT_VOICE,
  QWENCLOUD_MAX_CHARS,
  QWENCLOUD_MODEL,
  QWENCLOUD_TTS_URL,
  QWENCLOUD_VOICES,
  QwenCloudEngine,
} from "../src/audio/engine-qwencloud";
import type { Playback } from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

const RESULT_URL = "https://dashscope-result.oss-ap-southeast-1.aliyuncs.com/audio-result.wav?Expires=1&Signature=x";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

function wavResponse(bytes: Uint8Array, contentType = "audio/wav"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
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

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"

describe("QwenCloudEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: POST (bearer, model/input.text/input.voice) → envelope url → GET wav → play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(QWENCLOUD_TTS_URL);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer k123", "Content-Type": "application/json" });
        expect(JSON.parse(String(init?.body))).toEqual({
          model: QWENCLOUD_MODEL,
          input: { text: "Hello world.", voice: QWENCLOUD_DEFAULT_VOICE }, // null voiceName → Cherry
        });
        return jsonResponse({ output: { audio: { url: RESULT_URL } } });
      },
      (url) => {
        expect(url).toBe(RESULT_URL);
        return wavResponse(WAV_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new QwenCloudEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: WAV_BYTES, mime: "audio/wav" }]);
    expect(calls).toHaveLength(2);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("custom voiceName is forwarded as the input.voice field", async () => {
    const { fetchImpl } = makeFetch([
      (_url, init) => {
        expect(JSON.parse(String(init?.body)).input.voice).toBe("Ethan");
        return jsonResponse({ output: { audio: { url: RESULT_URL } } });
      },
      () => wavResponse(WAV_BYTES),
    ]);
    const host = makeHost();
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("X.", 1, { voiceName: "Ethan", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new QwenCloudEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "QwenCloud API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("text over the 600-char API limit errors before any fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("a".repeat(QWENCLOUD_MAX_CHARS + 1), 9, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 9, message: `QwenCloud text too long (${QWENCLOUD_MAX_CHARS + 1} > ${QWENCLOUD_MAX_CHARS} chars)` },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("DashScope error body {code,message} surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ code: "InvalidApiKey", message: "Incorrect API key provided.", request_id: "r1" }, 401),
    ]);
    const engine = new QwenCloudEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Incorrect API key provided." },
    ]);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 429,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "QwenCloud error 429" }]);
  });

  it("envelope without output.audio.url errors", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ output: { finish_reason: "stop" } })]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 4, message: "QwenCloud response has no audio url" }]);
  });

  it("non-JSON 200 envelope errors", async () => {
    const resp: Response = {
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 6, message: "QwenCloud response is not JSON" }]);
  });

  it("audio URL download failure errors", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ output: { audio: { url: RESULT_URL } } }),
      () => Promise.reject(new Error("oss down")),
    ]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 10, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 10, message: "QwenCloud audio download failed: Error: oss down" },
    ]);
  });

  it("audio URL non-OK download errors with the status", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ output: { audio: { url: RESULT_URL } } }),
      () => ({ ok: false, status: 403, headers: { get: () => null } } as unknown as Response),
    ]);
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 11, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 11, message: "QwenCloud audio error 403" }]);
  });

  it("a non-audio content-type on the download falls back to audio/wav", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ output: { audio: { url: RESULT_URL } } }),
      () => wavResponse(WAV_BYTES, "application/octet-stream"),
    ]);
    const host = makeHost();
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 12, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.played[0].mime).toBe("audio/wav");
    expect(await events).toEqual([
      { type: "start", speakId: 12 },
      { type: "end", speakId: 12 },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ output: { audio: { url: RESULT_URL } } }),
      () => wavResponse(WAV_BYTES),
    ]);
    const host = makeHost();
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

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
      () => jsonResponse({ output: { audio: { url: RESULT_URL } } }),
      () => wavResponse(WAV_BYTES),
    ]);
    const host = makeHost();
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    held.resolve(jsonResponse({ output: { audio: { url: RESULT_URL } } })); // A's synth resolves after the preempt
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
    const engine = new QwenCloudEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 8, message: "QwenCloud request failed: Error: net down" },
    ]);
  });

  it("idle cancel (no active speak) is a safe no-op", () => {
    const engine = new QwenCloudEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(() => engine.cancel()).not.toThrow();
  });

  it("getVoices: no key → []; key → curated 10 voices marked qwencloud/localService false", async () => {
    const noKey = new QwenCloudEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(await noKey.getVoices()).toEqual([]);

    const withKey = new QwenCloudEngine({ getKey: async () => "k", fetchImpl: makeFetch([]).fetchImpl });
    const voices = await withKey.getVoices();
    expect(voices).toHaveLength(QWENCLOUD_VOICES.length);
    expect(QWENCLOUD_VOICES.length).toBe(10);
    expect(QWENCLOUD_VOICES[0]).toBe("Cherry"); // Cherry is the default voice
    expect(voices[0]).toEqual({ name: "Cherry", lang: "en-US", localService: false, family: "qwencloud" });
    for (const v of voices) {
      expect(v.family).toBe("qwencloud");
      expect(v.localService).toBe(false);
    }
  });

  it("capabilities: no word timing (URL-based WAV, no timestamps), no streaming", () => {
    expect(QWENCLOUD_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
