import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOM_AUDIO_HOST,
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
  /** Media-clock test hook: sets the clock read at timeline-push time. */
  clockTo(ms: number): void;
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
      let time = 0;
      const pb: StubPlayback = {
        stopCalls: 0,
        done: new Promise((r) => (resolveDone = r)),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        finish: () => resolveDone(),
        clockTo(ms: number) {
          time = ms;
        },
      };
      pb.clockMs = () => time;
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
    await vi.advanceTimersByTimeAsync(0); // key → POST → play → start → subtitle fetch → timeline

    expect(host.played).toEqual([{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), mime: "audio/mpeg" }]);
    expect(calls[1].url).toBe("https://sub.example/segments.json");

    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    const all = await events;
    expect(all[0]).toEqual({ type: "start", speakId: 7 });
    expect(all[1]).toEqual({
      type: "timeline",
      speakId: 7,
      words: [
        { begin: 0, end: 5, t: 0 }, // 42.6 − 42.6
        { begin: 6, end: 12, t: expect.closeTo(457.6, 6) }, // 500.2 − 42.6
      ],
      anchorWall: Date.now(),
      anchorClock: 0,
    });
    expect(all[2]).toEqual({ type: "end", speakId: 7 });
    expect(all).toHaveLength(3);
  });

  it("ships the timeline with the live media clock at push time", async () => {
    const subGate = deferred<Response>();
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK), () => subGate.promise]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const iterable = engine.speak("Hello world.", 8, { voiceName: null, rate: 1 });
    const seen: unknown[] = [];
    void (async () => {
      for await (const ev of iterable) seen.push(ev);
    })();

    await vi.advanceTimersByTimeAsync(0); // POST + play; subtitle fetch pending

    host.playbacks[0].clockTo(400); // 400ms of audio played by push time
    subGate.resolve(jsonResponse(SUBTITLE_OK));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([
      { type: "start", speakId: 8 },
      { type: "timeline", speakId: 8, words: [
        { begin: 0, end: 5, t: 0 },
        { begin: 6, end: 12, t: expect.closeTo(457.6, 6) },
      ], anchorWall: Date.now(), anchorClock: 400 },
    ]);

    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(3); // end — and no duplicate timeline from anywhere
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

  it("non-finite rate clamps to neutral speed instead of reaching the API as NaN", async () => {
    const bodies: Array<{ speed: number }> = [];
    const record = (url: string, init?: RequestInit): Response => {
      if (url === MINIMAX_TTS_URL) {
        bodies.push((JSON.parse(String(init?.body)) as { voice_setting: { speed: number } }).voice_setting);
        return jsonResponse(ENVELOPE_OK);
      }
      return jsonResponse([]);
    };
    const { fetchImpl } = makeFetch([record, record]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    // Rate undefined is unreachable through the session (settings merge),
    // but the engine boundary stays NaN-proof (matches utterance.rate clamp).
    const events = collect(engine.speak("x", 30, { voiceName: null, rate: Number.NaN }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    await events;

    expect(bodies).toEqual([{ voice_id: "male-qn-qingse", speed: 1 }]);
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

  it("cancel stops audio, blocks the pending timeline, closes with cancelled", async () => {
    const subGate = deferred<Response>();
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK), () => subGate.promise]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start pushed; subtitle fetch pending

    engine.cancel();
    subGate.resolve(jsonResponse(SUBTITLE_OK)); // late fetch must not push either
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 4 },
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
    expect(host.played).toHaveLength(1); // only B played
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "timeline", speakId: 2, words: [
        { begin: 0, end: 5, t: 0 },
        { begin: 6, end: 12, t: expect.closeTo(457.6, 6) },
      ], anchorWall: expect.any(Number), anchorClock: 0 },
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

describe("MiniMaxEngine — failure and edge paths (100% coverage)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("network failure: request error becomes an error event", async () => {
    const { fetchImpl } = makeFetch([() => Promise.reject(new Error("offline"))]);
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 11, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 11, message: "MiniMax request failed: Error: offline" },
    ]);
  });

  it("status-0 envelope with missing/empty audio payload errors clearly", async () => {
    // data.audio = "" (empty string passes typeof check)
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ base_resp: { status_code: 0 }, data: { audio: "" } }),
      () => jsonResponse({ base_resp: { status_code: 0 }, data: {} }), // audio undefined
    ]);
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const e1 = collect(engine.speak("Hi.", 12, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e1).toEqual([{ type: "error", speakId: 12, message: "MiniMax returned no audio payload" }]);

    const e2 = collect(engine.speak("Hi again.", 13, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e2).toEqual([{ type: "error", speakId: 13, message: "MiniMax returned no audio payload" }]);
  });

  it("cancellation arriving during host.play stops the just-created playback", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK)]);
    let engine!: MiniMaxEngine;
    const host = makeHost();
    // Host that cancels the engine mid-play (e.g. external stop racing play()).
    const cancelDuringPlay = {
      play(bytes: Uint8Array, mime: string): Playback {
        const pb = host.play(bytes, mime);
        engine.cancel();
        return pb;
      },
    };
    engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: cancelDuringPlay });

    const events = collect(engine.speak("Race.", 14, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.playbacks[0].stopCalls).toBe(1); // guard stopped the orphan playback
    expect(await events).toEqual([{ type: "cancelled", speakId: 14 }]);
  });

  it("idle cancel (no active speak) is a safe no-op", () => {
    const engine = new MiniMaxEngine({ getKey: async () => null, fetchImpl: makeFetch([]).fetchImpl });
    expect(() => engine.cancel()).not.toThrow();
  });

  it("error envelope without status_msg falls back to 'MiniMax error <code>'", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ base_resp: { status_code: 1002 } })]);
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 22, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 22, message: "MiniMax error 1002" }]);
  });

  it("preempting before getKey resolves: superseded speak vanishes silently", async () => {
    const keyGate = deferred<string | null>();
    const { fetchImpl } = makeFetch([]); // must never be reached
    const host = makeHost();
    const engine = new MiniMaxEngine({
      getKey: () => keyGate.promise,
      fetchImpl,
      audioHost: host,
    });

    const eventsA = collect(engine.speak("Slow key.", 23, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // A parked awaiting the key gate
    // B starts and fully preempts before A's key ever arrives…
    const eventsB = collect(engine.speak("Fast.", 24, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // B reaches its own key gate
    keyGate.resolve(null); // release both — keyless
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(0);
    // A resumes past the key gate only to find itself superseded: silent exit.
    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 23 }]);
    expect(await eventsB).toEqual([
      { type: "error", speakId: 24, message: "MiniMax API key not set — providers settings (T14)" },
    ]);
  });

  it("constructor defaults wire the platform fetch and DOM audio host", async () => {
    // No fetchImpl/audioHost options: defaults must be live (no-key path
    // errors before any network/Audio use, proving the wiring didn't throw).
    const bare = new MiniMaxEngine({ getKey: async () => null });
    const events = collect(bare.speak("Hi.", 25, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 25, message: "MiniMax API key not set — providers settings (T14)" },
    ]);
  });


  it("subtitle fetch failure never blocks audio", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse(ENVELOPE_OK),
      () => Promise.reject(new Error("subtitle dns")),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 15, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 15 },
      { type: "end", speakId: 15 },
    ]);
  });

  it("envelope without subtitle_file: audio completes without word events", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ base_resp: { status_code: 0 }, data: { audio: "ab" } }),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 16, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 16 },
      { type: "end", speakId: 16 },
    ]);
  });

  it("subtitle fetch !ok: word events dropped, audio completes", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse(ENVELOPE_OK),
      (): Response => ({ ok: false, json: async () => [] } as unknown as Response),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 20, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 20 },
      { type: "end", speakId: 20 },
    ]);
  });

  it("subtitle payload not an array: word events dropped, audio completes", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse(ENVELOPE_OK),
      () => jsonResponse({ nope: true } as unknown), // object, not an array
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 21, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(10);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 21 },
      { type: "end", speakId: 21 },
    ]);
  });

  it("malformed word entries are skipped; first-word anchoring uses the first valid time_begin", async () => {
    const SUBTITLE_MESSY = [
      { text: "no words here" }, // segment without timestamped_words
      {
        timestamped_words: [
          { word_begin: 0, word_end: 5, time_begin: 42 }, // valid anchor
          { word_begin: 6, word_end: 2, time_begin: 50 }, // end <= begin
          { word_begin: "x", word_end: 9, time_begin: 60 }, // begin non-number
          { word_begin: -20, word_end: -30, time_begin: 130 }, // end <= begin (negatives)
          { word_begin: 10, word_end: 14, time_begin: 120.5 }, // valid
        ],
      },
    ];
    const { fetchImpl } = makeFetch([
      () => jsonResponse(ENVELOPE_OK),
      () => jsonResponse(SUBTITLE_MESSY),
    ]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Marching test.", 17, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(5);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 17 },
      { type: "timeline", speakId: 17, words: [
        { begin: 0, end: 5, t: 0 }, // anchor word (42 − 42)
        { begin: 10, end: 14, t: 78.5 }, // second valid (120.5 − 42)
      ], anchorWall: expect.any(Number), anchorClock: 0 },
      { type: "end", speakId: 17 },
    ]);
  });

  it("first timestamped word without numeric time_begin disables word events entirely", async () => {
    const SUBTITLE_NO_ANCHOR = [{ timestamped_words: [{ word_begin: 0, word_end: 3 }] }];
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK), () => jsonResponse(SUBTITLE_NO_ANCHOR)]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("No anchor.", 18, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(5);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 18 },
      { type: "end", speakId: 18 },
    ]);
  });

  it("backwards-timed words ship sorted in the single timeline (negative relative t)", async () => {
    // Second word's absolute time precedes the anchor: relative targets go
    // negative — the local march applies them immediately on its first frame.
    const SUBTITLE_BACKWARDS = [
      { timestamped_words: [
        { word_begin: 0, word_end: 4, time_begin: 900 },
        { word_begin: 5, word_end: 9, time_begin: 10 },
      ] },
    ];
    const { fetchImpl } = makeFetch([() => jsonResponse(ENVELOPE_OK), () => jsonResponse(SUBTITLE_BACKWARDS)]);
    const host = makeHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Backwards timing.", 19, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 19 },
      { type: "timeline", speakId: 19, words: [
        { begin: 5, end: 9, t: -890 }, // earlier absolute time first
        { begin: 0, end: 4, t: 0 },
      ], anchorWall: expect.any(Number), anchorClock: 0 },
      { type: "end", speakId: 19 },
    ]);
  });
});

describe("DOM_AUDIO_HOST (default Audio-based playback)", () => {
  interface FakeAudioInstance {
    src: string;
    onended: (() => void) | null;
    onerror: (() => void) | null;
    playBehavior: "resolve" | "reject" | "throw" | "undefined";
    paused: boolean;
    playCalls: number;
    currentTime: number;
    play(): Promise<void> | undefined;
    pause(): void;
  }
  let lastAudio: FakeAudioInstance | null = null;
  class FakeAudio {
    src: string;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    playBehavior: "resolve" | "reject" | "throw" | "undefined";
    paused = true;
    playCalls = 0;
    currentTime = 0;
    constructor(src: string) {
      this.src = src;
      this.playBehavior = mode;
      lastAudio = this as unknown as FakeAudioInstance;
    }
    play(): Promise<void> | undefined {
      this.playCalls += 1;
      this.paused = false;
      if (this.playBehavior === "reject") return Promise.reject(new Error("autoplay"));
      if (this.playBehavior === "throw") throw new Error("NotAllowed");
      if (this.playBehavior === "undefined") return undefined;
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
    }
  }
  let mode: FakeAudio["playBehavior"] = "resolve";

  beforeEach(() => {
    mode = "resolve";
    vi.stubGlobal("Audio", FakeAudio);
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:test-url");
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays via objectURL, resolves done on ended, revokes the URL exactly once", async () => {
    const host = DOM_AUDIO_HOST;
    const pb = host.play(new Uint8Array([1, 2, 3]), "audio/mpeg");
    expect(lastAudio?.src).toBe("blob:test-url");
    expect((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ type: "audio/mpeg" });
    expect(lastAudio?.playCalls).toBe(1);

    let finished = false;
    void pb.done.then(() => (finished = true));
    lastAudio!.onended!(); // simulated native end
    await pb.done;
    expect(finished).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(lastAudio?.paused).toBe(false); // ended does not pause

    // Stop after end: guarded no-op — finish is idempotent.
    pb.stop();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("autoplay rejection finishes playback immediately (still resolvable)", async () => {
    mode = "reject";
    const pb = DOM_AUDIO_HOST.play(new Uint8Array([9]), "audio/mpeg");
    await expect(pb.done).resolves.toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("synchronous play() throw is contained", async () => {
    mode = "throw";
    const pb = DOM_AUDIO_HOST.play(new Uint8Array([9]), "audio/mpeg");
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("play() returning undefined (legacy engines) still completes via onended", async () => {
    mode = "undefined";
    const pb = DOM_AUDIO_HOST.play(new Uint8Array([7]), "audio/wav");
    let finished = false;
    void pb.done.then(() => (finished = true));
    expect(finished).toBe(false);
    lastAudio!.onended!();
    await pb.done;
    expect(finished).toBe(true);
  });

  it("stop() pauses and finishes; concurrent finishes collapse", async () => {
    const pb = DOM_AUDIO_HOST.play(new Uint8Array([5]), "audio/mpeg");
    expect(lastAudio?.paused).toBe(false);
    pb.stop();
    expect(lastAudio?.paused).toBe(true);
    await pb.done;
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    // Error callback after natural finish: no double-revoke.
    lastAudio!.onerror!();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});