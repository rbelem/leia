// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_MODEL,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_TTS_URL,
  ELEVENLABS_VOICES_URL,
  ElevenLabsEngine,
  type Playback,
} from "../src/audio/engine-elevenlabs";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

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

// Base64 of the MP3 bytes [0x49, 0x44, 0x33] ("ID3").
const MP3_B64 = "SUQz";
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33]);

// "Hello world." — per-character alignment; words "Hello" (0–5) and "world." (6–12).
const ALIGNMENT = {
  characters: ["H", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d", "."],
  character_start_times_seconds: [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.5, 0.54, 0.58, 0.62, 0.66, 0.7],
  character_end_times_seconds: [0.05, 0.09, 0.13, 0.17, 0.21, 0.25, 0.55, 0.59, 0.63, 0.67, 0.71, 0.75],
};

describe("ElevenLabsEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("with-timestamps happy path: base64 audio → start → word events → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(`${ELEVENLABS_TTS_URL}/${ELEVENLABS_DEFAULT_VOICE}/with-timestamps`); // null voiceName → Rachel
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.text).toBe("Hello world.");
        expect(body.model_id).toBe(ELEVENLABS_MODEL);
        expect(body.output_format).toBe(ELEVENLABS_OUTPUT_FORMAT);
        expect(body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1.5 });
        expect(init?.headers).toMatchObject({ "X-Api-Key": "k123", "Content-Type": "application/json" });
        return jsonResponse({ audio_base64: MP3_B64, alignment: ALIGNMENT });
      },
    ]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0); // key → POST → play → start → 0ms word

    expect(host.played).toEqual([{ bytes: MP3_BYTES, mime: "audio/mpeg" }]);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500); // second word at (0.5 − 0)s
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "word", speakId: 7, begin: 6, end: 12 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("clamps rate into the ElevenLabs speed range (0.5–2) and uses a custom voice id", async () => {
    const bodies: Array<{ speed: number; voice_settings: unknown }> = [];
    const urls: string[] = [];
    const record = (url: string, init?: RequestInit): Response => {
      urls.push(url);
      bodies.push(JSON.parse(String(init?.body)) as { speed: number; voice_settings: unknown });
      return jsonResponse({ audio_base64: MP3_B64 });
    };
    const { fetchImpl } = makeFetch([record, record]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const e1 = collect(engine.speak("x", 1, { voiceName: "v-custom", rate: 3 })); // > max
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e1;

    const e2 = collect(engine.speak("y", 2, { voiceName: null, rate: 0.1 })); // < min
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[1]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e2;

    expect(urls).toEqual([
      `${ELEVENLABS_TTS_URL}/v-custom/with-timestamps`,
      `${ELEVENLABS_TTS_URL}/${ELEVENLABS_DEFAULT_VOICE}/with-timestamps`,
    ]);
    expect(bodies.map((b) => (b.voice_settings as { speed: number }).speed)).toEqual([2, 0.5]);
  });

  it("binary MP3 response (no timestamps): plays, no word events, still ends", async () => {
    const { fetchImpl, calls } = makeFetch([() => mp3Response(MP3_BYTES)]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.played).toEqual([{ bytes: MP3_BYTES, mime: "audio/mpeg" }]);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000); // no word timers pending
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 3 },
      { type: "end", speakId: 3 },
    ]);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new ElevenLabsEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 1, message: "ElevenLabs API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("invalid key: JSON detail surfaces as the error message", async () => {
    const { fetchImpl, calls } = makeFetch([() => jsonResponse({ detail: "Invalid API key" }, 401)]);
    const engine = new ElevenLabsEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "Invalid API key" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("prefetch caches audio; speak consumes it (one fetch for the pair); cancel clears", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ audio_base64: MP3_B64, alignment: ALIGNMENT }), // prefetch
      () => jsonResponse({ audio_base64: MP3_B64 }), // post-cancel re-synthesis
    ]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    await engine.prefetch("Hello world.", { voiceName: null, rate: 1 });
    expect(calls).toHaveLength(1); // prefetch synthesized

    const events = collect(engine.speak("Hello world.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // served from cache — no second fetch
    expect(host.played).toEqual([{ bytes: MP3_BYTES, mime: "audio/mpeg" }]);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 }, // cache holds audio bytes only — no alignment, no word events
    ]);

    engine.cancel(); // discards the cache
    const events2 = collect(engine.speak("Hello world.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // re-synthesized after cancel
    host.playbacks[1].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events2).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("prefetch with no key: no fetch, no crash", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new ElevenLabsEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    await engine.prefetch("Hi.", { voiceName: null, rate: 1 });
    expect(calls).toHaveLength(0);
  });

  it("prefetch with a mismatched speak: cache miss, speaks synth on demand", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ audio_base64: MP3_B64 }),
      () => jsonResponse({ audio_base64: MP3_B64 }),
    ]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    await engine.prefetch("Hello world.", { voiceName: null, rate: 1 });
    const events = collect(engine.speak("Hello world.", 3, { voiceName: "other", rate: 1 })); // different voice
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // different key → miss
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    await events;
  });

  it("cancel stops audio, clears pending words, closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ audio_base64: MP3_B64, alignment: ALIGNMENT })]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start + 0ms word fired; 500ms word pending

    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 4 },
      { type: "word", speakId: 4, begin: 0, end: 5 },
      { type: "cancelled", speakId: 4 },
    ]);
  });

  it("a new speak preempts: old stream cancelled, old audio stopped, no playback for the old chunk", async () => {
    const held = deferred<Response>();
    const { fetchImpl } = makeFetch([
      () => held.promise, // chunk A — held until B starts
      () => jsonResponse({ audio_base64: MP3_B64 }),
    ]);
    const host = makeHost();
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    // A's fetch resolves AFTER the preempt — A must not start audio.
    held.resolve(jsonResponse({ audio_base64: MP3_B64 }));
    await vi.advanceTimersByTimeAsync(500);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1); // only B played
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("getVoices: no key → empty; key → /v1/voices mapped, language labels → lang tags", async () => {
    const { fetchImpl, calls } = makeFetch([
      () =>
        jsonResponse({
          voices: [
            { voice_id: "v1", name: "Voice One", labels: { language: "Portuguese", accent: "Brazilian" } },
            { voice_id: "v2", name: "Voice Two", labels: { language: "English" } },
            { voice_id: "v3", name: "Voice Three", labels: {} }, // no language label
            { voice_id: "v4", name: "Voice Four", labels: { language: "Klingon" } }, // untranslatable
          ],
        }),
    ]);
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const voices = await engine.getVoices();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ELEVENLABS_VOICES_URL);
    expect(calls[0].init?.headers).toMatchObject({ "X-Api-Key": "k" });

    for (const v of voices) {
      expect(v.family).toBe("elevenlabs");
      expect(v.localService).toBe(false);
    }
    expect(voices.map((v) => v.name)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(voices.map((v) => v.lang)).toEqual(["pt-BR", "en-US", "und", "und"]);

    const noKey = new ElevenLabsEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl, audioHost: makeHost() });
    expect(await noKey.getVoices()).toEqual([]);
  });

  it("voices fetch failure → empty list (keyless skip semantics)", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ detail: "Invalid API key" }, 401)]);
    const engine = new ElevenLabsEngine({ getKey: async () => "bad", fetchImpl, audioHost: makeHost() });
    expect(await engine.getVoices()).toEqual([]);
  });
});