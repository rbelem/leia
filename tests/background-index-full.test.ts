// SPDX-License-Identifier: MPL-2.0
/**
 * background/index.ts — full message-surface coverage beyond the existing
 * keysnapshot/clock/reader-start suites:
 *  - probe dispatch (offscreen bootstrap incl. failure/retry, kitten FF vs
 *    Chrome, tts-probe, ff-playback);
 *  - audio dispatch (families with/without the engine seam, theme relay,
 *    audio:clock single-responder), page-info relay, triage fallthrough;
 *  - preview, prefs/status/voices;
 *  - the reader session lifecycle: start/park/restore (T16/T17), pause,
 *    stop, resume, seek, resume-info/clear, session event relays
 *    (state/highlight/word/timeline/error/clear);
 *  - the toggle-read keyboard shortcut;
 *  - capture-fallback re-injection edges;
 *  - key-snapshot enrichment filtering.
 *
 * The reader session is a module-level singleton, so the lifecycle tests run
 * as a deliberate sequence against a scripted engine (mutable per test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import browser from "webextension-polyfill";
import type { EngineEvent, SpeakOptions } from "../src/reader/contract";

interface ScriptedEngine {
  families?: () => unknown;
  selectFamily: (family: string) => void;
}

const state = vi.hoisted(() => ({
  /** Chrome vs Firefox (audio owner seam). */
  chrome: false,
  /** Scripted engine controls. */
  voices: [] as Array<{ name: string; lang: string; localService: boolean; family: string }>,
  wordTiming: false,
  script: null as null | ((speakId: number) => EngineEvent[]),
  /** After yielding the scripted events, the speak stream never settles. */
  hang: false,
  speakThrows: null as Error | null,
  speakErrorEvent: false,
  speakErrorMessage: "",
  familiesResult: [{ family: "web-speech" }] as unknown,
  selectFamilyCalls: [] as string[],
  speakCalls: [] as Array<{ text: string; speakId: number; options: SpeakOptions }>,
  clockValue: 777 as number | null,
  /** Set by resolveAudioEngine at import; the tests mutate it. */
  engine: undefined as ScriptedEngine | undefined,
  /** chromeAudioEngine proxy spy. */
  pushEventCalls: [] as unknown[],
  /** Browser mocks. */
  listeners: [] as Array<(msg: unknown, sender: unknown, sendResponse?: (r?: unknown) => void) => unknown>,
  activeTabs: [] as Array<{ id?: number; url?: string }>,
  tabs: [] as Array<{ id?: number; url?: string }>,
  tabSendCalls: [] as Array<{ tabId: unknown; msg: unknown }>,
  tabSendImpl: null as null | ((tabId: unknown, msg: unknown) => Promise<unknown>),
  runtimeSent: [] as Array<{ msg: unknown; rest: unknown[] }>,
  runtimeReply: undefined as unknown,
  runtimeSendThrows: false,
  offscreenCreate: null as null | ((opts: Record<string, unknown>) => Promise<void>),
  commands: [] as Array<(command: string) => void>,
  storageLocal: {} as Record<string, unknown>,
  storageLocalGetThrows: false,
  storageSession: {} as Record<string, unknown>,
  sessionSetThrows: false,
  /** Probe module results. */
  ttsProbeResult: { stage: "tts-ok" } as unknown,
  ffProbeResult: { stage: "ff-ok" } as unknown,
  ffKeepaliveResult: { stage: "keepalive-ok" } as unknown,
  kittenResult: { stage: "kitten-ok" } as unknown,
  kittenThrows: false,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: {
      query: async (opts: Record<string, unknown> | undefined) =>
        opts && "currentWindow" in opts ? state.activeTabs : state.tabs,
      sendMessage: async (tabId: unknown, msg: unknown) => {
        state.tabSendCalls.push({ tabId, msg });
        if (state.tabSendImpl) return state.tabSendImpl(tabId, msg);
        return {};
      },
    },
    scripting: {
      executeScript: async () => [],
    },
    storage: {
      session: {
        get: async (key?: unknown) => {
          if (typeof key === "string") return { [key]: state.storageSession[key] };
          return { ...state.storageSession };
        },
        set: async (items: Record<string, unknown>) => {
          if (state.sessionSetThrows) throw new Error("session storage dead");
          Object.assign(state.storageSession, items);
        },
        remove: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) delete state.storageSession[k];
        },
      },
      local: {
        get: async (keys?: unknown) => {
          if (state.storageLocalGetThrows) throw new Error("local storage dead");
          if (keys == null) return { ...state.storageLocal };
          if (typeof keys === "string") return { [keys]: state.storageLocal[keys] };
          const out: Record<string, unknown> = {};
          for (const k of keys as string[]) out[k] = state.storageLocal[k];
          return out;
        },
        set: async (items: Record<string, unknown>) => void Object.assign(state.storageLocal, items),
        remove: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) delete state.storageLocal[k];
        },
      },
    },
    runtime: {
      // The ORIGINAL sendMessage — background/index.ts wraps this on import.
      sendMessage: async (msg: unknown, ...rest: unknown[]) => {
        if (state.runtimeSendThrows) throw new Error("no receiving end");
        state.runtimeSent.push({ msg, rest });
        return state.runtimeReply;
      },
      onMessage: { addListener: (fn: (typeof state)["listeners"][number]) => void state.listeners.push(fn) },
    },
    commands: { onCommand: { addListener: (fn: (command: string) => void) => void state.commands.push(fn) } },
    offscreen: {
      createDocument: async (opts: Record<string, unknown>) => {
        if (!state.offscreenCreate) throw new Error("no offscreen stub for this test");
        return state.offscreenCreate(opts);
      },
    },
  },
}));

vi.mock("../src/audio/owner", async () => {
  const { EventStream } = await import("../src/reader/event-stream");
  return {
    isChrome: () => state.chrome,
    audioClockMs: () => state.clockValue,
    chromeAudioEngine: () => ({
      pushEvent: (ev: unknown) => void state.pushEventCalls.push(ev),
    }),
    resolveAudioEngine: () => {
      // One in-flight utterance; cancel closes its stream with `cancelled`
      // (the real engine contract the session's drive loop relies on).
      let current: { speakId: number; stream: InstanceType<typeof EventStream<EngineEvent>> } | null = null;
      const engine = {
        family: "web-speech",
        get capabilities() {
          return {
            wordTiming: state.wordTiming,
            streaming: false,
            costClass: "free" as const,
            privacyClass: "local" as const,
          };
        },
        getVoices: async () => state.voices,
        speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
          state.speakCalls.push({ text, speakId, options });
          if (state.speakThrows) {
            // Synchronous transport failure (handlePreview's catch path).
            const err = state.speakThrows;
            state.speakThrows = null;
            throw err;
          }
          const stream = new EventStream<EngineEvent>();
          if (state.speakErrorEvent) {
            // Engine reports failure as an error event instead of throwing.
            const message = state.speakErrorMessage;
            state.speakErrorEvent = false;
            stream.push({ type: "error", speakId, message });
            stream.close();
            return stream;
          }
          const prev = current;
          current = { speakId, stream };
          if (prev) prev.stream.closeCancelled({ type: "cancelled", speakId: prev.speakId });
          const events: EngineEvent[] = state.script
            ? state.script(speakId)
            : [{ type: "start", speakId }, { type: "end", speakId }];
          for (const ev of events) stream.push(ev);
          // Hang = audio "playing" mid-chunk: keep the stream open, but a
          // scripted terminal event always closes it (real engine contract).
          const terminal = events.some(
            (ev) => ev.type === "end" || ev.type === "error" || ev.type === "cancelled",
          );
          if (terminal || !state.hang) stream.close();
          return stream;
        },
        cancel: () => {
          const c = current;
          current = null;
          if (c) c.stream.closeCancelled({ type: "cancelled", speakId: c.speakId });
        },
        selectFamily: (family: string) => void state.selectFamilyCalls.push(family),
        families: () => state.familiesResult,
      };
      state.engine = engine;
      return engine;
    },
  };
});

vi.mock("../src/probes/tts-probe", () => ({
  handleTtsProbe: async () => state.ttsProbeResult,
}));
vi.mock("../src/probes/ff-playback", () => ({
  handleFfPlaybackProbe: async () => state.ffProbeResult,
  handleFfPlaybackKeepalive: async () => state.ffKeepaliveResult,
}));
vi.mock("../src/probes/kitten-probe", () => ({
  handleKittenProbe: async () => {
    if (state.kittenThrows) throw new Error("kitten model failed");
    return state.kittenResult;
  },
}));

import "../src/background/index"; // module under test: installs the wrap + reply listener + shortcut

const engine = state.engine as ScriptedEngine;

/** The reply-listener wrapper messaging.ts registered at import. */
function listener(): (typeof state)["listeners"][number] {
  return state.listeners[state.listeners.length - 1]!;
}

interface DispatchResult {
  handled: boolean;
  reply: unknown;
}

/**
 * Dispatch through the respond-only-if-handled wiring; awaits the reply.
 * messaging.ts holds the channel open (returns true) even when an async
 * handler resolves `undefined` (fire-and-forget) — those never deliver, so
 * wait a bounded settle window before reporting an empty reply.
 */
async function dispatch(msg: unknown, settleMs = 200): Promise<DispatchResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reply: unknown): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ handled: true, reply });
      }
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ handled: true, reply: undefined }); // channel held, nothing delivered
      }
    }, settleMs);
    const ret = listener()(msg, {}, finish);
    if (ret === false || ret === undefined) {
      done = true;
      clearTimeout(timer);
      resolve({ handled: false, reply: undefined });
    }
  });
}

function replyData<T>(result: DispatchResult): T {
  return (result.reply as { data: T }).data;
}

function replyError(result: DispatchResult): string {
  return (result.reply as { error?: string }).error ?? "";
}

/** Status via the router surface. */
interface SessionStatusView {
  state: string;
  tokenPos: number;
  tokenCount: number;
  url: string | null;
  lastError: string | null;
}

async function status(): Promise<SessionStatusView> {
  return replyData<SessionStatusView>(await dispatch({ type: "leia:reader:status" }));
}

const TOKENS_A = ["Alpha one.", "Beta two.", "Gamma three.", "Delta four."].map((text, i) => ({
  text,
  blockStart: true,
  ...(i === 1 ? { heading: true } : {}),
}));
const URL_U1 = "https://example.test/articles/one";

const startEvent = (speakId: number): EngineEvent => ({ type: "start", speakId });
const endEvent = (speakId: number): EngineEvent => ({ type: "end", speakId });

beforeEach(() => {
  // Baseline between tests; the module-level session deliberately persists.
  state.activeTabs = [];
  state.tabs = [];
  state.tabSendCalls = [];
  state.tabSendImpl = null;
  state.runtimeSent = [];
  state.runtimeReply = undefined;
  state.runtimeSendThrows = false;
  state.offscreenCreate = null;
  state.storageLocalGetThrows = false;
  state.sessionSetThrows = false;
  state.voices = [];
  state.wordTiming = false;
  state.script = null;
  state.hang = false;
  state.speakThrows = null;
  state.speakErrorEvent = false;
  state.speakErrorMessage = "";
  state.familiesResult = [{ family: "web-speech" }];
  state.clockValue = 777;
  state.kittenThrows = false;
  engine.families = () => state.familiesResult;
});

describe("probe dispatch (offscreen / kitten / tts / ff)", () => {
  beforeEach(() => {
    state.chrome = true;
  });

  it("bootstraps the offscreen document once: real errors retry, collisions are swallowed", async () => {
    // The bootstrap ready-promise is module-level, so this file's one fresh
    // chain exercises every branch in order: boom → retry → collision → reuse.
    let calls = 0;
    state.offscreenCreate = async (opts) => {
      calls += 1;
      if (calls === 1) {
        expect(opts).toMatchObject({ url: "probes/offscreen.html", reasons: ["AUDIO_PLAYBACK"] });
        throw new Error("offscreen boom");
      }
      if (calls === 2) throw new Error("Only a single offscreen document may be created");
    };
    const first = await dispatch({ type: "leia:probe-voices" });
    expect(first.reply).toMatchObject({ ok: false });
    expect(replyError(first)).toContain("offscreen boom");

    // The failure reset the ready promise: the next call retries, and a
    // manifest-created-document collision is swallowed (forward proceeds).
    const second = await dispatch({ type: "leia:probe-cancel" });
    expect(second.reply).toMatchObject({ ok: true, replyType: "leia:probe-cancel" });

    // Cached ready: no further createDocument calls, forward verbatim.
    state.runtimeReply = { voices: 3 };
    const third = await dispatch({ type: "leia:probe-voices" });
    expect(third.reply).toEqual({ ok: true, replyType: "leia:probe-voices", data: { voices: 3 } });
    expect(calls).toBe(2);
    expect(state.runtimeSent.at(-1)!.msg).toEqual({ type: "leia:probe-voices" });
  });

  it("reports a distinct failure when the offscreen API is unavailable", async () => {
    const offscreen = (browser as { offscreen?: unknown }).offscreen;
    delete (browser as { offscreen?: unknown }).offscreen;
    const r = await dispatch({ type: "leia:probe-speak" });
    (browser as { offscreen?: unknown }).offscreen = offscreen;
    expect(r.reply).toMatchObject({ ok: false, replyType: "leia:probe-speak" });
    expect(replyError(r)).toContain("offscreen API unavailable");
  });

  it("fails the probe when the forward send rejects", async () => {
    state.runtimeSendThrows = true;
    const r = await dispatch({ type: "leia:probe-voices" });
    expect(r.reply).toMatchObject({ ok: false });
    expect(replyError(r)).toContain("no receiving end");
  });

  it("runs the kitten probe in place on Firefox (voice given and omitted)", async () => {
    state.chrome = false;
    const withVoice = await dispatch({ type: "leia:probe-kitten", text: "hi", voice: "Kit" });
    expect(withVoice.reply).toEqual({ ok: true, replyType: "leia:probe-kitten", data: { stage: "kitten-ok" } });
    const withoutVoice = await dispatch({ type: "leia:probe-kitten", text: "hi" });
    expect(withoutVoice.reply).toMatchObject({ ok: true });
  });

  it("runs the kitten probe through the offscreen document on Chrome", async () => {
    state.chrome = true;
    state.offscreenCreate = async () => {};
    const r = await dispatch({ type: "leia:probe-kitten", text: "hi" });
    expect(r.reply).toEqual({ ok: true, replyType: "leia:probe-kitten", data: undefined });
    expect(state.runtimeSent).toHaveLength(1); // forwarded to the offscreen doc
  });

  it("surfaces kitten probe failures as a failed reply", async () => {
    state.chrome = false;
    state.kittenThrows = true;
    const r = await dispatch({ type: "leia:probe-kitten" });
    expect(r.reply).toMatchObject({ ok: false });
    expect(replyError(r)).toContain("kitten model failed");
  });

  it("dispatches the tts and ff-playback probes locally (probe payload passthrough)", async () => {
    state.chrome = false;
    const tts = await dispatch({ type: "leia:tts-probe" });
    expect(tts.reply).toEqual({ stage: "tts-ok" });
    const ff = await dispatch({ type: "leia:ff-playback" });
    expect(ff.reply).toEqual({ stage: "ff-ok" });
    const ka = await dispatch({ type: "leia:ff-playback-keepalive" });
    expect(ka.reply).toEqual({ stage: "keepalive-ok" });
  });
});

describe("audio dispatch, page-info relay, and triage fallthrough", () => {
  it("answers leia:audio:families from the engine seam when present", async () => {
    state.familiesResult = [{ family: "minimax", caps: true }];
    const r = await dispatch({ type: "leia:audio:families" });
    expect(r.reply).toEqual({
      ok: true,
      replyType: "leia:audio:families",
      data: [{ family: "minimax", caps: true }],
    });
  });

  it("answers leia:audio:families with the default single family without the seam", async () => {
    delete engine.families;
    const r = await dispatch({ type: "leia:audio:families" });
    expect(r.reply).toMatchObject({ ok: true, replyType: "leia:audio:families" });
    expect((r.reply as { data: Array<Record<string, unknown>> }).data[0].family).toBe("web-speech");
  });

  it("relays leia:theme:set to every tab, skipping tabless entries and send failures", async () => {
    state.tabs = [{ id: 1 }, {}, { id: 2 }];
    state.tabSendImpl = async (tabId) => {
      if (tabId === 1) throw new Error("tab gone");
      return {};
    };
    const r = await dispatch({ type: "leia:theme:set", theme: "ocean" });
    expect(r.reply).toEqual({ ok: true, replyType: "leia:theme:set" });
    expect(state.tabSendCalls).toHaveLength(2); // tabs 1 and 2, undefined id skipped
    expect(state.tabSendCalls.every((c) => (c.msg as { theme?: string }).theme === "ocean")).toBe(true);
  });

  it("stays silent on leia:audio:clock under Chrome (the offscreen doc owns it)", async () => {
    state.chrome = true;
    const r = await dispatch({ type: "leia:audio:clock" });
    expect(r.handled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10)); // no late reply either
  });

  it("answers leia:audio:clock through audioClockMs on Firefox", async () => {
    state.chrome = false;
    const r = await dispatch({ type: "leia:audio:clock" });
    expect(r.reply).toEqual({ ok: true, replyType: "leia:audio:clock", data: { clock: 777 } });
  });

  it("relays leia:page-info to the active tab, with distinct no-tab and send-failure errors", async () => {
    state.activeTabs = [{ id: 5, url: "https://x.test/" }];
    state.tabSendImpl = async (_tabId, msg) => ({ title: (msg as { type: string }).type });
    const ok = await dispatch({ type: "leia:page-info" });
    expect(ok.reply).toEqual({ ok: true, replyType: "leia:page-info", data: { title: "leia:page-info" } });

    state.activeTabs = [];
    const noTab = await dispatch({ type: "leia:page-info" });
    expect(noTab.reply).toMatchObject({ ok: false, error: "no active tab" });

    state.activeTabs = [{ id: 5, url: "https://x.test/" }];
    state.tabSendImpl = async () => {
      throw new Error("port closed");
    };
    const fail = await dispatch({ type: "leia:page-info" });
    expect(fail.reply).toMatchObject({ ok: false });
    expect(replyError(fail)).toContain("port closed");
  });

  it("routes leia:audio:event into the chrome audio engine and stays fire-and-forget", async () => {
    state.chrome = true;
    const event = { type: "end", speakId: 9 };
    const r = await dispatch({ type: "leia:audio:event", event });
    expect(r.handled).toBe(false); // sync triage never claims the channel
    expect(state.pushEventCalls).toEqual([event]);
  });

  it("logs leia:probe-result stream lines without replying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await dispatch({ type: "leia:probe-result", probe: "voices", data: 1 });
    expect(r.handled).toBe(false);
    expect(log).toHaveBeenCalledWith("[leia probe]", "voices", 1);
    log.mockRestore();
  });

  it("passes through shared-router types and ignores strangers and non-messages", async () => {
    const echo = await dispatch({ type: "echo", data: 7 });
    expect(echo.reply).toEqual({ ok: true, replyType: "echo", data: 7 });
    // Unknown router message: the async triage resolves undefined — the
    // channel is held open but nothing is ever delivered (fire-and-forget).
    const unknown = await dispatch({ type: "leia:nope" });
    expect(unknown.handled).toBe(true);
    expect(unknown.reply).toBeUndefined();
    const notRouter = await dispatch(42);
    expect(notRouter.handled).toBe(false);
  });
});

describe("preview, prefs, status, and voices", () => {
  it("previews the sample utterance through the shared engine (no family pin by default)", async () => {
    state.script = (speakId) => [startEvent(speakId), endEvent(speakId)];
    const r = await dispatch({ type: "leia:reader:preview", voiceName: "Zira" });
    expect(r.reply).toEqual({ ok: true, replyType: "leia:reader:preview" });
    const call = state.speakCalls.at(-1)!;
    expect(call.text).toBe("Hello, I am Leia.");
    expect(call.speakId).toBe(-1); // never collides with session speakIds
    expect(call.options).toEqual({ voiceName: "Zira", rate: 1 });
  });

  it("pins the preview family when given", async () => {
    state.script = (speakId) => [startEvent(speakId), endEvent(speakId)];
    await dispatch({ type: "leia:reader:preview", family: "minimax" });
    expect(state.selectFamilyCalls).toContain("minimax");
  });

  it("fails the preview when the engine reports an error event instead of throwing", async () => {
    state.speakErrorEvent = true;
    state.speakErrorMessage = "keyless family";
    const r = await dispatch({ type: "leia:reader:preview" });
    expect(r.reply).toEqual({ ok: false, replyType: "leia:reader:preview", error: "keyless family" });
  });

  it("substitutes a generic message for a messageless engine error event", async () => {
    state.speakErrorEvent = true;
    state.speakErrorMessage = "";
    const r = await dispatch({ type: "leia:reader:preview" });
    expect(r.reply).toEqual({ ok: false, replyType: "leia:reader:preview", error: "engine error" });
  });

  it("fails the preview when the engine speak throws", async () => {
    state.speakThrows = new Error("kaput");
    const r = await dispatch({ type: "leia:reader:preview" });
    expect(r.reply).toMatchObject({ ok: false, replyType: "leia:reader:preview" });
    expect(replyError(r)).toContain("kaput");
  });

  it("reports the (initially stopped) session status and the engine voices", async () => {
    expect(await status()).toMatchObject({ state: "stopped", tokenPos: 0 });
    state.voices = [{ name: "Zira", lang: "en-US", localService: true, family: "web-speech" }];
    const r = await dispatch({ type: "leia:reader:voices" });
    expect(replyData(r)).toHaveLength(1);
  });

  it("persists prefs and live-applies voice family / engine family", async () => {
    state.voices = [{ name: "Zira", lang: "en-US", localService: true, family: "web-speech" }];

    const rate = await dispatch({ type: "leia:reader:prefs", rate: 1.5 });
    expect(replyData<{ settings: { rate: number } }>(rate).settings.rate).toBe(1.5);
    expect(state.storageLocal["leia:reader:prefs"]).toMatchObject({ rate: 1.5 });

    await dispatch({ type: "leia:reader:prefs", voiceName: "Zira" });
    expect(state.storageLocal["leia:reader:prefs"]).toMatchObject({ voiceName: "Zira", engine: "web-speech" });

    await dispatch({ type: "leia:reader:prefs", engine: "minimax" });
    expect(state.selectFamilyCalls).toContain("minimax");

    const callsBefore = state.selectFamilyCalls.length;
    await dispatch({ type: "leia:reader:prefs", engine: null }); // null = engine default
    expect(state.selectFamilyCalls.slice(callsBefore)).toEqual([]);
  });
});

describe("reader session lifecycle (start / seek / pause / resume / restore / stop)", () => {
  function resumeKeys(): string[] {
    return Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:"));
  }

  function relayedTypes(): string[] {
    return state.runtimeSent.map((s) => (s.msg as { type: string }).type);
  }

  it("starts a session, emits state + highlights, and supports seek / pause / resume (T16/T17)", async () => {
    state.activeTabs = [{ id: 1, url: URL_U1 }];
    // speakId 1 finishes (drives past chunk 0); later speaks hang mid-chunk.
    state.script = (speakId) => (speakId <= 1 ? [startEvent(speakId), endEvent(speakId)] : [startEvent(speakId)]);
    state.hang = true;
    const r = await dispatch({ type: "leia:reader:start", tokens: TOKENS_A });
    expect(r.reply).toMatchObject({ ok: true, replyType: "leia:reader:start" });
    expect(replyData<{ state: string; tokenCount: number; locale: string | null }>(r)).toMatchObject({
      state: "playing",
      tokenCount: 4,
      locale: null,
    });

    // Session state + a chunk highlight were mirrored to the popup and tabs.
    await vi.waitFor(() => {
      expect(relayedTypes()).toContain("leia:highlight:set");
    });
    expect(relayedTypes()).toContain("leia:session:state");

    // Seek to token 2 while playing; wait for chunk 1 to finish first.
    await vi.waitFor(async () => {
      expect((await status()).tokenPos).toBe(1);
    });
    const seek = await dispatch({ type: "leia:reader:seek", token: 2 });
    expect(replyData(seek)).toMatchObject({ state: "playing", tokenPos: 2 });

    // Pause parks the position under the session URL (T16).
    const pause = await dispatch({ type: "leia:reader:pause" });
    expect(replyData(pause)).toMatchObject({ state: "paused", tokenPos: 2 });
    expect(resumeKeys()).toHaveLength(1);

    const resume = await dispatch({ type: "leia:reader:resume" });
    expect(replyData(resume)).toMatchObject({ state: "playing", tokenPos: 2 });
  });

  it("restores the parked position when the fresh scope still matches (T16/T17)", async () => {
    // The prior session (playing at token 2 from the previous test) parks
    // under its URL; the fresh scope still matches at that point. Scripted
    // hang keeps the new session alive for the following tests.
    state.activeTabs = [{ id: 1, url: URL_U1 }];
    state.script = (speakId) => [startEvent(speakId)];
    state.hang = true;
    const restart = await dispatch({ type: "leia:reader:start", tokens: TOKENS_A });
    expect(replyData(restart)).toMatchObject({ tokenPos: 2, state: "playing" });
  });

  it("degrades to the top when the parked token no longer matches, keeping the record", async () => {
    state.activeTabs = [{ id: 1, url: URL_U1 }];
    state.script = (speakId) => [startEvent(speakId)];
    state.hang = true;
    const mismatch = TOKENS_A.map((t, i) => ({ text: i === 2 ? "Different third." : t.text, blockStart: true }));
    const degraded = await dispatch({ type: "leia:reader:start", tokens: mismatch });
    expect(replyData(degraded)).toMatchObject({ tokenPos: 0 });
    // The strict one-token compare leaves the stored record untouched.
    expect(
      replyData<{ tokenPos: number }>(await dispatch({ type: "leia:reader:resume-info", url: URL_U1 })),
    ).toMatchObject({ tokenPos: 2 });
  });

  it("carries resume-info for a parked record and null otherwise", async () => {
    const rec = replyData<{ url: string; tokenPos: number; tokenCount: number } | null>(
      await dispatch({ type: "leia:reader:resume-info", url: URL_U1 }),
    );
    expect(rec).toMatchObject({ url: URL_U1, tokenCount: 4 });

    expect(replyData(await dispatch({ type: "leia:reader:resume-info" }))).toBeNull(); // no url given
    expect(replyData(await dispatch({ type: "leia:reader:resume-info", url: "https://other.test/" }))).toBeNull();
  });

  it("stops with a park-before-clear (the resume record survives stop)", async () => {
    const stop = await dispatch({ type: "leia:reader:stop" });
    expect(replyData(stop)).toMatchObject({ state: "stopped" });
    expect(relayedTypes()).toContain("leia:highlight:clear");
    expect(relayedTypes()).toContain("leia:session:state");
    expect(
      replyData<{ url: string; tokenPos: number } | null>(
        await dispatch({ type: "leia:reader:resume-info", url: URL_U1 }),
      ),
    ).toMatchObject({ url: URL_U1 });
  });

  it("emits word and timeline highlights only for word-timing engines", async () => {
    state.wordTiming = true;
    state.script = (speakId) => [
      startEvent(speakId),
      { type: "word", speakId, begin: 0, end: 4 },
      { type: "timeline", speakId, words: [{ begin: 0, end: 4, t: 0 }], anchorWall: 1, anchorClock: 2 },
      endEvent(speakId),
    ];
    const r = await dispatch({ type: "leia:reader:start", tokens: [{ text: "Solo sentence." }] });
    expect(r.reply).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("stopped"); // single chunk played out
    });
    const highlights = state.runtimeSent
      .map((s) => s.msg as { type: string; word?: unknown; timeline?: unknown })
      .filter((m) => m.type === "leia:highlight:set");
    expect(highlights.some((m) => "word" in m)).toBe(true);
    expect(highlights.some((m) => "timeline" in m)).toBe(true);
  });

  it("keeps plain chunk highlights for engines without word timing (word events ignored)", async () => {
    state.wordTiming = false;
    state.script = (speakId) => [startEvent(speakId), { type: "word", speakId, begin: 0, end: 4 }, endEvent(speakId)];
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "Plain sentence." }] });
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("stopped");
    });
    const highlights = state.runtimeSent
      .map((s) => s.msg as { type: string; word?: unknown; timeline?: unknown })
      .filter((m) => m.type === "leia:highlight:set");
    expect(highlights).toHaveLength(1); // start-driven only
    expect("word" in highlights[0]).toBe(false);
    expect("timeline" in highlights[0]).toBe(false);
  });

  it("parks the session as paused with a surfaced error when the engine fails (T17)", async () => {
    state.script = (speakId) => [startEvent(speakId), { type: "error", speakId, message: "engine kaput" }];
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "Doomed sentence." }] });
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("paused");
    });
    expect((await status()).lastError).toBe("engine kaput");
    expect(relayedTypes()).toContain("leia:session:error");

    // Resume retries the failed chunk from the parked position.
    state.script = null; // default start/end → completes
    const resume = await dispatch({ type: "leia:reader:resume" });
    expect(replyData(resume)).toMatchObject({ state: "playing" });
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("stopped");
    });
    expect((await status()).lastError).toBeNull();
  });

  it("clears a resume record and tolerates clearing without a url", async () => {
    expect((await dispatch({ type: "leia:reader:resume-clear", url: URL_U1 })).reply).toMatchObject({ ok: true });
    expect(replyData(await dispatch({ type: "leia:reader:resume-info", url: URL_U1 }))).toBeNull();
    expect((await dispatch({ type: "leia:reader:resume-clear" })).reply).toMatchObject({ ok: true });
  });

  it("parks nothing when neither the session nor the tab knows a URL", async () => {
    state.hang = true;
    state.script = (speakId) => [startEvent(speakId)]; // hang immediately
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "No url sentence." }] });
    expect((await status()).url).toBeNull();
    const before = resumeKeys().length;
    await dispatch({ type: "leia:reader:pause" });
    expect(resumeKeys().length).toBe(before);
    await dispatch({ type: "leia:reader:stop" });
  });

  it("answers failed reader ops when session storage dies", async () => {
    state.hang = true;
    state.script = (speakId) => [startEvent(speakId)];
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "Storage doom." }] });
    state.sessionSetThrows = true;
    const pause = await dispatch({ type: "leia:reader:pause" });
    expect(pause.reply).toMatchObject({ ok: false, replyType: "leia:reader:pause" });
    const seek = await dispatch({ type: "leia:reader:seek", token: 0 });
    expect(seek.reply).toMatchObject({ ok: false, replyType: "leia:reader:seek" });
    state.sessionSetThrows = false;
    await dispatch({ type: "leia:reader:stop" });
  });

  it("returns the empty-scope error through the start catch when a capture yields no tokens", async () => {
    state.activeTabs = [{ id: 7, url: "https://empty.test/" }];
    state.tabSendImpl = async (_tabId, msg) =>
      (msg as { type: string }).type === "leia:selection:capture"
        ? { ok: true, replyType: "leia:selection:capture", data: { captureId: 1, tokens: [] } }
        : {};
    const r = await dispatch({ type: "leia:reader:start" });
    expect(r.reply).toMatchObject({ ok: false, replyType: "leia:reader:start" });
    expect(replyError(r)).toContain("empty read scope");
  });
});

describe("toggle-read keyboard shortcut", () => {
  it("ignores other commands", async () => {
    state.commands[0]!("volume-up");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await status()).state).toBe("stopped");
  });

  it("starts via the capture fallback when stopped, then toggles pause and resume", async () => {
    // Stopped + no active tab: the missing selection stays a silent no-op.
    state.activeTabs = [];
    state.commands[0]!("toggle-read");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await status()).state).toBe("stopped");

    // Start (hung stream keeps it playing), then toggle to pause and back.
    state.activeTabs = [{ id: 1, url: "https://toggle.test/" }];
    state.hang = true;
    state.script = (speakId) => [startEvent(speakId)];
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "Toggle sentence." }] });
    expect((await status()).state).toBe("playing");

    state.commands[0]!("toggle-read");
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("paused");
    });
    state.commands[0]!("toggle-read");
    await vi.waitFor(async () => {
      expect((await status()).state).toBe("playing");
    });
  });
});

describe("capture fallback re-injection edges", () => {
  it("reports the no-re-injection error when browser.scripting is unavailable", async () => {
    state.activeTabs = [{ id: 7, url: "https://plain.test/" }];
    state.tabSendImpl = async (_tabId, msg) =>
      (msg as { type: string }).type === "leia:selection:capture" ? undefined : {};
    const scripting = (browser as { scripting?: unknown }).scripting;
    delete (browser as { scripting?: unknown }).scripting;
    const r = await dispatch({ type: "leia:reader:start" });
    (browser as { scripting?: unknown }).scripting = scripting;
    expect(r.reply).toMatchObject({ ok: false });
    expect(replyError(r)).toContain("tab not injectable");
  });

  it("starts without a URL when the active tab carries none, then parks under the next tab's URL", async () => {
    state.activeTabs = [{ id: 3 }]; // no url
    state.hang = true;
    state.script = (speakId) => [startEvent(speakId)];
    const r = await dispatch({ type: "leia:reader:start", tokens: [{ text: "Anonymous sentence." }] });
    expect(replyData(r)).toMatchObject({ state: "playing", url: null });

    // Pausing now has no URL to park under (neither session nor tab).
    const before = Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:")).length;
    await dispatch({ type: "leia:reader:pause" });
    expect(Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:")).length).toBe(before);

    // Restart with a URL-carrying active tab: the prior.url-less session
    // parks under the TAB's URL instead.
    const nextUrl = "https://tabs-url.test/page";
    state.activeTabs = [{ id: 3, url: nextUrl }];
    state.script = (speakId) => [startEvent(speakId)];
    await dispatch({ type: "leia:reader:start", tokens: [{ text: "Another sentence." }] });
    await dispatch({ type: "leia:reader:pause" });
    expect(
      Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:")).length,
    ).toBe(before + 1);
    await dispatch({ type: "leia:reader:stop" });

    // Pause on a stopped session: no snapshot → nothing parked (defensive).
    const afterStop = Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:")).length;
    await dispatch({ type: "leia:reader:pause" });
    expect(Object.keys(state.storageLocal).filter((k) => k.startsWith("leia:resume:")).length).toBe(afterStop);
  });
});

describe("key-snapshot enrichment filtering", () => {
  it("drops empty-string keys and non-array local profiles from the snapshot", async () => {
    state.storageLocal["leia:settings:minimaxKey"] = "";
    state.storageLocal["leia:settings:localProfiles"] = "not-an-array";
    await browser.runtime.sendMessage({ type: "leia:audio:speak", speakId: 1 });
    expect(state.runtimeSent).toHaveLength(1);
    const msg = state.runtimeSent[0].msg as Record<string, unknown>;
    expect(msg.type).toBe("leia:audio:speak");
    expect(msg.keys).toEqual({}); // empty value filtered out
    expect("localProfiles" in msg).toBe(false);
  });

  it("filters null profile entries and keeps a valid profile alongside them", async () => {
    state.storageLocal["leia:settings:openaiKey"] = "sk-test";
    state.storageLocal["leia:settings:localProfiles"] = [
      null,
      { id: "p1", name: "Local One", baseUrl: "http://127.0.0.1:9000" },
      { id: 7, name: "Bad", baseUrl: "http://127.0.0.1:9001" }, // non-string id
    ];
    await browser.runtime.sendMessage({ type: "leia:audio:speak", speakId: 2 });
    const msg = state.runtimeSent[0].msg as Record<string, unknown>;
    expect(msg.keys).toEqual({ "leia:settings:openaiKey": "sk-test" });
    expect(msg.localProfiles).toEqual([{ id: "p1", name: "Local One", baseUrl: "http://127.0.0.1:9000" }]);
  });

  it("omits localProfiles entirely when the stored list is empty", async () => {
    state.storageLocal["leia:settings:openaiKey"] = "sk-test";
    state.storageLocal["leia:settings:localProfiles"] = [];
    await browser.runtime.sendMessage({ type: "leia:audio:speak", speakId: 3 });
    const msg = state.runtimeSent[0].msg as Record<string, unknown>;
    expect(msg.keys).toEqual({ "leia:settings:openaiKey": "sk-test" });
    expect("localProfiles" in msg).toBe(false);
  });
});
