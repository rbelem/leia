// SPDX-License-Identifier: MPL-2.0
/**
 * Floating bar coverage: mount/unmount via the storage surface flag, the
 * transport buttons, the Play loading state machine, drag/click suppression,
 * the bar's reply-listener cases, and the word march lifecycle. The page
 * capture seam (content/scope) is mocked so the bar is driven deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../src/reader/session";
import { CONTROLS_IN_PAGE_KEY } from "../src/controls";

interface HighlighterFake {
  opts: { onStale?: () => void; onSeek?: (t: number) => void };
  bind: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  handlers: {} as Record<string, (msg: Record<string, unknown>) => unknown>,
  failTypes: [] as string[],
  sent: [] as Array<Record<string, unknown>>,
  replyListeners: [] as Array<
    (msg: unknown, sender?: unknown, sendResponse?: (r?: unknown) => void) => unknown
  >,
  changeListeners: [] as Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>,
  capture: null as null | { tokens: Array<{ text: string }>; ranges: Range[] },
  instances: [] as HighlighterFake[],
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: (msg: Record<string, unknown>) => {
        h.sent.push(msg);
        if (h.failTypes.includes(String(msg.type))) return Promise.reject(new Error("send failed"));
        const handle = h.handlers[String(msg.type)];
        return Promise.resolve(handle ? handle(msg) : undefined);
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
      onChanged: {
        addListener: (fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) =>
          h.changeListeners.push(fn),
      },
    },
  },
}));

vi.mock("../src/content/scope", () => ({
  captureScope: () => h.capture,
  ScopeHighlighter: class {
    opts: { onStale?: () => void; onSeek?: (t: number) => void };
    bind = vi.fn();
    show = vi.fn();
    clear = vi.fn();
    hasSession = vi.fn(() => false);
    constructor(opts: { onStale?: () => void; onSeek?: (t: number) => void }) {
      this.opts = opts;
      h.instances.push(this as unknown as HighlighterFake);
    }
  },
}));

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const bar = (): HTMLElement => q("leia-floating-bar");
const play = (): HTMLButtonElement => q("leia-cmd-play");

const makeStatus = (over: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId: "s1",
  state: "stopped",
  tokenPos: 0,
  tokenCount: 0,
  settings: { voiceName: null, rate: 1, engine: null },
  ...over,
});

const okReply = (data: unknown) => ({ ok: true, replyType: "x", data });
const errReply = (error: string) => ({ ok: false, replyType: "x", error });

const lastHighlighter = (): HighlighterFake => h.instances[h.instances.length - 1]!;
const broadcast = (msg: unknown): unknown => h.replyListeners[0]!(msg);

async function loadBar(): Promise<void> {
  vi.resetModules();
  await import("../src/floating-bar/index");
  await settle();
}

const setSurface = (value: unknown, area = "local"): void => {
  h.changeListeners[0]!({ [CONTROLS_IN_PAGE_KEY]: { newValue: value } }, area);
};

beforeEach(() => {
  for (const k of Object.keys(h.storage)) delete h.storage[k];
  for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  h.failTypes.length = 0;
  h.sent.length = 0;
  h.replyListeners.length = 0;
  h.changeListeners.length = 0;
  h.instances.length = 0;
  h.capture = null;
  h.storage[CONTROLS_IN_PAGE_KEY] = true; // bar mounts unless a test opts out
  document.getElementById("leia-floating-bar")?.remove();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mount / unmount", () => {
  it("mounts per the stored flag at boot and builds the full bar", async () => {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    await loadBar();
    expect(bar()).not.toBeNull();
    expect(play().textContent).toBe("▶ Play");
    expect(q<HTMLButtonElement>("leia-cmd-stop").disabled).toBe(true);
    expect(q<HTMLButtonElement>("leia-cmd-back").disabled).toBe(true);
    expect(q<HTMLButtonElement>("leia-cmd-fwd").disabled).toBe(true);
    expect(q("leia-bar-status").textContent).toBe("select text, or play the whole page");
    expect(q("leia-bar-status").title).toBe("select text, or play the whole page");
    expect(q<HTMLSelectElement>("leia-speed").options).toHaveLength(7);
  });

  it("stays unmounted by default (flag unset or false)", async () => {
    delete h.storage[CONTROLS_IN_PAGE_KEY];
    await loadBar();
    expect(document.getElementById("leia-floating-bar")).toBeNull();
  });

  it("follows live storage toggles, ignoring wrong areas and keys", async () => {
    delete h.storage[CONTROLS_IN_PAGE_KEY];
    await loadBar();
    setSurface(true);
    expect(bar()).not.toBeNull();
    setSurface(false);
    expect(document.getElementById("leia-floating-bar")).toBeNull();
    setSurface(true, "session"); // wrong area → ignored
    expect(document.getElementById("leia-floating-bar")).toBeNull();
    h.changeListeners[0]!({ unrelated: { newValue: true } }, "local"); // wrong key → ignored
    expect(document.getElementById("leia-floating-bar")).toBeNull();
    setSurface(true);
    expect(bar()).not.toBeNull();
  });

  it("close hands the controls to the popup via the storage flag", async () => {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    await loadBar();
    q<HTMLButtonElement>("leia-cmd-close").click();
    await settle();
    expect(h.storage[CONTROLS_IN_PAGE_KEY]).toBe(false);
    setSurface(false);
    expect(document.getElementById("leia-floating-bar")).toBeNull();
  });

  it("bar-status replies with the mount state; ping routes; unknown types stay unhandled", async () => {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    await loadBar();
    const listener = h.replyListeners[0]!;

    const sendResponse = vi.fn();
    expect(listener({ type: "leia:bar-status" }, {}, sendResponse)).toBe(true);
    await settle();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      replyType: "leia:bar-status",
      data: { mounted: true, id: "leia-floating-bar" },
    });

    const pong = vi.fn();
    expect(listener({ type: "ping" }, {}, pong)).toBe(true);
    await settle();
    expect((pong.mock.calls[0]![0] as { replyType: string }).replyType).toBe("pong");

    expect(listener({ type: "leia:unknown" }, {}, vi.fn())).toBe(false);
    expect(listener(null, {}, vi.fn())).toBe(false);

    setSurface(false);
    const unmountedResponse = vi.fn();
    expect(listener({ type: "leia:bar-status" }, {}, unmountedResponse)).toBe(true);
    await settle();
    expect(unmountedResponse).toHaveBeenCalledWith({
      ok: true,
      replyType: "leia:bar-status",
      data: { mounted: false, id: "leia-floating-bar" },
    });
  });

  it("syncs the initial session state from the background on mount", async () => {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    h.handlers["leia:reader:status"] = () =>
      makeStatus({ state: "playing", tokenPos: 1, tokenCount: 4, settings: { voiceName: null, rate: 2, engine: null } });
    await loadBar();
    expect(play().textContent).toBe("⏸ Pause");
    expect(q<HTMLButtonElement>("leia-cmd-stop").disabled).toBe(false);
    expect(q<HTMLSelectElement>("leia-speed").value).toBe("2");
    expect(q("leia-bar-status").textContent).toBe("playing · sentence 2/4");
  });
});

describe("play button", () => {
  it("start with no readable scope: no pending state, friendly status", async () => {
    await loadBar();
    play().click();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("no readable article — select text");
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("start binds the captured scope and stays pending until the first highlight", async () => {
    h.capture = { tokens: [{ text: "Hello there." }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () =>
      okReply({ ...makeStatus({ state: "playing", tokenCount: 3 }), locale: "en-US" });
    await loadBar();

    play().click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:start", tokens: [{ text: "Hello there." }] });
    expect(lastHighlighter().bind).toHaveBeenCalledWith("s1", h.capture, "en-US");
    expect(play().disabled).toBe(true);
    expect(play().classList.contains("loading")).toBe(true);
    expect(q("leia-bar-status").textContent).toBe("starting…");
    expect(play().querySelector(".leia-spin")).not.toBeNull();

    // First highlight = audio actually began.
    broadcast({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 });
    await settle();
    expect(play().disabled).toBe(false);
    expect(play().classList.contains("loading")).toBe(false);
    // The start reply's status is NOT applied locally — the label stays the
    // stopped-state one until the first session:state broadcast arrives.
    expect(play().textContent).toBe("▶ Play");
    broadcast({
      type: "leia:session:state",
      status: makeStatus({ state: "playing", tokenPos: 0, tokenCount: 3 }),
    });
    await settle();
    expect(play().textContent).toBe("⏸ Pause");
  });

  it("start failure clears the spinner and reports the error", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => errReply("tokens rejected");
    await loadBar();
    play().click();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("failed: tokens rejected");
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("a rejected start send reports 'start failed'", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.failTypes.push("leia:reader:start");
    await loadBar();
    play().click();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("start failed");
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("resume: a failed reply clears the spinner and reports the error", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "paused", tokenPos: 1 });
    h.handlers["leia:reader:resume"] = () => errReply("hub gone");
    await loadBar();
    play().click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:resume" });
    expect(play().classList.contains("loading")).toBe(false);
    expect(q("leia-bar-status").textContent).toBe("failed: hub gone");
  });

  it("resume: an ok reply keeps waiting for the first highlight", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "paused" });
    h.handlers["leia:reader:resume"] = () => okReply(makeStatus({ state: "playing" }));
    await loadBar();
    play().click();
    await settle();
    expect(play().classList.contains("loading")).toBe(true);
    expect(q("leia-bar-status").textContent).toBe("resuming…");
  });

  it("a rejected resume send clears the pending state", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "paused" });
    h.failTypes.push("leia:reader:resume");
    await loadBar();
    play().click();
    await settle();
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("pause sends immediately with no pending state", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "playing" });
    await loadBar();
    play().click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:pause" });
    expect(play().disabled).toBe(false);
  });

  it("a start reply with no data leaves the button pending for the highlight", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => undefined; // fire-and-forget reply
    await loadBar();
    play().click();
    await settle();
    expect(lastHighlighter().bind).not.toHaveBeenCalled();
    expect(play().classList.contains("loading")).toBe(true); // stays pending
    // A not-ok reply without an error still surfaces the "?" fallback.
    h.handlers["leia:reader:start"] = () => ({ ok: false, replyType: "x" });
    broadcast({ type: "leia:session:state", status: makeStatus({ state: "stopped" }) });
    await settle();
    play().click();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("failed: ?");
  });

  it("mounting an already-mounted bar is a no-op", async () => {
    await loadBar();
    const first = bar();
    setSurface(true);
    expect(bar()).toBe(first);
  });

  it("the 30s failsafe clears a stuck loading state", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => okReply({ ...makeStatus({ state: "playing" }) });
    await loadBar();
    vi.useFakeTimers();
    play().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(play().classList.contains("loading")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(play().classList.contains("loading")).toBe(false);
    vi.useRealTimers();
  });
});

describe("secondary transport", () => {
  it("stop, seek and speed send through the background", async () => {
    h.handlers["leia:reader:status"] = () =>
      makeStatus({ state: "playing", tokenPos: 1, tokenCount: 3 });
    await loadBar();

    q<HTMLButtonElement>("leia-cmd-stop").click();
    q<HTMLButtonElement>("leia-cmd-back").click();
    q<HTMLButtonElement>("leia-cmd-fwd").click();
    const speed = q<HTMLSelectElement>("leia-speed");
    speed.value = "1.5";
    speed.dispatchEvent(new Event("change"));
    await settle();

    expect(h.sent).toContainEqual({ type: "leia:reader:stop" });
    expect(h.sent).toContainEqual({ type: "leia:reader:seek", token: 0 });
    expect(h.sent).toContainEqual({ type: "leia:reader:seek", token: 2 });
    expect(h.sent).toContainEqual({ type: "leia:reader:prefs", rate: 1.5 });
  });

  it("seek guards hold even for a stale-enabled button while stopped", async () => {
    await loadBar();
    // Defensive guards: a button left enabled must not seek a stopped session.
    const back = q<HTMLButtonElement>("leia-cmd-back");
    const fwd = q<HTMLButtonElement>("leia-cmd-fwd");
    back.disabled = false;
    fwd.disabled = false;
    back.click();
    fwd.click();
    await settle();
    expect(h.sent.filter((m) => m.type === "leia:reader:seek")).toHaveLength(0);
  });
});

describe("reply-listener cases", () => {
  it("a stopped session state ends a pending start", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => okReply({ ...makeStatus({ state: "playing" }) });
    await loadBar();
    play().click();
    await settle();
    expect(play().classList.contains("loading")).toBe(true);
    broadcast({ type: "leia:session:state", status: makeStatus({ state: "stopped" }) });
    await settle();
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("session:error with nothing pending still surfaces the engine failure", async () => {
    await loadBar();
    broadcast({ type: "leia:session:error", sessionId: "s1", message: "boom" });
    await settle();
    expect(q("leia-bar-status").textContent).toBe("engine: boom");
  });

  it("highlight:set with nothing pending still renders the wash", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "playing" });
    await loadBar();
    const inst = lastHighlighter();
    broadcast({ type: "leia:highlight:set", sessionId: "s1", from: 2, to: 3 });
    await settle();
    expect(inst.show).toHaveBeenCalledWith("s1", 2, 3, undefined);
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("highlight:set renders and ends pending; highlight:clear resets", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => okReply({ ...makeStatus({ state: "playing" }) });
    await loadBar();
    const inst = lastHighlighter();

    play().click();
    await settle();
    broadcast({ type: "leia:highlight:set", sessionId: "s1", from: 1, to: 2 });
    await settle();
    expect(inst.show).toHaveBeenCalledWith("s1", 1, 2, undefined);

    broadcast({ type: "leia:highlight:clear", sessionId: "s1" });
    await settle();
    expect(inst.clear).toHaveBeenCalledWith("s1");
  });

  it("session:state keeps the march while playing and disarms otherwise", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "paused" });
    await loadBar();
    const inst = lastHighlighter();
    inst.hasSession.mockReturnValue(true);

    broadcast({ type: "leia:session:state", status: makeStatus({ state: "playing", tokenPos: 0, tokenCount: 2 }) });
    await settle();
    expect(play().textContent).toBe("⏸ Pause");
    expect(q("leia-bar-status").textContent).toBe("playing · sentence 1/2");

    broadcast({
      type: "leia:session:state",
      status: makeStatus({ state: "paused", tokenPos: 0, tokenCount: 2, lastError: "drive stalled" }),
    });
    await settle();
    expect(q("leia-bar-status").textContent).toBe("paused · sentence 1/2 — engine: drive stalled");
    expect(q("leia-bar-status").title).toBe("paused · sentence 1/2 — engine: drive stalled");
  });

  it("session:error surfaces the engine failure and ends pending", async () => {
    h.capture = { tokens: [{ text: "x" }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => okReply({ ...makeStatus({ state: "playing" }) });
    await loadBar();
    play().click();
    await settle();
    broadcast({ type: "leia:session:error", sessionId: "s1", message: "engine exploded" });
    await settle();
    expect(q("leia-bar-status").textContent).toBe("engine: engine exploded");
    expect(play().classList.contains("loading")).toBe(false);
  });

  it("a stale scope stops playback and asks for a new selection", async () => {
    h.handlers["leia:reader:status"] = () => makeStatus({ state: "playing" });
    await loadBar();
    lastHighlighter().opts.onStale!();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("page changed — select text");
    expect(h.sent).toContainEqual({ type: "leia:reader:stop" });

    // A rejected stop on stale is swallowed (nothing left to control).
    h.failTypes.push("leia:reader:stop");
    lastHighlighter().opts.onStale!();
    await settle();
    expect(q("leia-bar-status").textContent).toBe("page changed — select text");
  });

  it("the word march arms on a timeline, polls the audio clock, and disarms", async () => {
    h.capture = { tokens: [{ text: "Hello there." }], ranges: [document.createRange()] };
    h.handlers["leia:reader:start"] = () => okReply({ ...makeStatus({ state: "playing" }), locale: "en-US" });
    h.handlers["leia:audio:clock"] = () => ({ data: { clock: 1234 } });
    await loadBar();
    const inst = lastHighlighter();
    inst.hasSession.mockReturnValue(true);

    play().click();
    await settle();
    broadcast({
      type: "leia:highlight:set",
      sessionId: "s1",
      from: 0,
      to: 0,
      timeline: { words: [{ begin: 0, end: 5, t: 0 }], anchorWall: Date.now(), anchorClock: 0 },
    });
    await waitMs(350);

    // The march applied at least one word through the bar's highlighter...
    const lastShow = inst.show.mock.calls[inst.show.mock.calls.length - 1]!;
    expect(lastShow[3]).toEqual({ begin: 0, end: 5 });
    // ...and the 250ms clock poll sampled the media clock.
    const clockPolls = h.sent.filter((m) => m.type === "leia:audio:clock").length;
    expect(clockPolls).toBeGreaterThanOrEqual(1);

    // A playing state keeps the march alive; paused disarms it.
    broadcast({ type: "leia:session:state", status: makeStatus({ state: "playing", tokenPos: 0, tokenCount: 1 }) });
    await waitMs(300);
    const pollsWhilePlaying = h.sent.filter((m) => m.type === "leia:audio:clock").length;
    expect(pollsWhilePlaying).toBeGreaterThan(clockPolls);

    broadcast({ type: "leia:session:state", status: makeStatus({ state: "paused", tokenPos: 0, tokenCount: 1 }) });
    await waitMs(300);
    const pollsAfterPause = h.sent.filter((m) => m.type === "leia:audio:clock").length;
    await waitMs(300);
    expect(h.sent.filter((m) => m.type === "leia:audio:clock").length).toBe(pollsAfterPause);

    broadcast({ type: "leia:highlight:clear", sessionId: "s1" });
    await settle();
    expect(inst.clear).toHaveBeenCalledWith("s1");
  });
});

describe("dragging and click suppression", () => {
  const mouse = (type: string, x: number, y: number): MouseEvent =>
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

  async function mountedBar(): Promise<HTMLElement> {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    await loadBar();
    return bar();
  }

  it("movement beyond the threshold drags the bar inside the viewport", async () => {
    const root = await mountedBar();
    const docSpy = vi.fn();
    document.addEventListener("click", docSpy);

    root.dispatchEvent(mouse("mousedown", 100, 100));
    expect(root.style.left).toBe("0px"); // anchored by top-left on drag start
    expect(root.style.right).toBe("auto");

    // Below the 4px threshold: not a drag yet.
    window.dispatchEvent(mouse("mousemove", 102, 102));
    expect(root.classList.contains("dragging")).toBe(false);

    window.dispatchEvent(mouse("mousemove", 104, 104));
    expect(root.classList.contains("dragging")).toBe(true);
    expect(root.style.left).toBe("4px");
    expect(root.style.top).toBe("4px");

    // Subsequent moves keep tracking without re-adding the class.
    window.dispatchEvent(mouse("mousemove", 110, 112));
    expect(root.classList.contains("dragging")).toBe(true);
    expect(root.style.left).toBe("10px");
    expect(root.style.top).toBe("12px");

    window.dispatchEvent(mouse("mouseup", 110, 112));
    expect(root.classList.contains("dragging")).toBe(false);

    // The click that follows a drag is swallowed (pointer may end on a button).
    root.dispatchEvent(mouse("click", 104, 104));
    expect(docSpy).not.toHaveBeenCalled();

    await waitMs(10); // suppressClick resets on a timeout
    root.dispatchEvent(mouse("click", 104, 104));
    expect(docSpy).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", docSpy);
  });

  it("a plain click (no drag) passes through to the page", async () => {
    const root = await mountedBar();
    const docSpy = vi.fn();
    document.addEventListener("click", docSpy);
    root.dispatchEvent(mouse("mousedown", 10, 10));
    window.dispatchEvent(mouse("mouseup", 10, 10));
    root.dispatchEvent(mouse("click", 10, 10));
    expect(docSpy).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", docSpy);
  });

  it("mousemove/mouseup without an active drag are ignored", async () => {
    const root = await mountedBar();
    window.dispatchEvent(mouse("mousemove", 500, 500));
    window.dispatchEvent(mouse("mouseup", 500, 500));
    expect(root.style.left).toBe("");
    expect(root.classList.contains("dragging")).toBe(false);
  });

  it("resize re-clamps the bar position; it is a no-op when unmounted", async () => {
    const root = await mountedBar();
    window.dispatchEvent(new Event("resize"));
    expect(root.style.left).toBe("0px");
    expect(root.style.top).toBe("0px");

    setSurface(false);
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
  });
});
