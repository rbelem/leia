// SPDX-License-Identifier: MPL-2.0
/**
 * Probe harness coverage (T2 spikes + kitten probe): chrome-apis accessors,
 * chrome.tts comparison probe, the Firefox event-page playback spike, the
 * offscreen speechSynthesis probe doc, and the kitten-local verification
 * probe — all driven against scripted browser/speech mocks (no network, no
 * real workers).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const h = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  sessionSets: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  replyListeners: [] as Array<
    (msg: unknown, sender?: unknown, sendResponse?: (r?: unknown) => void) => unknown
  >,
  alarmListeners: [] as Array<(alarm: { name: string }) => void>,
  alarmCreates: [] as Array<{ name: string; options: Record<string, unknown> }>,
  alarmsCreateReject: false,
  tts: null as { getVoices: (cb: (v: unknown[]) => void) => void; speak: (t: string, o?: unknown) => void } | null,
  offscreen: null as Record<string, unknown> | null,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => {
        h.sent.push(msg);
        return undefined;
      },
      onMessage: { addListener: (fn: (msg: unknown) => unknown) => h.replyListeners.push(fn) },
    },
    storage: {
      local: {
        get: async (key: string | string[]) =>
          Array.isArray(key)
            ? Object.fromEntries(key.map((k) => [k, h.storage[k]]))
            : { [key]: h.storage[key] },
        set: async (items: Record<string, unknown>) => {
          Object.assign(h.storage, items);
        },
      },
      session: {
        get: async (key: string | string[]) =>
          Array.isArray(key)
            ? Object.fromEntries(key.map((k) => [k, h.session[k]]))
            : { [key]: h.session[key] },
        set: async (items: Record<string, unknown>) => {
          Object.assign(h.session, items);
          h.sessionSets.push(items);
        },
      },
    },
    alarms: {
      create: async (name: string, options: Record<string, unknown>) => {
        if (h.alarmsCreateReject) throw new Error("alarms api unavailable");
        h.alarmCreates.push({ name, options });
      },
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => h.alarmListeners.push(fn) },
    },
    get tts(): unknown {
      return h.tts ?? undefined;
    },
    get offscreen(): unknown {
      return h.offscreen ?? undefined;
    },
  },
}));

// KittenEngine replaced wholesale: the probe must run without the real
// worker/ONNX stack, scripted per test via kittenState.script.
const kittenState = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  speakCalls: [] as Array<{ text: string; options: unknown }>,
  voiceCalls: 0,
}));

vi.mock("../src/audio/kitten/engine-kitten", () => ({
  KittenEngine: class {
    async getVoices() {
      kittenState.voiceCalls += 1;
      return [{ name: "kitten-nano", lang: "en-us", localService: true, family: "kitten-local" }];
    }
    async *speak(text: string, _speakId: number, options: unknown): AsyncIterable<Record<string, unknown>> {
      kittenState.speakCalls.push({ text, options });
      for (const ev of kittenState.script) yield ev;
    }
  },
}));

import { chromeOffscreen, chromeTts } from "../src/probes/chrome-apis";
import { handleTtsProbe } from "../src/probes/tts-probe";
import { handleKittenProbe } from "../src/probes/kitten-probe";

// --- speech API fakes ------------------------------------------------------

interface FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onboundary: ((e: { charIndex?: number; charLength?: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

const fakeUtterances: FakeUtterance[] = [];
const voiceChangedHandlers: Array<() => void> = [];
let synthVoices: unknown[] = [];
let speakTargets: FakeUtterance[] = [];
let cancelCalls = 0;

class FakeUtteranceImpl implements FakeUtterance {
  text: string;
  onstart: (() => void) | null = null;
  onboundary: ((e: { charIndex?: number; charLength?: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
    fakeUtterances.push(this);
  }
}

function stubSpeech(): void {
  synthVoices = [];
  speakTargets = [];
  cancelCalls = 0;
  voiceChangedHandlers.length = 0;
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtteranceImpl);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => synthVoices,
    speak: (u: FakeUtterance) => speakTargets.push(u),
    cancel: () => {
      cancelCalls += 1;
    },
    speaking: false,
    addEventListener: (_type: string, fn: () => void) => voiceChangedHandlers.push(fn),
    removeEventListener: (_type: string, fn: () => void) => {
      const i = voiceChangedHandlers.indexOf(fn);
      if (i >= 0) voiceChangedHandlers.splice(i, 1);
    },
  });
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  for (const k of Object.keys(h.storage)) delete h.storage[k];
  for (const k of Object.keys(h.session)) delete h.session[k];
  h.sessionSets.length = 0;
  h.sent.length = 0;
  h.replyListeners.length = 0;
  h.alarmListeners.length = 0;
  h.alarmCreates.length = 0;
  h.alarmsCreateReject = false;
  h.tts = null;
  h.offscreen = null;
  kittenState.script = [];
  kittenState.speakCalls.length = 0;
  kittenState.voiceCalls = 0;
  fakeUtterances.length = 0;
});

afterEach(() => {
  // End any probe run so its 5s heartbeat interval cannot leak into later tests.
  for (const u of fakeUtterances) u.onend?.();
  fakeUtterances.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- chrome-apis -----------------------------------------------------------

describe("chrome-apis accessors", () => {
  it("return the extension-namespaced API when present, undefined otherwise", () => {
    expect(chromeTts()).toBeUndefined();
    expect(chromeOffscreen()).toBeUndefined();
    const tts = { getVoices: () => {}, speak: () => {} };
    const off = { createDocument: async () => {} };
    h.tts = tts;
    h.offscreen = off;
    expect(chromeTts()).toBe(tts);
    expect(chromeOffscreen()).toBe(off);
  });
});

// --- tts-probe -------------------------------------------------------------

describe("chrome.tts probe", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reports absence of chrome.tts (Firefox / speech stack off)", async () => {
    const reply = await handleTtsProbe();
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("chrome.tts unavailable");
  });

  it("streams voices + events and resolves on the terminal event", async () => {
    h.tts = {
      getVoices: (cb) => cb([{ voiceName: "Google US English", lang: "en-US", remote: true }]),
      speak: (_text, options) => {
        const onEvent = (options as { onEvent: (ev: { type: string; charIndex?: number; charLength?: number }) => void })
          .onEvent;
        onEvent({ type: "start" });
        onEvent({ type: "boundary", charIndex: 0, charLength: 5 });
        onEvent({ type: "word", charIndex: 6, charLength: 5 });
        onEvent({ type: "end" });
      },
    };
    const reply = await handleTtsProbe();
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({
      final: "end",
      events: ["start@-/-", "boundary@0/5", "word@6/5", "end@-/-"],
      voices: ["Google US English"],
    });
  });

  it("interrupted and cancelled count as terminal, with the error message", async () => {
    h.tts = {
      getVoices: (cb) => cb([]),
      speak: (_text, options) => {
        (options as { onEvent: (ev: { type: string; errorMessage?: string }) => void }).onEvent({
          type: "cancelled",
          errorMessage: "superseded",
        });
      },
    };
    const reply = await handleTtsProbe();
    expect(reply.data).toMatchObject({ final: "cancelled", errorMessage: "superseded" });
  });

  it("a throwing speak() resolves as an exception, not a hang", async () => {
    h.tts = {
      getVoices: (cb) => cb([]),
      speak: () => {
        throw new Error("speak blew up");
      },
    };
    const reply = await handleTtsProbe();
    expect(reply.data).toMatchObject({ final: "exception" });
    expect((reply.data as { errorMessage: string }).errorMessage).toContain("speak blew up");
  });

  it("the 20s safety net fires when no terminal event arrives", async () => {
    h.tts = {
      getVoices: (cb) => cb([]),
      speak: (_text, options) => {
        (options as { onEvent: (ev: { type: string }) => void }).onEvent({ type: "start" });
      },
    };
    vi.useFakeTimers();
    const pending = handleTtsProbe();
    await vi.advanceTimersByTimeAsync(20_000);
    const reply = await pending;
    expect(reply.data).toMatchObject({ final: "timeout", events: ["start@-/-"] });
    vi.useRealTimers();
  });
});

// --- kitten-probe ----------------------------------------------------------

describe("kitten-local probe", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs one synthesis through the engine and reports ready/total timing", async () => {
    kittenState.script = [{ type: "start", speakId: 1 }, { type: "end", speakId: 1 }];
    const data = await handleKittenProbe();
    expect(kittenState.speakCalls).toHaveLength(1);
    expect(kittenState.speakCalls[0]!.text).toBe("Hello, I am Leia speaking on device.");
    expect(kittenState.speakCalls[0]!.options).toEqual({ voiceName: null, rate: 1 });
    expect(data.events).toEqual(["start"]);
    expect(data.readyMs).toBeGreaterThanOrEqual(0);
    expect(data.totalMs).toBeGreaterThanOrEqual(0);
    expect(data.error).toBeUndefined();
    expect(kittenState.voiceCalls).toBe(1);
  });

  it("forwards custom text and voice", async () => {
    kittenState.script = [{ type: "start", speakId: 1 }, { type: "end", speakId: 1 }];
    await handleKittenProbe("custom text", "kitten-nano");
    expect(kittenState.speakCalls[0]).toEqual({
      text: "custom text",
      options: { voiceName: "kitten-nano", rate: 1 },
    });
  });

  it("reports an engine error event with the message", async () => {
    kittenState.script = [{ type: "start", speakId: 1 }, { type: "error", speakId: 1, message: "model failed" }];
    const data = await handleKittenProbe();
    expect(data.error).toBe("model failed");
    expect(data.events).toEqual(["start"]);
  });

  it("a stream that ends without end/error reports the drop with readyMs unset", async () => {
    kittenState.script = [];
    const data = await handleKittenProbe();
    expect(data.error).toBe("stream ended without end/error");
    expect(data.readyMs).toBe(-1);
    expect(data.events).toEqual([]);
  });

  it("non-terminal events (cancelled) are ignored and still end without end", async () => {
    kittenState.script = [{ type: "start", speakId: 1 }, { type: "cancelled", speakId: 1 }];
    const data = await handleKittenProbe();
    expect(data.events).toEqual(["start"]);
    expect(data.error).toBe("stream ended without end/error");
    expect(data.readyMs).toBeGreaterThanOrEqual(0);
  });
});

// --- ff-playback -----------------------------------------------------------

describe("Firefox event-page playback probe", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  async function loadFf(): Promise<typeof import("../src/probes/ff-playback")> {
    vi.resetModules();
    h.alarmListeners.length = 0;
    return import("../src/probes/ff-playback");
  }

  it("refuses to run where speechSynthesis does not exist (Chrome SW)", async () => {
    const ff = await loadFf();
    const reply = ff.handleFfPlaybackProbe();
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("speechSynthesis unavailable");
  });

  it("starts a long utterance with heartbeat + handlers, reports started", async () => {
    stubSpeech();
    const ff = await loadFf();
    const reply = ff.handleFfPlaybackProbe();
    expect(reply).toEqual({ ok: true, replyType: "leia:ff-playback", data: { stage: "started" } });
    expect(fakeUtterances).toHaveLength(1);
    expect(fakeUtterances[0]!.text).toBe("This is a long read. ".repeat(200));
    expect(speakTargets).toHaveLength(1);
    expect(fakeUtterances[0]!.onstart).not.toBeNull();
    expect(fakeUtterances[0]!.onboundary).not.toBeNull();
    expect(fakeUtterances[0]!.onend).not.toBeNull();
    expect(fakeUtterances[0]!.onerror).not.toBeNull();
  });

  it("reports already-running while a probe is active", async () => {
    stubSpeech();
    const ff = await loadFf();
    ff.handleFfPlaybackProbe();
    const again = ff.handleFfPlaybackProbe();
    expect(again.data).toEqual({ stage: "already-running" });
    expect(fakeUtterances).toHaveLength(1);
  });

  it("persists onstart, counts boundaries (first five logged), and finishes on end", async () => {
    stubSpeech();
    const ff = await loadFf();
    vi.useFakeTimers();
    ff.handleFfPlaybackProbe();
    const u = fakeUtterances[0]!;
    u.onstart!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessionSets[0]![Object.keys(h.sessionSets[0]!)[0]]).toMatchObject({ active: true, boundaries: 0 });

    for (let i = 0; i < 7; i += 1) u.onboundary!({ charIndex: i * 3, charLength: 3 });
    const boundaryLogs = logSpy.mock.calls.filter((args) => String(args[0]).includes("boundary #")).length;
    expect(boundaryLogs).toBe(5); // only the first five logged individually

    u.onend!();
    await vi.advanceTimersByTimeAsync(0);
    const key = "leia:ff-playback";
    expect(h.session[key]).toMatchObject({ active: false, endReason: "end", boundaries: 7 });
    // Heartbeat interval is gone: advancing time writes nothing more.
    const setsAfterEnd = h.sessionSets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.sessionSets.length).toBe(setsAfterEnd);
    vi.useRealTimers();
  });

  it("finishes with an error reason on onerror", async () => {
    stubSpeech();
    const ff = await loadFf();
    ff.handleFfPlaybackProbe();
    fakeUtterances[0]!.onerror!({ error: "synthesis-failed" });
    await settle();
    expect(h.session["leia:ff-playback"]).toMatchObject({ active: false, endReason: "error:synthesis-failed" });
  });

  it("heartbeat writes every 5s while active", async () => {
    stubSpeech();
    const ff = await loadFf();
    vi.useFakeTimers();
    ff.handleFfPlaybackProbe();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sessionSets.length).toBeGreaterThanOrEqual(2); // start persist + one heartbeat
    vi.useRealTimers();
  });

  it("keepalive arms a 30s alarm and survives an arm failure", async () => {
    const ff = await loadFf();
    const reply = ff.handleFfPlaybackKeepalive();
    expect(reply).toEqual({
      ok: true,
      replyType: "leia:ff-playback-keepalive",
      data: { armed: true, periodMinutes: 0.5 },
    });
    expect(h.alarmCreates).toEqual([
      { name: "leia:ff-playback-kick", options: { periodInMinutes: 0.5 } },
    ]);

    h.alarmsCreateReject = true;
    const failed = ff.handleFfPlaybackKeepalive();
    expect(failed.data).toEqual({ armed: true, periodMinutes: 0.5 });
    await settle();
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("keepalive arm failed"))).toBe(true);
  });

  it("the alarm listener only reacts to its own alarm", async () => {
    await loadFf();
    h.alarmListeners[0]!({ name: "something-else" });
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("alarm kick"))).toBe(false);
    h.alarmListeners[0]!({ name: "leia:ff-playback-kick" });
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("alarm kick"))).toBe(true);
  });

  it("wake watchdog: an active run with a stale heartbeat reports suspension", async () => {
    stubSpeech();
    h.session["leia:ff-playback"] = {
      active: true,
      lastHb: Date.now() - 60_000,
      boundaries: 3,
    };
    await loadFf();
    await settle();
    const wakes = logSpy.mock.calls.filter((args) => String(args[0]).includes("wake: previous run still active"));
    expect(wakes).toHaveLength(1);
    expect(String(wakes[0]![0])).toContain("boundaries=3");
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("speechSynthesis.speaking=false"))).toBe(true);
  });

  it("wake watchdog: skips the speechSynthesis check where the API is absent", async () => {
    // Active run recorded, but this context has no speechSynthesis (e.g. a
    // Chrome SW replaying the session storage) — only the suspension line logs.
    h.session["leia:ff-playback"] = { active: true, lastHb: Date.now() - 60_000, boundaries: 1 };
    await loadFf();
    await settle();
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("wake: previous run still active"))).toBe(true);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("speechSynthesis.speaking"))).toBe(false);
  });

  it("wake watchdog: nothing stored stays silent", async () => {
    await loadFf();
    await settle();
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("wake:"))).toBe(false);
  });
});

// --- offscreen probe doc ---------------------------------------------------

describe("offscreen speechSynthesis probe doc", () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  async function loadOffscreen(): Promise<void> {
    vi.resetModules();
    h.replyListeners.length = 0;
    await import("../src/probes/offscreen");
  }

  /** Deliver one message through the messaging wrapper and read the reply. */
  async function reply(msg: unknown): Promise<{ handled: boolean; response?: unknown }> {
    const sendResponse = vi.fn();
    const handled = h.replyListeners[0]!(msg, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 0));
    return { handled: Boolean(handled), response: sendResponse.mock.calls[0]?.[0] };
  }

  function dispatch(msg: unknown): ReturnType<typeof vi.fn> {
    const sendResponse = vi.fn();
    expect(h.replyListeners[0]!(msg, {}, sendResponse)).toBe(true);
    return sendResponse;
  }

  it("ignores messages it does not own", async () => {
    stubSpeech();
    await loadOffscreen();
    expect(h.replyListeners[0]!("garbage")).toBe(false);
    expect(h.replyListeners[0]!({ type: "leia:audio:voices" })).toBe(false);
    expect(logSpy.mock.calls.some((args) => args[0] === "[leia offscreen] ready")).toBe(true);
  });

  it("probe-voices: sync-populated voices reported with local counts", async () => {
    stubSpeech();
    synthVoices = [
      { name: "Local Voice", lang: "en-US", localService: true },
      { name: "Remote Voice", lang: "en-GB", localService: false },
    ];
    await loadOffscreen();
    const { handled, response } = await reply({ type: "leia:probe-voices" });
    expect(handled).toBe(true);
    expect(response).toEqual({
      populatedSync: true,
      waitMs: 0,
      count: 2,
      localCount: 1,
      names: ["Local Voice (en-US, local=true)", "Remote Voice (en-GB, local=false)"],
    });
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: "leia:probe-result", probe: "voices" }),
    );
  });

  it("probe-voices: async population via voiceschanged (empty ticks keep waiting)", async () => {
    stubSpeech();
    await loadOffscreen();
    const sendResponse = dispatch({ type: "leia:probe-voices" });
    voiceChangedHandlers[0]!(); // fired while still empty — keep waiting
    await settle();
    expect(sendResponse).not.toHaveBeenCalled();
    synthVoices = [{ name: "Late Voice", lang: "en-US", localService: true }];
    voiceChangedHandlers[0]!();
    await settle();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ populatedSync: false, count: 1, names: ["Late Voice (en-US, local=true)"] }),
    );
  });

  it("probe-voices: the 1500ms fallback reports whatever is there", async () => {
    stubSpeech();
    await loadOffscreen();
    vi.useFakeTimers();
    const sendResponse = dispatch({ type: "leia:probe-voices" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ populatedSync: false, count: 0 }));
    vi.useRealTimers();
  });

  it("probe-speak: start/boundary/end stream results and resolve on end", async () => {
    stubSpeech();
    await loadOffscreen();
    const sendResponse = dispatch({ type: "leia:probe-speak" });
    expect(speakTargets).toHaveLength(1);
    expect(speakTargets[0]!.text).toBe("hello world, this is leia.");
    speakTargets[0]!.onstart!();
    speakTargets[0]!.onboundary!({ charIndex: 6, charLength: 5 });
    speakTargets[0]!.onend!();
    await settle();
    const data = sendResponse.mock.calls[0]![0] as { stage: string; elapsedMs: number; events: string[] };
    expect(data.stage).toBe("end");
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(data.events).toHaveLength(2);
    expect(data.events[0]).toMatch(/^start@\d+ms$/);
    expect(data.events[1]).toBe("boundary@6:5");
    const probes = h.sent.filter((m) => (m as { probe?: string }).probe).map((m) => (m as { probe: string }).probe);
    expect(probes).toEqual(["speak:start", "speak:boundary", "speak:end"]);
  });

  it("probe-speak: onerror resolves with the error stage", async () => {
    stubSpeech();
    await loadOffscreen();
    const sendResponse = dispatch({ type: "leia:probe-speak" });
    speakTargets[0]!.onerror!({ error: "interrupted" });
    await settle();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "error", error: "interrupted" }),
    );
  });

  it("probe-cancel cancels and answers synchronously", async () => {
    stubSpeech();
    await loadOffscreen();
    const { handled, response } = await reply({ type: "leia:probe-cancel" });
    expect(handled).toBe(true);
    expect(cancelCalls).toBe(1);
    expect(response).toEqual(expect.objectContaining({ stage: "canceled" }));
  });

  it("probe-kitten forwards to the kitten probe with voice defaulting to null", async () => {
    stubSpeech();
    kittenState.script = [{ type: "start", speakId: 1 }, { type: "end", speakId: 1 }];
    await loadOffscreen();
    const { response } = await reply({ type: "leia:probe-kitten" });
    expect(response).toMatchObject({ events: ["start"] });
    expect(kittenState.speakCalls[0]!.text).toBe("Hello, I am Leia speaking on device.");
    expect(kittenState.speakCalls[0]!.options).toEqual({ voiceName: null, rate: 1 });

    await reply({ type: "leia:probe-kitten", text: "short", voice: "kitten-nano" });
    expect(kittenState.speakCalls[1]!.text).toBe("short");
    expect(kittenState.speakCalls[1]!.options).toEqual({ voiceName: "kitten-nano", rate: 1 });
  });
});
