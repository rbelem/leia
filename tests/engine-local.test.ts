import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEngine } from "../src/audio/engine-local";
import type { LocalCapabilities, LocalProfile } from "../src/audio/local-profiles";

// local-profiles imports the polyfill; its storage accesses are stubbed per
// test, but the module must load in node (mirrors settings.test.ts).
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
    },
  },
}));

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function rawResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError(`not json: ${body}`);
    },
    text: async () => body,
  } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface StubPlayback {
  stopCalls: number;
  done: Promise<void>;
  stop(): void;
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

const HEALTH_OK = (): Response => jsonResponse({ ok: true });
const CAPS_OK: LocalCapabilities = {
  wordTiming: true,
  voices: [
    { id: "v1", lang: "en", name: "Voice One" },
    { id: "v2", lang: "en", name: "Voice Two" },
  ],
};
const WORDS = [
  { begin: 0, end: 5, time_ms: 0 },
  { begin: 6, end: 12, time_ms: 457 },
];
const SYNC_OK = (words?: unknown[]): Response => jsonResponse({ audio_b64: btoa("RIFF"), ...(words ? { words } : {}) });

function makeProfile(port: number, id = `eng${port}`): LocalProfile {
  return { id, name: `Engine ${port}`, baseUrl: `http://127.0.0.1:${port}` };
}

interface LocalFetchHandlers {
  health?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  caps?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  synth?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

/** URL-routed fetch stub — probes and synthesize land by path, in any order. */
function makeLocalFetch(handlers: LocalFetchHandlers): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
  synthBodies: unknown[];
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const synthBodies: unknown[] = [];
  const route = (url: string, init?: RequestInit): Response | Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith("/leia/v1/health")) {
      if (!handlers.health) throw new Error(`unexpected health fetch: ${url}`);
      return handlers.health(url, init);
    }
    if (url.endsWith("/leia/v1/capabilities")) {
      if (!handlers.caps) throw new Error(`unexpected caps fetch: ${url}`);
      return handlers.caps(url, init);
    }
    if (url.endsWith("/leia/v1/synthesize")) {
      if (!handlers.synth) throw new Error(`unexpected synthesize fetch: ${url}`);
      if (init?.body) synthBodies.push(JSON.parse(String(init.body)));
      return handlers.synth(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    fetchImpl: (async (url: string, init?: RequestInit) => route(url, init)) as typeof fetch,
    calls,
    synthBodies,
  };
}

describe("LocalEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: probed voices → synthesize body/wav → start/word/end", async () => {
    const { fetchImpl, calls, synthBodies } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: () => SYNC_OK(WORDS),
    });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8880, "kokoro"), CAPS_OK, { fetchImpl, audioHost: host });

    expect(await engine.getVoices()).toEqual([
      { name: "Voice One", lang: "en", localService: true, family: "local-kokoro" },
      { name: "Voice Two", lang: "en", localService: true, family: "local-kokoro" },
    ]);
    expect(engine.family).toBe("local-kokoro");
    expect(engine.capabilities).toEqual({
      wordTiming: true,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: "v1", rate: 1.5 }));
    await vi.advanceTimersByTimeAsync(0); // cached probe → POST → play → start + 0ms word

    expect(host.played).toEqual([{ bytes: new Uint8Array([82, 73, 70, 70]), mime: "audio/wav" }]);
    expect(synthBodies).toEqual([{ text: "Hello world.", voice: "v1", rate: 1.5, format: "wav" }]);

    await vi.advanceTimersByTimeAsync(500); // second word at (457 − 0)ms
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "word", speakId: 7, begin: 6, end: 12 },
      { type: "end", speakId: 7 },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8880/leia/v1/health",
      "http://127.0.0.1:8880/leia/v1/capabilities",
      "http://127.0.0.1:8880/leia/v1/synthesize",
    ]);
  });

  it("words absent → no word events (sentence marching)", async () => {
    const { fetchImpl } = makeLocalFetch({ health: HEALTH_OK, caps: () => jsonResponse(CAPS_OK), synth: () => SYNC_OK() });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8881), CAPS_OK, { fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 1, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
  });

  it("offline (health 200 wrong body): getVoices [] and speak errors immediately, no synthesize", async () => {
    const { fetchImpl, calls } = makeLocalFetch({ health: () => jsonResponse({}) });
    const engine = new LocalEngine(makeProfile(8882), CAPS_OK, { fetchImpl, audioHost: makeHost() });

    expect(await engine.getVoices()).toEqual([]);
    const events = collect(engine.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "local server offline — check http://127.0.0.1:8882" },
    ]);
    expect(calls.filter((c) => c.url.endsWith("/synthesize"))).toHaveLength(0);
  });

  it("non-2xx → `${status} ${body}` error; body truncated at 200 chars", async () => {
    const { fetchImpl } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: () => jsonResponse({ error: "voice not found" }, 404),
    });
    const engine = new LocalEngine(makeProfile(8883), CAPS_OK, { fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: '404 {"error":"voice not found"}' },
    ]);

    // 500 with a 300-char body → message is "500 " + first 200 chars.
    const { fetchImpl: fetch2 } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: () => rawResponse("x".repeat(300), 500),
    });
    const engine2 = new LocalEngine(makeProfile(8891), CAPS_OK, { fetchImpl: fetch2, audioHost: makeHost() });
    const events2 = collect(engine2.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const [err] = (await events2) as Array<{ type: string; message: string }>;
    expect(err.type).toBe("error");
    expect(err.message).toBe(`500 ${"x".repeat(200)}`);
  });

  it("network reject → error event and profile marked offline NOW (getVoices [] without re-probe)", async () => {
    const { fetchImpl, calls } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: () => {
        throw new Error("connection refused");
      },
    });
    const engine = new LocalEngine(makeProfile(8884), CAPS_OK, { fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 5, message: "local server request failed: Error: connection refused" },
    ]);

    const callsAfterFailure = calls.length;
    expect(await engine.getVoices()).toEqual([]); // cached offline — no re-probe
    expect(calls.length).toBe(callsAfterFailure);
  });

  it("a new speak preempts: old stream cancelled, late response never plays", async () => {
    const held = deferred<Response>();
    const { fetchImpl } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        return body.text === "Alpha." ? held.promise : SYNC_OK();
      },
    });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8885), CAPS_OK, { fetchImpl, audioHost: host });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // A: probe + synth held
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // B: cached probe + synth + play + start

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    // A's response resolves AFTER the preempt — A must not start audio.
    held.resolve(SYNC_OK());
    await vi.advanceTimersByTimeAsync(500);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toHaveLength(1); // only B played
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("cancel stops audio, clears pending word timers, closes with cancelled", async () => {
    const { fetchImpl } = makeLocalFetch({ health: HEALTH_OK, caps: () => jsonResponse(CAPS_OK), synth: () => SYNC_OK(WORDS) });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8886), CAPS_OK, { fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 6, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // start + 0ms word fired; 457ms word pending

    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 6 },
      { type: "word", speakId: 6, begin: 0, end: 5 },
      { type: "cancelled", speakId: 6 },
    ]);
  });

  it("clamps rate to 0.5–2 and falls back voiceName → first voice id → default", async () => {
    const { fetchImpl, synthBodies } = makeLocalFetch({
      health: HEALTH_OK,
      caps: () => jsonResponse(CAPS_OK),
      synth: () => SYNC_OK(),
    });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8887), CAPS_OK, { fetchImpl, audioHost: host });

    const e1 = collect(engine.speak("x", 1, { voiceName: null, rate: 3 })); // > max
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e1;

    const e2 = collect(engine.speak("y", 2, { voiceName: "v2", rate: 0.1 })); // < min
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[1]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e2;

    // No usable voices → synthetic "default" voice id.
    const noVoices = new LocalEngine(makeProfile(8888), { wordTiming: true, voices: [] }, { fetchImpl, audioHost: host });
    const e3 = collect(noVoices.speak("z", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[2]?.finish();
    await vi.advanceTimersByTimeAsync(0);
    await e3;

    expect(synthBodies.map((b) => (b as { voice?: string; rate?: number }))).toEqual([
      { text: "x", voice: "v1", rate: 2, format: "wav" },
      { text: "y", voice: "v2", rate: 0.5, format: "wav" },
      { text: "z", voice: "default", rate: 1, format: "wav" },
    ]);
  });

  it("caps.wordTiming false → word events ignored even when present", async () => {
    const caps: LocalCapabilities = { wordTiming: false, voices: [{ id: "v1", lang: "en", name: "V1" }] };
    const { fetchImpl } = makeLocalFetch({ health: HEALTH_OK, caps: () => jsonResponse(caps), synth: () => SYNC_OK(WORDS) });
    const host = makeHost();
    const engine = new LocalEngine(makeProfile(8889, "piper"), caps, { fetchImpl, audioHost: host });

    expect(engine.family).toBe("local-piper");
    expect(engine.capabilities.wordTiming).toBe(false);

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // server sent words; wordTiming gate is off
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 5 },
      { type: "end", speakId: 5 },
    ]);
  });

  it("getVoices re-probes when the cached probe is older than 30s", async () => {
    const { fetchImpl, calls } = makeLocalFetch({ health: HEALTH_OK, caps: () => jsonResponse(CAPS_OK) });
    const engine = new LocalEngine(makeProfile(8890), CAPS_OK, { fetchImpl, audioHost: makeHost() });

    expect(await engine.getVoices()).toHaveLength(2);
    expect(await engine.getVoices()).toHaveLength(2); // cached
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(await engine.getVoices()).toHaveLength(2); // stale → re-probe, still online
    expect(calls).toHaveLength(4);
    expect(calls[2].url.endsWith("/leia/v1/health")).toBe(true);
  });
});