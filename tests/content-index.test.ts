// SPDX-License-Identifier: MPL-2.0
/**
 * content/index.ts — the content-script entry wiring: theme restore on load,
 * the reply-listener switch (page-info, capture, bind, highlight set/clear,
 * session state, theme set, router fallthrough), and the march/highlighter
 * glue (the local word march polls the background media clock only while a
 * bound session arms it; pause/stop disarm it).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Document with optional (deletable) caret-resolution APIs — lib.dom types
 * caretRangeFromPoint as a required method, which would block `delete`.
 */
type CaretDoc = Omit<Document, "caretRangeFromPoint" | "caretPositionFromPoint"> & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

const state = vi.hoisted(() => ({
  /** storage.local.get reply for the theme read (or throws when set). */
  theme: "ocean" as unknown,
  storageThrows: false,
  /** runtime.sendMessage calls leaving the page (stop/seek relays, clock polls). */
  sent: [] as Array<Record<string, unknown>>,
  /** runtime.onMessage listeners registered by imports of content/index. */
  listeners: [] as Array<(msg: unknown, sender: unknown, sendResponse?: (r?: unknown) => void) => unknown>,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: {
        get: async () => {
          if (state.storageThrows) throw new Error("storage dead");
          return { "leia:settings:theme": state.theme };
        },
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: {
      sendMessage: async (msg: Record<string, unknown>) => {
        state.sent.push(msg);
        // The march's clock poll: reply with a numeric media clock.
        return (msg as { type?: string }).type === "leia:audio:clock" ? { data: { clock: 500 } } : {};
      },
      onMessage: {
        addListener: (fn: (typeof state)["listeners"][number]) => void state.listeners.push(fn),
      },
    },
  },
}));

import { tokenIndexFromRange } from "../src/reader/token-index";

/** The most recently registered content-script reply listener. */
function listener(): (typeof state)["listeners"][number] {
  return state.listeners[state.listeners.length - 1]!;
}

/** Dispatch through the respond-only-if-handled wrapper; awaits the reply. */
async function dispatch(msg: unknown): Promise<{ handled: boolean; reply: unknown }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reply: unknown): void => {
      if (!done) {
        done = true;
        resolve({ handled: true, reply });
      }
    };
    const ret = listener()(msg, {}, (r?: unknown) => finish(r));
    // messaging.ts: undefined (sync) = unhandled; truthy = reply via sendResponse.
    if (ret === undefined || ret === false) {
      done = true;
      resolve({ handled: false, reply: undefined });
    }
  });
}

/** Minimal CSS Custom Highlight shim (jsdom lacks the registry). */
function installCaptureShim(): { last: Range[]; wordLast: Range[] | null; applied: number; deleted: string[] } {
  const shim = { last: [] as Range[], wordLast: null as Range[] | null, applied: 0, deleted: [] as string[] };
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      highlights: {
        set: (name: string, hl: unknown) => {
          shim.applied += 1;
          if (name === "leia-word") shim.wordLast = rangesOf(hl);
          else shim.last = rangesOf(hl);
        },
        delete: (name: string) => void shim.deleted.push(name),
      },
    },
  });
  (globalThis as unknown as { Highlight: unknown }).Highlight = class Highlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  };
  return shim;
}

function rangesOf(hl: unknown): Range[] {
  return ((hl as { ranges?: Range[] })?.ranges ?? []) as Range[];
}

function textScope(): { tokens: ReturnType<typeof tokenIndexFromRange>; ranges: Range[] } {
  document.body.innerHTML = "<p id='t'>Alpha sentence. Beta sentence.</p>";
  const el = document.getElementById("t")!;
  const range = document.createRange();
  range.selectNodeContents(el);
  const tokens = tokenIndexFromRange(range);
  return { tokens, ranges: tokens.map((t) => t.range) };
}

const TIMELINE = {
  words: [{ begin: 0, end: 5, t: 100 }],
  anchorWall: 1,
  anchorClock: 2,
};

/**
 * Select the fixture paragraph, run the capture + bind round trip, and
 * return the captureId. The selection path wins over the article fallback,
 * so no readability threshold is needed.
 */
async function captureBound(sessionId = "s1"): Promise<number> {
  const el = document.getElementById("t")!;
  const text = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.data.length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const cap = await dispatch({ type: "leia:selection:capture" });
  const captureId = (cap.reply as { data: { captureId: number } }).data.captureId;
  expect(captureId).toBeGreaterThan(0);
  await dispatch({ type: "leia:selection:bind", sessionId, captureId });
  return captureId;
}

describe("content script entry (content/index.ts)", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
    state.theme = "ocean";
    state.storageThrows = false;
    state.sent = [];
    // Keep only pre-existing listeners out of the way: fresh module → last wins.
  });

  it("restores the stored highlight theme on load", async () => {
    await import("../src/content/index");
    const { getTheme } = await import("../src/content/highlight");
    await new Promise((r) => setTimeout(r, 0)); // theme read is async
    expect(getTheme()).toBe("ocean");
    expect(document.getElementById("leia-highlight-style")).not.toBeNull(); // style injected on load
  });

  it("ignores a stored value that is not a theme id", async () => {
    state.theme = "neon-pink";
    await import("../src/content/index");
    const { getTheme } = await import("../src/content/highlight");
    await new Promise((r) => setTimeout(r, 0));
    expect(getTheme()).toBe("sun"); // default theme untouched
  });

  it("swallows a failing theme read (page load must not break)", async () => {
    state.storageThrows = true;
    await import("../src/content/index");
    const { getTheme } = await import("../src/content/highlight");
    await new Promise((r) => setTimeout(r, 0));
    expect(getTheme()).toBe("sun");
  });

  it("answers leia:page-info from the document", async () => {
    await import("../src/content/index");
    document.title = "Sample page";
    document.documentElement.lang = "pt-BR";
    document.body.innerHTML = "<p>Hello leia</p>";
    const { handled, reply } = await dispatch({ type: "leia:page-info" });
    expect(handled).toBe(true);
    expect(reply).toMatchObject({
      ok: true,
      replyType: "leia:page-info",
      data: { title: "Sample page", lang: "pt-BR", textLength: 10 },
    });
  });

  it("capture fails with a reason on an empty page", async () => {
    await import("../src/content/index");
    const { handled, reply } = await dispatch({ type: "leia:selection:capture" });
    expect(handled).toBe(true);
    expect(reply).toMatchObject({ ok: false, replyType: "leia:selection:capture" });
    expect((reply as { error?: string }).error).toContain("no selection");
  });

  it("capture returns the scope with a fresh captureId, and bind attaches it", async () => {
    const shim = installCaptureShim();
    await import("../src/content/index");
    textScope();

    // Select the first sentence so the capture has a scope.
    const el = document.getElementById("t")!;
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 0);
    range.setEnd(el.firstChild as Text, 16); // "Alpha sentence. "
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const cap = await dispatch({ type: "leia:selection:capture" });
    expect(cap.reply).toMatchObject({
      ok: true,
      replyType: "leia:selection:capture",
      data: { captureId: 1 },
    });
    const tokenCount = (cap.reply as { data: { tokens: unknown[] } }).data.tokens.length;
    expect(tokenCount).toBeGreaterThan(0);

    // Bind with the matching captureId: the highlighter now owns the session.
    const bind = await dispatch({ type: "leia:selection:bind", sessionId: "s1", captureId: 1, locale: "en" });
    expect(bind.reply).toMatchObject({ ok: true, replyType: "leia:selection:bind" });
    // highlight:set is fire-and-forget: the handler never claims the reply
    // channel (sync undefined), but the bound highlighter renders it.
    const show = await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 });
    expect(show.handled).toBe(false);
    expect(shim.applied).toBe(1); // bound: the highlight applied

    // A second capture (selection still live) bumps the pending id.
    const cap2 = await dispatch({ type: "leia:selection:capture" });
    expect((cap2.reply as { data: { captureId: number } }).data.captureId).toBe(2);
    sel.removeAllRanges();
  });

  it("bind with a stale captureId does not attach the scope", async () => {
    const shim = installCaptureShim();
    await import("../src/content/index");
    textScope();
    const el = document.getElementById("t")!;
    const text = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const cap = await dispatch({ type: "leia:selection:capture" });
    const captureId = (cap.reply as { data: { captureId: number } }).data.captureId;
    await dispatch({ type: "leia:selection:bind", sessionId: "s1", captureId: captureId + 999 });
    await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 });
    expect(shim.applied).toBe(0); // nothing bound
    sel.removeAllRanges();

    // A bind with no captureId and no pending scope is a harmless no-op.
    // (The stale bind above left the captured scope pending, so this orphan
    // bind attaches it to "s2"; a second orphan finds nothing pending.)
    const orphan = await dispatch({ type: "leia:selection:bind", sessionId: "s2" });
    expect(orphan.reply).toMatchObject({ ok: true, replyType: "leia:selection:bind" });
    const orphanAgain = await dispatch({ type: "leia:selection:bind", sessionId: "s3" });
    expect(orphanAgain.reply).toMatchObject({ ok: true, replyType: "leia:selection:bind" });
    await dispatch({ type: "leia:highlight:set", sessionId: "s2", from: 0, to: 0 });
    expect(shim.applied).toBe(1); // the orphan bind attached the pending scope
    await dispatch({ type: "leia:highlight:set", sessionId: "s3", from: 0, to: 0 });
    expect(shim.applied).toBe(1); // nothing was pending for "s3"
  });

  it("highlight:set with a timeline arms the local march; pause disarms it", async () => {
    installCaptureShim();
    await import("../src/content/index");
    textScope();
    await captureBound("s1");

    await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0, timeline: TIMELINE });
    // The march polls the background media clock at 250ms only while armed.
    await new Promise((r) => setTimeout(r, 300));
    expect(state.sent.some((m) => m.type === "leia:audio:clock")).toBe(true);

    // Any non-playing state halts the poll (pause/stop/seek must halt it).
    await dispatch({ type: "leia:session:state", status: { state: "paused" } });
    const polls = state.sent.filter((m) => m.type === "leia:audio:clock").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(state.sent.filter((m) => m.type === "leia:audio:clock").length).toBe(polls);
  });

  it("march stays armed while the session reports playing", async () => {
    installCaptureShim();
    await import("../src/content/index");
    textScope();
    await captureBound("s1");
    await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0, timeline: TIMELINE });
    await dispatch({ type: "leia:session:state", status: { state: "playing" } });
    const polls = state.sent.filter((m) => m.type === "leia:audio:clock").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(state.sent.filter((m) => m.type === "leia:audio:clock").length).toBeGreaterThan(polls);
    // Disarm so this test's poll interval doesn't leak into later tests.
    await dispatch({ type: "leia:session:state", status: { state: "paused" } });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("highlight:clear disarms the march and clears the binding", async () => {
    const shim = installCaptureShim();
    await import("../src/content/index");
    textScope();
    await captureBound("s1");
    await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0, timeline: TIMELINE });
    await new Promise((r) => setTimeout(r, 300));
    const polls = state.sent.filter((m) => m.type === "leia:audio:clock").length;
    expect(polls).toBeGreaterThan(0);

    await dispatch({ type: "leia:highlight:clear", sessionId: "s1" });
    expect(shim.deleted).toContain("leia-sentence");
    // Let any in-flight poll (fired before the clear) land, then confirm the
    // interval is really gone: well over one 250ms period without a new tick.
    await new Promise((r) => setTimeout(r, 50));
    const pollsAfterClear = state.sent.filter((m) => m.type === "leia:audio:clock").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(state.sent.filter((m) => m.type === "leia:audio:clock").length).toBe(pollsAfterClear); // march halted

    // The cleared session no longer renders highlights (the march's one
    // chunk re-show from the armed word clock happened pre-clear).
    const appliedBefore = shim.applied;
    await dispatch({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 });
    expect(shim.applied).toBe(appliedBefore);
  });

  it("relays leia:theme:set to the highlight theme (valid ids only)", async () => {
    await import("../src/content/index");
    const { getTheme } = await import("../src/content/highlight");
    await dispatch({ type: "leia:theme:set", theme: "berry" });
    expect(getTheme()).toBe("berry");
    await dispatch({ type: "leia:theme:set", theme: "nope" });
    expect(getTheme()).toBe("berry"); // invalid id ignored
  });

  it("stale-scope mutation relays leia:reader:stop; click-to-seek relays leia:reader:seek", async () => {
    await import("../src/content/index");
    textScope();
    await captureBound("s1");

    // Seek: jsdom resolves carets only through a stub — the handler never
    // intercepts the click's default behavior either way.
    const doc = document as CaretDoc;
    const el = document.getElementById("t")!;
    const caret = document.createRange();
    caret.setStart(el.firstChild as Text, 2);
    caret.collapse(true);
    doc.caretRangeFromPoint = () => caret;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    delete doc.caretRangeFromPoint;
    expect(state.sent.some((m) => m.type === "leia:reader:seek")).toBe(true);

    // Stale: a heavy SPA swap on the bound scope stops playback.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 30; i++) frag.appendChild(document.createElement("div"));
    el.appendChild(frag);
    await new Promise((r) => setTimeout(r, 20)); // MutationObserver callback
    expect(state.sent.some((m) => m.type === "leia:reader:stop")).toBe(true);
  });

  it("falls through to the shared router for its message types and ignores strangers", async () => {
    await import("../src/content/index");
    const pong = await dispatch({ type: "ping" });
    expect(pong.reply).toMatchObject({ ok: true, replyType: "pong" });
    const echo = await dispatch({ type: "echo", data: 42 });
    expect(echo.reply).toMatchObject({ ok: true, replyType: "echo", data: 42 });

    // Not a router message (no `type`): unhandled, channel not claimed.
    const stranger = await dispatch({ payload: true });
    expect(stranger.handled).toBe(false);

    // Router message of an unknown type: unhandled too.
    const unknown = await dispatch({ type: "leia:something:else" });
    expect(unknown.handled).toBe(false);
  });
});
