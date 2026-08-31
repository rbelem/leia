// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  XAI_CAPABILITIES,
  XAI_DEFAULT_VOICE,
  XAI_LANGUAGE,
  XAI_TTS_URL,
  XAI_VOICES,
  XaiEngine,
} from "../src/audio/engine-xai";
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

describe("XaiEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: POST /v1/tts (bearer, text/voice_id/language) → RAW binary mp3 play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(XAI_TTS_URL);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer k123", "Content-Type": "application/json" });
        expect(JSON.parse(String(init?.body))).toEqual({
          text: "Hello world.",
          voice_id: XAI_DEFAULT_VOICE, // null voiceName → eve
          language: XAI_LANGUAGE,
        });
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new XaiEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

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

  it("custom voiceName is forwarded as the voice_id field", async () => {
    const { fetchImpl } = makeFetch([
      (url, init) => {
        expect(url).toBe(XAI_TTS_URL);
        expect(JSON.parse(String(init?.body)).voice_id).toBe("luna");
        return mp3Response(MP3_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("X.", 1, { voiceName: "luna", rate: 1 }));
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
    const engine = new XaiEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "xAI API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("xAI error body {error:\"<string>\"} surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ code: "ClientSpecifiedAuthTypeNotSupported", error: "Incorrect API key provided." }, 401),
    ]);
    const engine = new XaiEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Incorrect API key provided." },
    ]);
  });

  it("OpenAI-shaped error body {error:{message}} also surfaces", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ error: { message: "Voice not found" } }, 400)]);
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: "nope", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 4, message: "Voice not found" }]);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 429,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "xAI error 429" }]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

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
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

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
    const engine = new XaiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 8, message: "xAI request failed: Error: net down" },
    ]);
  });

  it("idle cancel (no active speak) is a safe no-op", () => {
    const engine = new XaiEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(() => engine.cancel()).not.toThrow();
  });

  it("getVoices: no key → []; key → curated 28 voices marked xai/localService false", async () => {
    const noKey = new XaiEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(await noKey.getVoices()).toEqual([]);

    const withKey = new XaiEngine({ getKey: async () => "k", fetchImpl: makeFetch([]).fetchImpl });
    const voices = await withKey.getVoices();
    expect(voices).toHaveLength(XAI_VOICES.length);
    expect(XAI_VOICES.length).toBe(28);
    expect(XAI_VOICES[0]).toBe("eve"); // eve is the default voice
    expect(voices[0]).toEqual({ name: "eve", lang: "en-US", localService: false, family: "xai" });
    for (const v of voices) {
      expect(v.family).toBe("xai");
      expect(v.localService).toBe(false);
    }
  });

  it("capabilities: no word timing (raw audio, no timestamps), no streaming", () => {
    expect(XAI_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
