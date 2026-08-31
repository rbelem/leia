// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MISTRAL_CAPABILITIES,
  MISTRAL_DEFAULT_VOICE,
  MISTRAL_MODEL,
  MISTRAL_TTS_URL,
  MistralEngine,
} from "../src/audio/engine-mistral";
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

/** base64("ID3") — decodes to the classic MP3 ID3 tag bytes. */
const AUDIO_B64 = "SUQz";
const AUDIO_BYTES = new Uint8Array([0x49, 0x44, 0x33]);

describe("MistralEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: POST /audio/speech (bearer, input/model/voice_id) → base64 JSON → decoded mp3 play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(MISTRAL_TTS_URL);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer k123", "Content-Type": "application/json" });
        expect(JSON.parse(String(init?.body))).toEqual({
          input: "Hello world.",
          model: MISTRAL_MODEL,
          voice_id: MISTRAL_DEFAULT_VOICE, // null voiceName → curated default
          response_format: "mp3",
          stream: false,
        });
        return jsonResponse({ audio_data: AUDIO_B64 });
      },
    ]);
    const host = makeHost();
    const engine = new MistralEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: AUDIO_BYTES, mime: "audio/mpeg" }]); // decoded from base64
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
        expect(url).toBe(MISTRAL_TTS_URL);
        expect(JSON.parse(String(init?.body)).voice_id).toBe("my-saved-voice");
        return jsonResponse({ audio_data: AUDIO_B64 });
      },
    ]);
    const host = makeHost();
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("X.", 1, { voiceName: "my-saved-voice", rate: 1 }));
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
    const engine = new MistralEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "Mistral API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("Mistral error body {message} surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ object: "error", message: "Incorrect API key provided.", type: "invalid_api_key" }, 401),
    ]);
    const engine = new MistralEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Incorrect API key provided." },
    ]);
  });

  it("content-moderation 400 surfaces inline", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ object: "error", message: "Content moderated: policy violation", type: "moderation" }, 400),
    ]);
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 4, message: "Content moderated: policy violation" },
    ]);
  });

  it("string-or-object `error` bodies also surface", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ error: "voice not found" }, 400)]);
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: "nope", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "voice not found" }]);

    const { fetchImpl: fObj } = makeFetch([() => jsonResponse({ error: { message: "rate limited" } }, 429)]);
    const eObj = new MistralEngine({ getKey: async () => "k", fetchImpl: fObj, audioHost: makeHost() });
    const events2 = collect(eObj.speak("Hi.", 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events2).toEqual([{ type: "error", speakId: 6, message: "rate limited" }]);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 503,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 8, message: "Mistral error 503" }]);
  });

  it("envelope with missing/empty audio_data errors clearly", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({}), () => jsonResponse({ audio_data: "" })]);
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const e1 = collect(engine.speak("Hi.", 9, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e1).toEqual([{ type: "error", speakId: 9, message: "Mistral returned no audio payload" }]);

    const e2 = collect(engine.speak("Hi again.", 10, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e2).toEqual([{ type: "error", speakId: 10, message: "Mistral returned no audio payload" }]);
  });

  it("invalid base64 payload errors instead of playing garbage", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ audio_data: "!!!" })]);
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 11, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 11, message: expect.stringContaining("Mistral audio payload was not valid base64") },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ audio_data: AUDIO_B64 })]);
    const host = makeHost();
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

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
      () => jsonResponse({ audio_data: AUDIO_B64 }),
    ]);
    const host = makeHost();
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    held.resolve(jsonResponse({ audio_data: AUDIO_B64 })); // A's fetch resolves after the preempt
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
    const engine = new MistralEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 12, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 12, message: "Mistral request failed: Error: net down" },
    ]);
  });

  it("idle cancel (no active speak) is a safe no-op", () => {
    const engine = new MistralEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(() => engine.cancel()).not.toThrow();
  });

  it("getVoices: no key → []; key → the single curated default voice marked mistral", async () => {
    const noKey = new MistralEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(await noKey.getVoices()).toEqual([]);

    const withKey = new MistralEngine({ getKey: async () => "k", fetchImpl: makeFetch([]).fetchImpl });
    expect(await withKey.getVoices()).toEqual([
      { name: MISTRAL_DEFAULT_VOICE, lang: "en-US", localService: false, family: "mistral" },
    ]);
  });

  it("capabilities: no word timing (base64 audio, no timestamps), no streaming", () => {
    expect(MISTRAL_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
