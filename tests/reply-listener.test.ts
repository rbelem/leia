// SPDX-License-Identifier: MPL-2.0
/**
 * Regression (live-proven in Chrome): an `async` onMessage listener ALWAYS
 * claims the reply channel — webextension-polyfill@0.12.0 forwards even a
 * resolved `undefined` — so every context that registered an async listener
 * answered every runtime message and hijacked replies with null/undefined
 * (the offscreen doc nulling out popup/SW traffic while alive). Listeners
 * are now registered through addReplyListener (src/messaging.ts): the
 * handler triages synchronously — `undefined` means "not mine" (sync `false`,
 * no reply at all), any value or Promise is delivered via sendResponse
 * (`return true`). These tests pin the helper contract and the two
 * reply-critical sites (content router, offscreen audio).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineFamilyInfo } from "../src/audio/hub";

type ReplyListener = (msg: unknown, sender: unknown, sendResponse?: (response?: unknown) => void) => unknown;

const state = vi.hoisted(() => ({
  listeners: [] as ReplyListener[],
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: (fn: ReplyListener) => state.listeners.push(fn) },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  },
}));

/** Fresh module load per test; returns the captured onMessage listener. */
async function loadListener(module: string): Promise<ReplyListener> {
  vi.resetModules();
  state.listeners = [];
  await import(module);
  return state.listeners[0];
}

/** Invoke a registered wrapper with a fresh sendResponse spy. */
function deliver(listener: ReplyListener, msg: unknown) {
  const sendResponse = vi.fn();
  const keepOpen = listener(msg, {}, sendResponse);
  return { sendResponse, keepOpen };
}

/** Register a handler on a clean fake runtime; returns the captured wrapper. */
async function register(handler: (msg: unknown) => unknown): Promise<ReplyListener> {
  state.listeners = [];
  const { addReplyListener } = await import("../src/messaging");
  addReplyListener(handler);
  return state.listeners[0];
}

/** Flush the wrapper's Promise.resolve(...).then delivery to sendResponse. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("addReplyListener (respond-only-if-handled contract)", () => {
  beforeEach(() => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [{ voiceURI: "v", name: "System Voice", lang: "en-US", localService: true, default: true }],
      speak: () => {},
      cancel: () => {},
    });
    // jsdom lacks the utterance ctor; a no-op class keeps the (void'd)
    // streaming arm of leia:audio:speak from rejecting unhandled.
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        onstart: unknown;
        onboundary: unknown;
        onend: unknown;
        onerror: unknown;
        rate = 1;
        voice: unknown = null;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no loopback servers in tests");
      }),
    );
  });

  it("unhandled message: returns false synchronously and sendResponse is never called", async () => {
    const { sendResponse, keepOpen } = deliver(await register(() => undefined), { type: "leia:unknown-to-this-context" });
    expect(keepOpen).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("sync handled message: returns true and sendResponse(value)", async () => {
    const reply = { ok: true, replyType: "leia:sync" };
    const { sendResponse, keepOpen } = deliver(await register(() => reply), { type: "leia:sync" });
    expect(keepOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(reply);
  });

  it("Promise handled message: returns true and sendResponse(resolved value)", async () => {
    const reply = { ok: false, replyType: "leia:async", error: "later" };
    const { sendResponse, keepOpen } = deliver(await register(() => Promise.resolve(reply)), { type: "leia:async" });
    expect(keepOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(reply);
  });

  it("Promise resolving undefined: channel held open but sendResponse never called", async () => {
    const { sendResponse, keepOpen } = deliver(await register(() => Promise.resolve(undefined)), {
      type: "leia:fire-and-forget",
    });
    expect(keepOpen).toBe(true);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe("reply-critical sites respond only for their own messages", () => {
  beforeEach(() => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [{ voiceURI: "v", name: "System Voice", lang: "en-US", localService: true, default: true }],
      speak: () => {},
      cancel: () => {},
    });
    // jsdom lacks the utterance ctor; a no-op class keeps the (void'd)
    // streaming arm of leia:audio:speak from rejecting unhandled.
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        onstart: unknown;
        onboundary: unknown;
        onend: unknown;
        onerror: unknown;
        rate = 1;
        voice: unknown = null;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no loopback servers in tests");
      }),
    );
  });

  it("content router: leia:page-info replies via sendResponse (no longer Promise-returning)", async () => {
    const listener = await loadListener("../src/content/index");
    document.title = "Regression page";
    const { sendResponse, keepOpen } = deliver(listener, { type: "leia:page-info" });
    expect(keepOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        replyType: "leia:page-info",
        data: expect.objectContaining({ title: "Regression page", url: "https://example.test/" }),
      }),
    );
  });

  it("content router: a message it does not handle gets sync `false`, no sendResponse", async () => {
    const listener = await loadListener("../src/content/index");
    for (const msg of [42, { type: "leia:probe-speak" }, { type: "leia:none" }]) {
      const { sendResponse, keepOpen } = deliver(listener, msg);
      expect(keepOpen).toBe(false);
      await flush();
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });

  it("offscreen audio: sync plain-return arm (cancel) replies via sendResponse", async () => {
    const listener = await loadListener("../src/offscreen/audio");
    const { sendResponse, keepOpen } = deliver(listener, { type: "leia:audio:cancel" });
    expect(keepOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("offscreen audio: streaming arm (speak) claims no channel — sync `false`, no reply", async () => {
    const listener = await loadListener("../src/offscreen/audio");
    const { sendResponse, keepOpen } = deliver(listener, { type: "leia:audio:speak", speakId: 1, text: "hi", voiceName: null, rate: 1 });
    expect(keepOpen).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("offscreen audio: families arm still delivers its payload via sendResponse", async () => {
    const listener = await loadListener("../src/offscreen/audio");
    const { sendResponse, keepOpen } = deliver(listener, { type: "leia:audio:families" });
    expect(keepOpen).toBe(true);
    await flush();
    const families = sendResponse.mock.calls[0][0] as EngineFamilyInfo[];
    expect(Array.isArray(families)).toBe(true);
    expect(families.some((f) => f.family === "web-speech")).toBe(true);
  });
});
