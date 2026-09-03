// SPDX-License-Identifier: MPL-2.0
/**
 * handleReaderStart (background) — the start reply must not voice-gate.
 * It used to `await s.voiceLang()` after s.start() (whose chunk-cap resolve
 * had ALREADY waited on the same voices poll), so on voiceless systems the
 * reply landed seconds after the highlight broadcasts and the bar bound its
 * highlighter only after every highlight had fired (pre-bind highlights are
 * no-ops). The reply now carries locale: null and no extra voices read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, VoiceInfo } from "../src/reader/contract";

const state = vi.hoisted(() => ({
  voices: [] as VoiceInfo[],
  voicesDelayMs: 0,
  getVoicesCalls: 0,
  /** Tabs returned by tabs.query (capture-path tests need a tab id). */
  activeTabs: [{ url: "https://example.test/article" }] as Array<{ id?: number; url: string }>,
  /** Controllable tabs.sendMessage for the capture fallback tests. */
  sendMessageImpl: (async () => ({})) as (...args: unknown[]) => Promise<unknown>,
  /** Controllable scripting.executeScript (capture re-injection). */
  executeScriptImpl: (async () => []) as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: {
      query: async () => state.activeTabs,
      sendMessage: async (...args: unknown[]) => state.sendMessageImpl(...args),
    },
    scripting: {
      executeScript: async (...args: unknown[]) => state.executeScriptImpl(...args),
    },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: { sendMessage: async () => ({}), onMessage: { addListener: () => {} } },
    alarms: { onAlarm: { addListener: () => {} }, create: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
  },
}));

vi.mock("../src/audio/owner", () => ({
  isChrome: () => false,
  audioClockMs: () => null,
  chromeAudioEngine: () => null,
  resolveAudioEngine: () => ({
    family: "web-speech",
    capabilities: { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" },
    getVoices: async () => {
      state.getVoicesCalls += 1;
      await new Promise((r) => setTimeout(r, state.voicesDelayMs));
      return state.voices;
    },
    // Never-ending stream: the drive loop just suspends, like the open
    // EventStream double in session-chunk-cap.test.ts.
    speak(): AsyncIterable<EngineEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {});
        },
      };
    },
    cancel: () => {},
  }),
}));

import { handleReaderStart } from "../src/background/index";

const TOKENS = ["First sentence.", "Second sentence."].map((text) => ({ text }));

describe("handleReaderStart (start reply must not voice-gate)", () => {
  beforeEach(() => {
    state.voices = [];
    state.voicesDelayMs = 0;
    state.getVoicesCalls = 0;
    state.activeTabs = [{ url: "https://example.test/article" }];
    state.sendMessageImpl = async () => ({});
    state.executeScriptImpl = async () => [];
  });

  it("replies immediately with locale null on a voiceless engine", async () => {
    state.voices = [];
    const reply = await handleReaderStart({ tokens: TOKENS });
    expect(reply.ok).toBe(true);
    expect(reply.replyType).toBe("leia:reader:start");
    const data = reply.data as {
      sessionId: string | null;
      state: string;
      locale: string | null;
      tokenCount: number;
      settings: { voiceName: string | null; rate: number; engine: string | null };
    };
    expect(data.locale).toBeNull(); // no voiceLang() in the reply path
    expect(data.state).toBe("playing");
    expect(data.sessionId).toBeTruthy();
    expect(data.tokenCount).toBe(2);
    expect(data.settings).toEqual({ voiceName: null, rate: 1, engine: null });
    // Exactly ONE voices read (the session's chunk-cap resolve) — the old
    // handler burned a second full poll before replying.
    expect(state.getVoicesCalls).toBe(1);
  });

  it("still replies with locale null when voices exist (locale never rides the reply)", async () => {
    state.voices = [{ name: "Zira", lang: "en-US", localService: true, family: "web-speech" }];
    const reply = await handleReaderStart({ tokens: TOKENS });
    expect(reply.ok).toBe(true);
    expect((reply.data as { locale: string | null }).locale).toBeNull();
    expect(state.getVoicesCalls).toBe(1);
  });
});

describe("handleReaderStart capture fallback (distinct failure reasons)", () => {
  beforeEach(() => {
    state.voices = [];
    state.voicesDelayMs = 0;
    state.activeTabs = [{ id: 7, url: "https://en.wikipedia.test/wiki/Chess" }];
    state.sendMessageImpl = async () => ({});
    state.executeScriptImpl = async () => [];
  });

  function captureReply(): Record<string, unknown> {
    return {
      ok: true,
      replyType: "leia:selection:capture",
      data: { captureId: 3, tokens: TOKENS },
    };
  }

  it("retries the capture after re-injecting the reader script when the tab does not answer", async () => {
    let captureCalls = 0;
    let injections = 0;
    state.sendMessageImpl = async (_tabId: unknown, msg: unknown) => {
      const m = msg as { type?: string };
      if (m.type !== "leia:selection:capture") return {};
      captureCalls += 1;
      return captureCalls === 1 ? undefined : captureReply();
    };
    state.executeScriptImpl = async (details: unknown) => {
      injections += 1;
      expect((details as { files?: string[] }).files).toEqual(["content/index.js"]);
      return [];
    };
    const reply = await handleReaderStart({});
    expect(reply.ok).toBe(true);
    expect((reply.data as { tokenCount: number }).tokenCount).toBe(2);
    expect(captureCalls).toBe(2); // first round unanswered → retry after injection
    expect(injections).toBe(1);
  });

  it("reports a distinct error when the reader script never responds even after re-injection", async () => {
    let injections = 0;
    state.sendMessageImpl = async (_tabId: unknown, msg: unknown) =>
      (msg as { type?: string }).type === "leia:selection:capture" ? undefined : {};
    state.executeScriptImpl = async () => {
      injections += 1;
      return [];
    };
    const reply = await handleReaderStart({});
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("reader script did not respond after re-injection — reload the page");
    expect(injections).toBe(1);
  });

  it("reports a distinct error when re-injection is impossible (e.g. restricted page)", async () => {
    state.sendMessageImpl = async (_tabId: unknown, msg: unknown) => {
      if ((msg as { type?: string }).type !== "leia:selection:capture") return {};
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    state.executeScriptImpl = async () => {
      throw new Error("Missing host permission for the tab");
    };
    const reply = await handleReaderStart({});
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("no leia reader script in this tab and re-injection failed");
    expect(reply.error).toContain("Could not establish connection");
  });

  it("relays the content script's capture-null reason verbatim (no injection attempted)", async () => {
    let injections = 0;
    state.sendMessageImpl = async (_tabId: unknown, msg: unknown) =>
      (msg as { type?: string }).type === "leia:selection:capture"
        ? { ok: false, replyType: "leia:selection:capture", error: "no selection; page is not readable (no article-like content)" }
        : {};
    state.executeScriptImpl = async () => {
      injections += 1;
      return [];
    };
    const reply = await handleReaderStart({});
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("no selection; page is not readable (no article-like content)");
    expect(injections).toBe(0);
  });

  it("keeps the no-active-tab guard for the tokenless path", async () => {
    state.activeTabs = [{ url: "https://en.wikipedia.test/wiki/Chess" }];
    const reply = await handleReaderStart({});
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("no active tab");
  });
});
