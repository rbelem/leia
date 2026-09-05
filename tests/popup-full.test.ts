// SPDX-License-Identifier: MPL-2.0
/**
 * Popup bootstrap coverage: the wiring that only runs when the popup DOM is
 * present (tests/settings.test.ts covers the exported pure builders).
 * Drives refresh/voice-picker assembly, transport + loading state machine,
 * theme swatches, the T16 resume hint and live broadcasts against a scripted
 * background, all on an in-memory browser mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../src/reader/session";
import type { EngineCapabilities, VoiceInfo } from "../src/reader/contract";
import { CONTROLS_IN_PAGE_KEY } from "../src/controls";
import { ACTIVE_THEME } from "../src/content/themes";

const h = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  handlers: {} as Record<string, (msg: Record<string, unknown>) => unknown>,
  failTypes: [] as string[],
  sent: [] as Array<Record<string, unknown>>,
  replyListeners: [] as Array<
    (msg: unknown, sender?: unknown, sendResponse?: (r?: unknown) => void) => unknown
  >,
  tabs: [{ url: "https://page.test/article" }] as Array<{ url?: string }>,
  queryReject: false,
  openOptionsCalls: 0,
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
      openOptionsPage: () => {
        h.openOptionsCalls += 1;
        return Promise.resolve();
      },
      onMessage: {
        addListener: (
          fn: (msg: unknown, sender?: unknown, sendResponse?: (r?: unknown) => void) => unknown,
        ) => {
          h.replyListeners.push(fn);
        },
      },
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
    },
    tabs: {
      query: async () => {
        if (h.queryReject) throw new Error("tabs api unavailable");
        return h.tabs;
      },
    },
  },
}));

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function buildPopupDom(): void {
  document.body.innerHTML = `
    <div id="playback-controls">
      <button id="pp-back" disabled></button>
      <button id="pp-play"></button>
      <button id="pp-fwd" disabled></button>
      <button id="pp-stop" disabled></button>
      <button id="open-in-page"></button>
    </div>
    <div id="status"></div>
    <div id="reader-error" hidden></div>
    <div id="resume-row" hidden><span id="resume-label"></span><button id="resume-clear"></button></div>
    <select id="speed"></select>
    <select id="voice"><option value="">(default voice)</option></select>
    <button id="preview-voice" disabled></button>
    <div id="preview-note" hidden></div>
    <div id="family-hint" hidden></div>
    <div id="capabilities"></div>
    <p id="sources-summary"></p>
    <button id="open-settings"></button>
    <div id="theme-swatches"></div>`;
}

const makeStatus = (over: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId: "s1",
  state: "playing",
  tokenPos: 0,
  tokenCount: 3,
  settings: { voiceName: null, rate: 1, engine: null },
  ...over,
});

const okReply = (data: unknown) => ({ ok: true, replyType: "x", data });
const errReply = (error: string) => ({ ok: false, replyType: "x", error });

const voice = (name: string, family: string, lang = "en-US"): VoiceInfo => ({
  name,
  family,
  lang,
  localService: true,
});

const FREE_CAPS: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "free",
  privacyClass: "local",
};
const PAID_CAPS: EngineCapabilities = {
  wordTiming: true,
  streaming: true,
  costClass: "paid",
  privacyClass: "provider",
};

type PopupModule = typeof import("../src/popup/popup");

async function loadPopup(): Promise<PopupModule> {
  vi.resetModules();
  const popup = await import("../src/popup/popup");
  await settle();
  return popup;
}

/** Dispatch a runtime broadcast to the popup's registered reply listener. */
const broadcast = (msg: unknown): unknown => h.replyListeners[0]!(msg);

beforeEach(() => {
  for (const k of Object.keys(h.storage)) delete h.storage[k];
  for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  h.failTypes.length = 0;
  h.sent.length = 0;
  h.replyListeners.length = 0;
  h.tabs = [{ url: "https://page.test/article" }];
  h.queryReject = false;
  h.openOptionsCalls = 0;
  buildPopupDom();
});

describe("pure helpers (bootstrap-gated module)", () => {
  it("module imports safely when the popup DOM is absent (bootstrap skipped)", async () => {
    document.body.innerHTML = "";
    vi.resetModules();
    const popup = await import("../src/popup/popup");
    expect(popup.familyHint("kitten-local")).toContain("~25 MB");
    expect(h.replyListeners).toHaveLength(0); // no wiring ran
  });

  it("familyHint: kitten discloses the one-time model download, others stay quiet", async () => {
    const { familyHint } = await loadPopup();
    expect(familyHint("kitten-local")).toContain("~25 MB");
    expect(familyHint("minimax")).toBeNull();
    expect(familyHint("mystery")).toBeNull();
  });

  it("familyLabel: catalog, then local naming, then the raw id", async () => {
    const { familyLabel } = await loadPopup();
    expect(familyLabel("web-speech")).toBe("Web Speech");
    expect(familyLabel("minimax")).toBe("MiniMax");
    expect(familyLabel("local-kokoro")).toBe("Kokoro (local)");
    expect(familyLabel("local-custom-x", new Map([["custom-x", "My Box"]]))).toBe("My Box (local)");
    expect(familyLabel("mystery")).toBe("mystery");
  });

  it("renderFamilyHint shows and clears the disclosure note", async () => {
    const { renderFamilyHint, familyHint } = await loadPopup();
    const el = document.createElement("div");
    renderFamilyHint(el, familyHint("kitten-local"));
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("~25 MB");
    renderFamilyHint(el, null);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });

  it("isThemeId narrows real theme ids only", async () => {
    const { isThemeId } = await loadPopup();
    expect(isThemeId("ocean")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});

describe("refresh: voice picker assembly", () => {
  it("builds groups, keyless affordances, offline servers, caps, summary and resume hint", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Mini Voice", rate: 1.5, engine: "minimax" } }));
    h.handlers["leia:reader:voices"] = () => okReply([voice("Mini Voice", "minimax"), voice("System", "web-speech")]);
    h.handlers["leia:audio:families"] = () => okReply([{ family: "minimax", capabilities: PAID_CAPS }]);
    h.handlers["leia:reader:resume-info"] = () =>
      okReply({ url: "https://page.test/article", tokenPos: 2, tokenCount: 9 });
    h.storage["leia:settings:elevenlabsKey"] = "sk-123456";

    await loadPopup();

    expect(q("status").textContent).toBe("playing · sentence 1/3 · minimax");
    expect(q<HTMLSelectElement>("speed").value).toBe("1.5");

    const select = q<HTMLSelectElement>("voice");
    const labels = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(labels).toContain("MiniMax");
    expect(labels).toContain("Web Speech");
    expect(labels).toContain("OpenAI — no key");
    expect(labels).toContain("ElevenLabs — key saved, no voices loaded");
    expect(labels).toContain("Local servers — 5 offline");
    const mini = select.querySelector<HTMLOptionElement>('option[value="Mini Voice"]')!;
    expect(mini.textContent).toBe("Mini Voice (en-US)");
    expect(mini.dataset.family).toBe("minimax");
    // Keyless groups are visibly disabled, not hidden.
    const eleven = [...select.querySelectorAll("optgroup")].find((g) => g.label!.startsWith("ElevenLabs"))!;
    expect(eleven.disabled).toBe(true);

    const chips = [...q("capabilities").querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(["paid", "provider", "word timing", "streaming"]);
    expect(q("family-hint").hidden).toBe(true);
    expect(q<HTMLButtonElement>("preview-voice").disabled).toBe(false);
    expect(q("sources-summary").textContent).toBe("1 API key saved · no local servers online");

    expect(q("resume-row").hidden).toBe(false);
    expect(q("resume-label").textContent).toBe("Continue from sentence 3");
  });

  it("local families: custom names online, a single offline server gets its own group", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Piper Voice", rate: 1, engine: "local-piper" } }));
    h.handlers["leia:reader:voices"] = () =>
      okReply([
        voice("Piper Voice", "local-piper"),
        voice("Kt", "local-kittentts"),
        voice("Nt", "local-neutts"),
        voice("Ed", "local-edge"),
        voice("Cx", "local-custom-x"),
      ]);
    h.storage["leia:settings:localProfiles"] = [{ id: "custom-x", name: "Custom X", baseUrl: "http://localhost:9001" }];

    await loadPopup();

    const labels = [...q<HTMLSelectElement>("voice").querySelectorAll("optgroup")].map((g) => g.label);
    expect(labels).toContain("Custom X (local)");
    // Exactly one offline built-in (kokoro) → named group, not the collapsed summary.
    expect(labels).toContain("Kokoro (local) — offline");
    expect(labels).not.toContain("Local servers — 5 offline");
    expect(q("sources-summary").textContent).toBe(
      "no API keys saved · Piper, Kittentts, Neutts, Edge, Custom X online",
    );
  });

  it("all local servers online → no offline affordance at all", async () => {
    h.handlers["leia:reader:voices"] = () =>
      okReply([
        voice("K", "local-kokoro"),
        voice("P", "local-piper"),
        voice("T", "local-kittentts"),
        voice("N", "local-neutts"),
        voice("E", "local-edge"),
      ]);
    await loadPopup();
    const labels = [...q<HTMLSelectElement>("voice").querySelectorAll("optgroup")].map((g) => g.label);
    expect(labels.filter((l) => l!.includes("offline"))).toEqual([]);
    expect(q("sources-summary").textContent).toBe(
      "no API keys saved · Kokoro, Piper, Kittentts, Neutts, Edge online",
    );
  });

  it("kitten-local selection discloses the model download under the picker", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Kitten Nano", rate: 1, engine: "kitten-local" } }));
    h.handlers["leia:reader:voices"] = () => okReply([voice("Kitten Nano", "kitten-local")]);
    h.handlers["leia:audio:families"] = () => okReply([{ family: "kitten-local", capabilities: FREE_CAPS }]);

    await loadPopup();

    const hint = q("family-hint");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("~25 MB");
    const chips = [...q("capabilities").querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(["free", "local", "estimated word timing"]);
  });

  it("without a session: defaults, all-keyless picker, hidden resume row", async () => {
    await loadPopup();

    expect(q("status").textContent).toBe("no active session");
    expect(q<HTMLButtonElement>("pp-play").textContent).toBe("▶ Play");
    expect(q<HTMLButtonElement>("pp-play").disabled).toBe(false);
    expect(q<HTMLButtonElement>("pp-stop").disabled).toBe(true);
    expect(q<HTMLButtonElement>("pp-back").disabled).toBe(true);
    expect(q<HTMLButtonElement>("pp-fwd").disabled).toBe(true);
    expect(q("reader-error").hidden).toBe(true);

    const select = q<HTMLSelectElement>("voice");
    const labels = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(labels).toEqual([
      "MiniMax — no key",
      "ElevenLabs — no key",
      "OpenAI — no key",
      "xAI — no key",
      "Mistral — no key",
      "Gemini — no key",
      "Azure — no key",
      "Local servers — 5 offline",
    ]);
    expect(q<HTMLButtonElement>("preview-voice").disabled).toBe(true);
    expect(q("capabilities").children).toHaveLength(0); // unknown family → no caps
    expect(q("family-hint").hidden).toBe(true);
    expect(q("sources-summary").textContent).toBe("no API keys saved · no local servers online");
    // resume-info unhandled (no ok reply) → row stays hidden
    expect(q("resume-row").hidden).toBe(true);
  });

  it("stopped status reads as no-session text with transport disabled", async () => {
    h.handlers["leia:reader:status"] = () => okReply(makeStatus({ state: "stopped" }));
    await loadPopup();
    expect(q("status").textContent).toBe("no active session");
    expect(q("reader-error").hidden).toBe(true);
    expect(q<HTMLButtonElement>("pp-stop").disabled).toBe(true);
  });

  it("surfaces the engine failure (T17) without the family suffix for web-speech", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(
        makeStatus({
          state: "playing",
          tokenPos: 1,
          tokenCount: 3,
          lastError: "synthesis failed",
          settings: { voiceName: null, rate: 1, engine: "web-speech" },
        }),
      );
    await loadPopup();
    expect(q("status").textContent).toBe("playing · sentence 2/3");
    expect(q("reader-error").hidden).toBe(false);
    expect(q("reader-error").textContent).toBe("engine error — synthesis failed");
  });

  it("resume hint hides when the tab has no URL, the reply is empty, or tabs.query rejects", async () => {
    h.handlers["leia:reader:resume-info"] = () => okReply(null);
    h.tabs = [{}];
    await loadPopup();
    expect(q("resume-row").hidden).toBe(true);

    h.queryReject = true; // catch branch
    await loadPopup();
    expect(q("resume-row").hidden).toBe(true);
  });
});

describe("surface + settings wiring", () => {
  it("open-settings hands over to the options page", async () => {
    await loadPopup();
    q<HTMLButtonElement>("open-settings").click();
    await settle();
    expect(h.openOptionsCalls).toBe(1);
  });

  it("open-in-page flips the storage flag and hides the popup controls", async () => {
    await loadPopup();
    q<HTMLButtonElement>("open-in-page").click();
    await settle();
    expect(h.storage[CONTROLS_IN_PAGE_KEY]).toBe(true);
    expect(q("playback-controls").hidden).toBe(true);
  });

  it("booting with the flag already set starts with controls hidden", async () => {
    h.storage[CONTROLS_IN_PAGE_KEY] = true;
    await loadPopup();
    expect(q("playback-controls").hidden).toBe(true);
  });
});

describe("transport buttons", () => {
  it("stop applies the reply status locally", async () => {
    h.handlers["leia:reader:status"] = () => okReply(makeStatus({ state: "playing" }));
    h.handlers["leia:reader:stop"] = () => okReply(makeStatus({ state: "paused", tokenPos: 1 }));
    await loadPopup();
    q<HTMLButtonElement>("pp-stop").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:stop" });
    expect(q("status").textContent).toBe("paused · sentence 2/3");
    expect(q<HTMLButtonElement>("pp-play").textContent).toBe("▶ Play");
  });

  it("stop with no reply keeps the current status", async () => {
    await loadPopup();
    q<HTMLButtonElement>("pp-stop").click();
    await settle();
    expect(q("status").textContent).toBe("no active session");
  });

  it("back/fwd seek by one sentence, gated by position and state", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ state: "playing", tokenPos: 1, tokenCount: 3 }));
    await loadPopup();
    q<HTMLButtonElement>("pp-back").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:seek", token: 0 });
    q<HTMLButtonElement>("pp-fwd").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:seek", token: 2 });
  });

  it("back/fwd do nothing when stopped or at the edges", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ state: "playing", tokenPos: 0, tokenCount: 1 }));
    await loadPopup();
    q<HTMLButtonElement>("pp-back").click();
    await settle();
    q<HTMLButtonElement>("pp-fwd").click();
    await settle();
    expect(h.sent.filter((m) => m.type === "leia:reader:seek")).toHaveLength(0);
  });
});

describe("play button loading state machine", () => {
  it("start: spinner until the first highlight broadcast clears it", async () => {
    h.handlers["leia:reader:start"] = () =>
      okReply(makeStatus({ state: "playing", tokenPos: 0, tokenCount: 4 }));
    await loadPopup();

    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:start" });
    const play = q<HTMLButtonElement>("pp-play");
    expect(play.disabled).toBe(true);
    expect(play.classList.contains("loading")).toBe(true);
    expect(play.getAttribute("aria-busy")).toBe("true");
    expect(q("status").textContent).toBe("starting…");
    expect(play.querySelector(".pp-spin")).not.toBeNull();

    // First highlight = audio actually began.
    expect(broadcast({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 })).toBe(false);
    await settle();
    expect(play.disabled).toBe(false);
    expect(play.classList.contains("loading")).toBe(false);
    expect(play.textContent).toBe("⏸ Pause");
    expect(q("status").textContent).toBe("playing · sentence 1/4");
    expect(q<HTMLButtonElement>("pp-stop").disabled).toBe(false);
  });

  it("start failure clears the spinner and reports the error", async () => {
    h.handlers["leia:reader:start"] = () => errReply("engine boom");
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(q("status").textContent).toBe("failed: engine boom");
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
  });

  it("a not-ok start reply without an error falls back to 'unknown'", async () => {
    h.handlers["leia:reader:start"] = () => ({ ok: false, replyType: "x" });
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(q("status").textContent).toBe("failed: unknown");
  });

  it("a rejected send is reported as a failure, not a hang", async () => {
    h.failTypes.push("leia:reader:start");
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(q("status").textContent).toBe("failed: Error: send failed");
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
  });

  it("resume clears on a failed reply and keeps waiting on an ok one", async () => {
    h.handlers["leia:reader:status"] = () => okReply(makeStatus({ state: "paused", tokenPos: 1 }));
    await loadPopup();

    // A failed resume clears the spinner and reports the error.
    h.handlers["leia:reader:resume"] = () => ({ ok: false, replyType: "x" }); // no error field
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:resume" });
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
    expect(q("status").textContent).toBe("failed: unknown");

    // Restore paused state; an ok resume reply alone does not clear —
    // only the first highlight does.
    broadcast({ type: "leia:session:state", status: makeStatus({ state: "paused", tokenPos: 1 }) });
    await settle();
    h.handlers["leia:reader:resume"] = () => okReply(makeStatus({ state: "playing", tokenPos: 1 }));
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(true);
  });

  it("pause sends immediately with no pending state", async () => {
    h.handlers["leia:reader:status"] = () => okReply(makeStatus({ state: "playing" }));
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:pause" });
    expect(q<HTMLButtonElement>("pp-play").disabled).toBe(false);
  });

  it("the 30s failsafe clears a stuck loading state", async () => {
    h.handlers["leia:reader:start"] = () => okReply(makeStatus({ state: "playing" }));
    await loadPopup();
    vi.useFakeTimers();
    q<HTMLButtonElement>("pp-play").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
    expect(q<HTMLButtonElement>("pp-play").textContent).toBe("⏸ Pause");
    vi.useRealTimers();
  });

  it("a second beginLoading replaces (not stacks) the pending failsafe timer", async () => {
    // An ok start reply with no status data leaves the button pending without
    // applying a "playing" state — so a second click computes "start" again.
    h.handlers["leia:reader:start"] = () => okReply(undefined);
    await loadPopup();
    vi.useFakeTimers();
    const play = q<HTMLButtonElement>("pp-play");
    play.click(); // beginLoading #1: failsafe armed for t=30s
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play.classList.contains("loading")).toBe(true);

    // A user cannot re-click a disabled Play, but the guard must hold when
    // beginLoading runs twice anyway (the click listener is still wired).
    // The listener runs synchronously here (t=10s), so its failsafe is due
    // at t=40s — 10s after the first timer's deadline.
    play.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // t=30s — the FIRST timer's deadline: it must have been cleared, not
    // stacked, or the loading state would drop here.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(play.classList.contains("loading")).toBe(true);
    // t=40s — the replacement timer's deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(play.classList.contains("loading")).toBe(false);
    vi.useRealTimers();
  });
});

describe("pickers", () => {
  it("voice change pins the preference and re-renders capabilities", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Mini Voice", rate: 1, engine: "minimax" } }));
    h.handlers["leia:reader:voices"] = () => okReply([voice("Mini Voice", "minimax"), voice("System", "web-speech")]);
    h.handlers["leia:audio:families"] = () => okReply([{ family: "minimax", capabilities: PAID_CAPS }]);
    await loadPopup();

    const select = q<HTMLSelectElement>("voice");
    select.value = "System";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:prefs", voiceName: "System" });
    expect(q<HTMLButtonElement>("preview-voice").disabled).toBe(false);
    // web-speech has no caps entry → chips cleared
    expect(q("capabilities").children).toHaveLength(0);

    select.value = "";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:prefs", voiceName: null });
    expect(q<HTMLButtonElement>("preview-voice").disabled).toBe(true);
  });

  it("speed change sends the numeric rate", async () => {
    await loadPopup();
    const speed = q<HTMLSelectElement>("speed");
    expect([...speed.options].map((o) => o.textContent)).toEqual([
      "0.5×", "0.75×", "1×", "1.5×", "2×", "2.5×", "3×",
    ]);
    speed.value = "2";
    speed.dispatchEvent(new Event("change"));
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:prefs", rate: 2 });
  });

  it("preview failure points at Voice sources and auto-hides the note", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Mini Voice", rate: 1, engine: "minimax" } }));
    h.handlers["leia:reader:voices"] = () => okReply([voice("Mini Voice", "minimax")]);
    h.handlers["leia:reader:preview"] = () => errReply("no engine");
    await loadPopup();

    vi.useFakeTimers();
    q<HTMLButtonElement>("preview-voice").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toContainEqual(
      expect.objectContaining({ type: "leia:reader:preview", voiceName: "Mini Voice", family: "minimax" }),
    );
    const note = q("preview-note");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("couldn't preview");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(note.hidden).toBe(true);
    vi.useRealTimers();
  });

  it("a successful preview leaves no note", async () => {
    h.handlers["leia:reader:status"] = () =>
      okReply(makeStatus({ settings: { voiceName: "Mini Voice", rate: 1, engine: "minimax" } }));
    h.handlers["leia:reader:voices"] = () => okReply([voice("Mini Voice", "minimax")]);
    h.handlers["leia:reader:preview"] = () => okReply({ stage: "end" });
    await loadPopup();
    q<HTMLButtonElement>("preview-voice").click();
    await settle();
    expect(q("preview-note").hidden).toBe(true);
  });

  it("preview without a voice is a no-op", async () => {
    h.handlers["leia:reader:voices"] = () => okReply([voice("System", "web-speech")]);
    await loadPopup();
    // Stale empty selection behind an enabled button: the guard returns early.
    const select = q<HTMLSelectElement>("voice");
    select.value = "System";
    select.dispatchEvent(new Event("change"));
    await settle();
    select.value = "";
    q<HTMLButtonElement>("preview-voice").click();
    await settle();
    expect(h.sent.filter((m) => m.type === "leia:reader:preview")).toHaveLength(0);
  });
});

describe("resume hint interactions", () => {
  it("clear sends the per-URL forget and hides the row", async () => {
    h.handlers["leia:reader:resume-info"] = () =>
      okReply({ url: "https://page.test/article", tokenPos: 0, tokenCount: 5 });
    await loadPopup();
    expect(q("resume-row").hidden).toBe(false);
    q<HTMLButtonElement>("resume-clear").click();
    await settle();
    expect(h.sent).toContainEqual({ type: "leia:reader:resume-clear", url: "https://page.test/article" });
    expect(q("resume-row").hidden).toBe(true);
  });

  it("clear without a tab URL skips the message but still hides", async () => {
    h.handlers["leia:reader:resume-info"] = () =>
      okReply({ url: "https://page.test/article", tokenPos: 0, tokenCount: 5 });
    h.tabs = [{}];
    await loadPopup();
    q<HTMLButtonElement>("resume-clear").click();
    await settle();
    expect(h.sent.filter((m) => m.type === "leia:reader:resume-clear")).toHaveLength(0);
    expect(q("resume-row").hidden).toBe(true);
  });
});

describe("theme swatches", () => {
  it("renders one swatch per theme, marks the stored theme, saves clicks", async () => {
    h.storage["leia:settings:theme"] = "ocean";
    const popup = await loadPopup();

    const swatches = [...document.querySelectorAll<HTMLButtonElement>("#theme-swatches .swatch")];
    expect(swatches).toHaveLength(5);
    const marked = swatches.find((b) => b.getAttribute("aria-checked") === "true")!;
    expect(marked.dataset.theme).toBe("ocean");

    const berry = swatches.find((b) => b.dataset.theme === "berry")!;
    berry.click();
    await settle();
    expect(h.storage[popup.THEME_STORAGE_KEY]).toBe("berry");
    expect(h.sent).toContainEqual({ type: "leia:theme:set", theme: "berry" });
    expect(berry.getAttribute("aria-checked")).toBe("true");
    expect(marked.getAttribute("aria-checked")).toBe("false");
  });

  it("an invalid stored value falls back to the active theme", async () => {
    h.storage["leia:settings:theme"] = "not-a-theme";
    await loadPopup();
    const swatches = [...document.querySelectorAll<HTMLButtonElement>("#theme-swatches .swatch")];
    expect(swatches.find((b) => b.getAttribute("aria-checked") === "true")!.dataset.theme).toBe(ACTIVE_THEME);
  });
});

describe("live broadcasts", () => {
  it("session:state refreshes status, speed and clears pending on stop", async () => {
    h.handlers["leia:reader:start"] = () => okReply(makeStatus({ state: "playing" }));
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(true);

    broadcast({
      type: "leia:session:state",
      status: makeStatus({ state: "playing", tokenPos: 1, tokenCount: 4, settings: { voiceName: null, rate: 2, engine: null } }),
    });
    await settle();
    // While pending, the loading line owns the status; the state still syncs the speed.
    expect(q("status").textContent).toBe("starting…");
    expect(q<HTMLSelectElement>("speed").value).toBe("2");
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(true); // playing ≠ clear signal

    broadcast({ type: "leia:session:state", status: makeStatus({ state: "stopped" }) });
    await settle();
    expect(q("status").textContent).toBe("no active session");
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
  });

  it("session:error and highlight:set clear a pending start", async () => {
    h.handlers["leia:reader:start"] = () => okReply(makeStatus({ state: "playing" }));
    await loadPopup();
    q<HTMLButtonElement>("pp-play").click();
    await settle();
    broadcast({ type: "leia:session:error", sessionId: "s1", message: "boom" });
    await settle();
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);

    q<HTMLButtonElement>("pp-play").click();
    await settle();
    broadcast({ type: "leia:highlight:set", sessionId: "s1", from: 0, to: 0 });
    await settle();
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
  });

  it("error broadcasts with nothing pending and no session are safe no-ops", async () => {
    await loadPopup();
    expect(broadcast({ type: "leia:session:error", sessionId: "s1", message: "boom" })).toBe(false);
    expect(q("status").textContent).toBe("no active session");
    expect(q<HTMLButtonElement>("pp-play").classList.contains("loading")).toBe(false);
  });

  it("non-router and unknown messages get no reply from the popup", async () => {
    await loadPopup();
    expect(broadcast("garbage")).toBe(false);
    expect(broadcast({ type: "leia:unknown:message" })).toBe(false);
    expect(broadcast({ type: "leia:highlight:set" })).toBe(false); // no pending loading — no-op
  });
});
