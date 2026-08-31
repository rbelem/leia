// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_CAPABILITIES,
  GEMINI_DEFAULT_VOICE,
  GEMINI_SAMPLE_RATE,
  GEMINI_TTS_MODEL,
  GEMINI_TTS_URL,
  GEMINI_VOICES,
  GeminiEngine,
  pcmToWav,
} from "../src/audio/engine-gemini";
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

/** base64("ID3") — 3 raw PCM bytes, decodes to the classic ID3 tag bytes. */
const AUDIO_B64 = "SUQz";
const PCM_BYTES = new Uint8Array([0x49, 0x44, 0x33]);

describe("pcmToWav", () => {
  it("wraps PCM in a canonical 44-byte header with correct byte math", () => {
    const wav = pcmToWav(PCM_BYTES);
    expect(wav).toHaveLength(44 + PCM_BYTES.length);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + PCM_BYTES.length); // riffSize
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(wav.slice(12, 16))).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000); // sampleRate
    expect(view.getUint32(28, true)).toBe(48_000); // byteRate = 24000 × 1 × 2
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(PCM_BYTES.length); // dataLen
    expect([...wav.slice(44)]).toEqual([...PCM_BYTES]); // PCM appended verbatim
  });

  it("one second of 24 kHz 16-bit mono PCM = 48000-byte data chunk; custom sample rate flows through", () => {
    const oneSecond = pcmToWav(new Uint8Array(48_000));
    const view = new DataView(oneSecond.buffer);
    expect(view.getUint32(40, true)).toBe(48_000); // exactly 1s of audio
    expect(view.getUint32(4, true)).toBe(36 + 48_000);

    const custom = pcmToWav(PCM_BYTES, 8000);
    const cview = new DataView(custom.buffer);
    expect(cview.getUint32(24, true)).toBe(8_000);
    expect(cview.getUint32(28, true)).toBe(16_000); // byteRate tracks the rate
  });
});

describe("GeminiEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: POST /interactions (x-goog-api-key, model/input/response_format/speech_config) → base64 PCM → WAV-wrapped play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(GEMINI_TTS_URL);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "x-goog-api-key": "k123", // Gemini auth — no Bearer
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          model: GEMINI_TTS_MODEL,
          input: "Hello world.",
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice: GEMINI_DEFAULT_VOICE }] }, // null voiceName → Kore
        });
        return jsonResponse({ interaction: { output_audio: { data: AUDIO_B64 } } });
      },
    ]);
    const host = makeHost();
    const engine = new GeminiEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1);
    expect(host.played[0].mime).toBe("audio/wav"); // raw PCM wrapped as WAV
    const view = new DataView(host.played[0].bytes.buffer);
    expect(host.played[0].bytes).toHaveLength(44 + PCM_BYTES.length);
    expect(view.getUint32(24, true)).toBe(GEMINI_SAMPLE_RATE);
    expect([...host.played[0].bytes.slice(44)]).toEqual([...PCM_BYTES]); // decoded from base64
    expect(calls).toHaveLength(1);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("custom voiceName flows into generation_config.speech_config", async () => {
    const { fetchImpl } = makeFetch([
      (url, init) => {
        expect(url).toBe(GEMINI_TTS_URL);
        expect(JSON.parse(String(init?.body)).generation_config).toEqual({ speech_config: [{ voice: "Puck" }] });
        return jsonResponse({ interaction: { output_audio: { data: AUDIO_B64 } } });
      },
    ]);
    const host = makeHost();
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("X.", 1, { voiceName: "Puck", rate: 1 }));
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
    const engine = new GeminiEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "Gemini API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("Google error envelope {error:{message}} surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } }, 400),
    ]);
    const engine = new GeminiEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "API key not valid." },
    ]);
  });

  it("quota 429 surfaces inline", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ error: { code: 429, message: "Resource has been exhausted (quota).", status: "RESOURCE_EXHAUSTED" } }, 429),
    ]);
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 4, message: "Resource has been exhausted (quota)." },
    ]);
  });

  it("non-JSON error response falls back to the status", async () => {
    const resp: Response = {
      ok: false,
      status: 503,
      headers: { get: () => "text/plain" },
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "Gemini error 503" }]);
  });

  it("response missing/malformed output_audio.data errors explicitly", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({}),
      () => jsonResponse({ interaction: { output_audio: {} } }),
      () => jsonResponse({ interaction: { output_audio: { data: "" } } }),
    ]);
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const e1 = collect(engine.speak("Hi.", 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e1).toEqual([{ type: "error", speakId: 6, message: "Gemini returned no audio payload" }]);

    const e2 = collect(engine.speak("Hi.", 9, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e2).toEqual([{ type: "error", speakId: 9, message: "Gemini returned no audio payload" }]);

    const e3 = collect(engine.speak("Hi.", 10, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e3).toEqual([{ type: "error", speakId: 10, message: "Gemini returned no audio payload" }]);
  });

  it("invalid base64 payload errors instead of playing garbage", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ interaction: { output_audio: { data: "!!!" } } })]);
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 11, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 11, message: expect.stringContaining("Gemini audio payload was not valid base64") },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ interaction: { output_audio: { data: AUDIO_B64 } } })]);
    const host = makeHost();
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 12, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start fired once audio lands
    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 12 },
      { type: "cancelled", speakId: 12 },
    ]);
  });

  it("a new speak preempts: old stream cancelled, old audio stopped, only the new chunk plays", async () => {
    const held = deferred<Response>();
    const { fetchImpl } = makeFetch([
      () => held.promise, // chunk A — held until B starts
      () => jsonResponse({ interaction: { output_audio: { data: AUDIO_B64 } } }),
    ]);
    const host = makeHost();
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    held.resolve(jsonResponse({ interaction: { output_audio: { data: AUDIO_B64 } } })); // A's fetch resolves after the preempt
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
    const engine = new GeminiEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 13, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 13, message: "Gemini request failed: Error: net down" },
    ]);
  });

  it("idle cancel (no active speak) is a safe no-op", () => {
    const engine = new GeminiEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(() => engine.cancel()).not.toThrow();
  });

  it("getVoices: no key → []; key → curated 30 voices marked gemini, Kore default first", async () => {
    const noKey = new GeminiEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(await noKey.getVoices()).toEqual([]);

    const withKey = new GeminiEngine({ getKey: async () => "k", fetchImpl: makeFetch([]).fetchImpl });
    const voices = await withKey.getVoices();
    expect(voices).toHaveLength(GEMINI_VOICES.length);
    expect(GEMINI_VOICES.length).toBe(30);
    expect(GEMINI_VOICES[0]).toBe("Kore"); // Kore is the default voice
    expect(voices[0]).toEqual({ name: "Kore", lang: "en-US", localService: false, family: "gemini" });
    for (const v of voices) {
      expect(v.family).toBe("gemini");
      expect(v.localService).toBe(false);
    }
  });

  it("capabilities: no word timing (raw PCM, no timestamps), no streaming", () => {
    expect(GEMINI_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
