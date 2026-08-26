import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINIMAX_MAX_CHARS,
  MINIMAX_MODEL,
  MINIMAX_TTS_URL,
  MiniMaxEngine,
  SYSTEM_VOICES,
  type Playback,
} from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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

const ENVELOPE_OK = {
  base_resp: { status_code: 0, status_msg: "success" },
  data: { audio: "ffd8ff00", subtitle_file: "https://sub.example/segments.json" },
};

const SUBTITLE_OK = [
  {
    text: "Hello world.",
    timestamped_words: [
      { word: "Hello", word_begin: 0, word_end: 5, time_begin: 42.6 },
      { word: "world.", word_begin: 6, word_end: 12, time_begin: 500.2 },
    ],
  },
];

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

describe("MiniMaxEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("t2a_v2 happy path: hex audio → start → word events → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(MINIMAX_TTS_URL);
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(MINIMAX_MODEL);
        expect(body.voice_setting).toEqual({ voice_id: "male-qn-qingse", speed: 1.5 }); // rate passed through
        expect(body.audio_setting).toEqual({
          format: "mp3",
          sample_rate: 32000,
          bitrate: 128000,
          channel: 1,
          output_format: "hex",
        });
        expect(body.subtitle_enable).toBe(true);
        expect(body.subtitle_type).toBe("word");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer k123" });
        return jsonResponse(ENVELOPE_OK);
      },
      () => jsonResponse(SUBTITLE_OK),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k123", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: "male-qn-qingse", rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0); // key → POST → play → start → subtitle fetch → 0ms word

    expect(host.played).toEqual([{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), mime: "audio/mpeg" }]);
    expect(calls[1].url).toBe("https://sub.example/segments.json");

    await vi.advanceTimersByTimeAsync(500); // second word at (500.2 - 42.6)ms
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "word", speakId: 7, begin: 6, end: 12 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("clamps rate into the MiniMax speed range (0.5–2)", async () => {
    const bodies: Array<{ speed: number }> = [];
    const record = (url: string, init?: RequestInit): Response => {
      if (url === MINIMAX_TTS_URL) {
        bodies.push((JSON.parse(String(init?.body)) as { voice_setting: { speed: number } }).voice_setting);
        return jsonResponse(ENVELOPE_OK);
      }
      return jsonResponse([]); // subtitle fetch — not a TTS POST
    };
    const { fetchImpl } = makeFetch([record, record, record, record]); // 2 speaks × (t2a + subtitle)
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const e1 = collect(engine.speak("x", 1, { voiceName: null, rate: 3 })); // > max
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e1;

    const e2 = collect(engine.speak("y", 2, { voiceName: null, rate: 0.1 })); // < min
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[1]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e2;

    expect(bodies.map((b) => b.speed)).toEqual([2, 0.5]);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new MiniMaxEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 1, message: "MiniMax API key not set — providers settings (T14)" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("error envelope (unknown voice) surfaces base_resp.status_msg", async () => {
    const { fetchImpl } = makeFetch([
      () =>
        jsonResponse({
          base_resp: { status_code: 2054, status_msg: "voice id not exist" },
          data: { audio: null },
        }),
    ]);
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: "nope", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "voice id not exist" },
    ]);
  });

  it("rejects chunk text over the 10000-char guard", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("x".repeat(MINIMAX_MAX_CHARS + 1), 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: `MiniMax text too long (${MINIMAX_MAX_CHARS + 1} > ${MINIMAX_MAX_CHARS} chars)` },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("cancel stops audio, clears pending words, closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK), () => jsonResponse(SUBTITLE_OK)]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start + 0ms word fired; 457ms word pending

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
      () => held.promise, // chunk A t2a — held until B starts
      () => jsonResponse(ENVELOPE_OK),
      () => jsonResponse(SUBTITLE_OK),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    // A's fetch resolves AFTER the preempt — A must not start audio.
    held.resolve(jsonResponse(ENVELOPE_OK));
    await vi.advanceTimersByTimeAsync(500);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1); // only B played
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "word", speakId: 2, begin: 0, end: 5 },
      { type: "word", speakId: 2, begin: 6, end: 12 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("getVoices: no key → empty; key → curated system voices marked minimax/localService false", async () => {
    const noKey = new MiniMaxEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(await noKey.getVoices()).toEqual([]);

    const withKey = new MiniMaxEngine({ getKey: async () => "k", fetchImpl: makeFetch([]).fetchImpl });
    const voices = await withKey.getVoices();
    expect(voices).toHaveLength(SYSTEM_VOICES.length);
    for (const v of voices) {
      expect(v.family).toBe("minimax");
      expect(v.localService).toBe(false);
    }
    expect(voices.map((v) => v.name)).toEqual(SYSTEM_VOICES.map((s) => s.id));
  });

  it("getVoices filters by locale script prefix when provided", async () => {
    const en = new MiniMaxEngine({ getKey: async () => "k", locale: "en-US", fetchImpl: makeFetch([]).fetchImpl });
    expect(await en.getVoices()).toEqual([]); // all curated voices are zh-CN

    const zh = new MiniMaxEngine({ getKey: async () => "k", locale: "zh", fetchImpl: makeFetch([]).fetchImpl });
    expect(await zh.getVoices()).toHaveLength(SYSTEM_VOICES.length);
  });
});