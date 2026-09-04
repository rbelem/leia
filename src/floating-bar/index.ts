// SPDX-License-Identifier: MPL-2.0
/**
 * Floating bar (page context): one Play/Pause button (Play from stopped
 * starts a fresh read of the selection/page), Stop, sentence Back/Forward,
 * speed, Close. Draggable anywhere in the viewport (4px movement threshold
 * keeps plain clicks working; `mousedown` is prevented so the bar never
 * steals the page's selection or focus).
 *
 * The bar captures the page scope itself (T2 item 6 — the bar lives in the
 * page — with the T3 article fallback), binds the sentence-token index to
 * the session, and applies the marching highlight from background events.
 *
 * Surface state: the bar only mounts while the `leia:controls-in-page`
 * storage.local flag is on (default true). Closing the bar clears the flag
 * — the popup then shows the playback controls instead — and storage
 * onChanged mounts/unmounts the bar live in open tabs.
 */
import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterMessage, type RouterReply } from "../background/router";
import { addReplyListener } from "../messaging";
import { captureScope, ScopeHighlighter } from "../content/scope";
import { ensureHighlightStyle } from "../content/highlight";
import { createMarch } from "../content/march";
import type { SessionStatus } from "../reader/session";
import {
  CONTROLS_IN_PAGE_KEY,
  LOADING_TIMEOUT_MS,
  canSeekBack,
  canSeekForward,
  clampBarPosition,
  controlsInPage,
  loadingKindForAction,
  nextToken,
  playAction,
  playLabel,
  prevToken,
  shouldClearLoading,
  type LoadingKind,
} from "../controls";

const BAR_ID = "leia-floating-bar";
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];
const DRAG_THRESHOLD = 4;

ensureHighlightStyle(document);

/** Pseudo-class states (hover/active/focus/disabled) and the loading
 * spinner — inline cssText can't express these, so they live in one
 * injected stylesheet scoped under the bar id. `!important` only where an
 * inline style (background, cursor) would otherwise win. */
const BAR_STYLE_ID = "leia-floating-bar-style";
function ensureBarStyle(doc: Document): void {
  if (doc.getElementById(BAR_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = BAR_STYLE_ID;
  style.textContent =
    "#leia-floating-bar button,#leia-floating-bar select{" +
    "transition:background-color .12s ease,filter .12s ease,transform .06s ease;}" +
    "#leia-floating-bar button:hover:not(:disabled){background:rgb(255 255 255 / .22)!important;}" +
    "#leia-floating-bar button:active:not(:disabled){transform:scale(.96);filter:brightness(.85);}" +
    "#leia-floating-bar.dragging{cursor:grabbing;}" +
    "#leia-floating-bar.dragging button{cursor:grabbing!important;}" +
    "#leia-floating-bar button:focus-visible,#leia-floating-bar select:focus-visible{" +
    "outline:2px solid #fbbf24;outline-offset:1px;}" +
    "#leia-floating-bar button:disabled{opacity:.4;cursor:default!important;}" +
    "#leia-floating-bar select:hover:not(:disabled){background:#57534e!important;}" +
    "#leia-floating-bar button.loading{cursor:progress!important;}" +
    "#leia-floating-bar .leia-spin{display:inline-block;width:10px;height:10px;margin-right:5px;" +
    "vertical-align:-1px;border:2px solid rgb(255 255 255 / .35);border-top-color:#f9fafb;" +
    "border-radius:50%;animation:leia-spin-rot .8s linear infinite;}" +
    "@keyframes leia-spin-rot{to{transform:rotate(360deg)}}";
  doc.documentElement.appendChild(style);
}
ensureBarStyle(document);
// A heavy mutation on the bound scope (SPA content swap) invalidates the
// read: stop playback and surface the page-changed state.
const highlighter = new ScopeHighlighter({ onStale: handleScopeStale });
// Local word march for the bar-captured path (this script's highlighter is
// the bound renderer there) — see content/march.ts.
const march = createMarch({
  apply: (sessionId, from, to, word) => highlighter.show(sessionId, from, to, word),
  owns: (sessionId) => highlighter.hasSession(sessionId),
});

interface BarElements {
  root: HTMLElement;
  play: HTMLButtonElement;
  stop: HTMLButtonElement;
  back: HTMLButtonElement;
  fwd: HTMLButtonElement;
  speed: HTMLSelectElement;
  status: HTMLSpanElement;
}

let els: BarElements | null = null;
let status: SessionStatus = {
  sessionId: null,
  state: "stopped",
  tokenPos: 0,
  tokenCount: 0,
  settings: { voiceName: null, rate: 1, engine: null },
};
/** Set when the underlying page mutated away from the bound scope; persists
 * until the next read click. */
let staleNotice: string | null = null;
/** Play-button pending state: set on start/resume, cleared when audio
 * actually begins (first highlight), on error/stop/reply-failure, or by the
 * failsafe timer. state "playing" arrives BEFORE synthesis — never trust
 * it as the clear signal. */
let loading: LoadingKind | null = null;
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

function beginLoading(kind: LoadingKind): void {
  loading = kind;
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    if (loading && shouldClearLoading({ type: "timeout" })) clearLoading();
  }, LOADING_TIMEOUT_MS);
  render();
}

function clearLoading(): void {
  loading = null;
  if (loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  render();
}

function handleScopeStale(): void {
  march.disarm();
  staleNotice = "page changed — select text";
  render();
  void browser.runtime.sendMessage({ type: "leia:reader:stop" }).catch(() => {});
}

function render(): void {
  if (!els) return;
  if (loading) {
    els.play.disabled = true;
    els.play.classList.add("loading");
    els.play.setAttribute("aria-busy", "true");
    els.play.setAttribute("aria-label", loading);
    els.play.textContent = "";
    const spin = document.createElement("span");
    spin.className = "leia-spin";
    spin.setAttribute("aria-hidden", "true");
    els.play.append(spin, `${loading}…`);
  } else {
    els.play.disabled = false;
    els.play.classList.remove("loading");
    els.play.removeAttribute("aria-busy");
    els.play.textContent = playLabel(status.state);
    els.play.setAttribute("aria-label", playLabel(status.state));
  }
  els.stop.disabled = status.state === "stopped";
  els.back.disabled = !canSeekBack(status);
  els.fwd.disabled = !canSeekForward(status);
  els.speed.value = String(status.settings.rate);
  const base =
    status.state === "stopped"
      ? "select text, or play the whole page"
      : `${status.state} · sentence ${Math.min(status.tokenPos + 1, status.tokenCount)}/${status.tokenCount}`;
  // Surface engine failures exactly where the reader is being used (T17);
  // temporary-friendly: visible even when the popup is closed. Title mirrors
  // the text so the ellipsized overflow stays readable on hover.
  els.status.textContent =
    staleNotice ??
    (status.lastError
      ? `${base} — engine: ${status.lastError.slice(0, 90)}`
      : loading
        ? `${loading}…`
        : base);
  els.status.title = els.status.textContent;
}

// --- Drag ---------------------------------------------------------------

interface DragState {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  active: boolean;
  moved: boolean;
  suppressClick: boolean;
}
const drag: DragState = { startX: 0, startY: 0, baseX: 0, baseY: 0, active: false, moved: false, suppressClick: false };

window.addEventListener("mousemove", (e) => {
  if (!drag.active || !els) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!drag.moved) els.root.classList.add("dragging");
  drag.moved = true;
  const p = clampBarPosition(
    drag.baseX + dx,
    drag.baseY + dy,
    els.root.offsetWidth,
    els.root.offsetHeight,
    window.innerWidth,
    window.innerHeight,
  );
  els.root.style.left = `${p.x}px`;
  els.root.style.top = `${p.y}px`;
});
window.addEventListener("mouseup", () => {
  if (!drag.active) return;
  drag.active = false;
  els?.root.classList.remove("dragging");
  if (drag.moved) {
    // Swallow the click that follows a drag (pointer may end on a button);
    // click dispatches right after mouseup, before this timeout runs.
    drag.suppressClick = true;
    setTimeout(() => {
      drag.suppressClick = false;
    }, 0);
  }
  drag.moved = false;
});
window.addEventListener("resize", () => {
  if (!els) return;
  const r = els.root.getBoundingClientRect();
  const p = clampBarPosition(r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight);
  els.root.style.left = `${p.x}px`;
  els.root.style.top = `${p.y}px`;
});

// --- Mount / unmount ----------------------------------------------------

function buildBar(): BarElements {
  document.getElementById(BAR_ID)?.remove();

  const root = document.createElement("div");
  root.id = BAR_ID;
  root.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:6px;align-items:center;" +
    "padding:8px 12px;border-radius:999px;background:#292524;color:#f9fafb;cursor:grab;" +
    "font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgb(0 0 0 / .35);user-select:none;";
  root.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep page selection/focus; also starts a drag
    const r = root.getBoundingClientRect();
    // Anchor by left/top from the first drag so right/bottom don't fight it.
    root.style.left = `${r.left}px`;
    root.style.top = `${r.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.baseX = r.left;
    drag.baseY = r.top;
    drag.active = true;
    drag.moved = false;
  });
  root.addEventListener(
    "click",
    (e) => {
      if (drag.suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        drag.suppressClick = false;
      }
    },
    true,
  );

  const makeButton = (id: string, label: string, title: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.style.cssText =
      "border:1px solid rgb(255 255 255 / .25);background:rgb(255 255 255 / .1);color:inherit;" +
      "border-radius:999px;padding:3px 10px;font:inherit;cursor:pointer;";
    return b;
  };

  const back = makeButton("leia-cmd-back", "⏮", "Previous sentence");
  const play = makeButton("leia-cmd-play", "▶ Play", "Play / pause");
  const fwd = makeButton("leia-cmd-fwd", "⏭", "Next sentence");
  const stop = makeButton("leia-cmd-stop", "⏹", "Stop");
  const close = makeButton("leia-cmd-close", "✕", "Close — move controls to the popup");
  close.style.padding = "3px 7px";

  const speed = document.createElement("select");
  speed.id = "leia-speed";
  speed.title = "Speed";
  speed.setAttribute("aria-label", "Speed");
  speed.style.cssText = "border-radius:999px;padding:2px 4px;font:inherit;background:#44403c;color:inherit;border:0;";
  for (const v of SPEED_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = `${v}×`;
    speed.appendChild(opt);
  }
  speed.value = "1";

  const statusSpan = document.createElement("span");
  statusSpan.id = "leia-bar-status";
  statusSpan.style.cssText = "color:#a8a29e;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

  root.append(back, play, fwd, stop, speed, statusSpan, close);
  document.documentElement.appendChild(root);
  return { root, play, stop, back, fwd, speed, status: statusSpan };
}

function startReading(): void {
  staleNotice = null;
  const scope = captureScope(window);
  if (!scope) {
    clearLoading();
    if (els) els.status.textContent = "no readable article — select text";
    return;
  }
  void browser.runtime
    .sendMessage({ type: "leia:reader:start", tokens: scope.tokens })
    .then((reply) => {
      const r = reply as RouterReply | undefined;
      const data = r?.data as (SessionStatus & { locale?: string | null }) | undefined;
      if (data?.sessionId) {
        highlighter.bind(data.sessionId, scope, data.locale ?? null);
      } else if (r && shouldClearLoading({ type: "reply", ok: r.ok })) {
        clearLoading();
        if (els) els.status.textContent = `failed: ${String(r.error ?? "?").slice(0, 80)}`;
      }
      // ok reply: stay pending — the first leia:highlight:set clears it.
    })
    .catch(() => {
      clearLoading();
      if (els) els.status.textContent = "start failed";
    });
}

function mount(): void {
  if (els) return;
  els = buildBar();

  els.play.addEventListener("click", () => {
    const action = playAction(status.state);
    const kind = loadingKindForAction(action);
    if (kind) beginLoading(kind);
    switch (action) {
      case "start":
        startReading();
        break;
      case "resume":
        void browser.runtime
          .sendMessage({ type: "leia:reader:resume" })
          .then((r) => {
            const reply = r as RouterReply | undefined;
            if (reply && shouldClearLoading({ type: "reply", ok: reply.ok })) {
              clearLoading();
              if (els) els.status.textContent = `failed: ${String(reply.error ?? "?").slice(0, 80)}`;
            }
          })
          .catch(() => clearLoading());
        break;
      case "pause":
        void browser.runtime.sendMessage({ type: "leia:reader:pause" });
        break;
    }
  });

  els.stop.addEventListener("click", () => {
    void browser.runtime.sendMessage({ type: "leia:reader:stop" });
  });

  els.back.addEventListener("click", () => {
    if (canSeekBack(status)) {
      void browser.runtime.sendMessage({ type: "leia:reader:seek", token: prevToken(status.tokenPos) });
    }
  });

  els.fwd.addEventListener("click", () => {
    if (canSeekForward(status)) {
      void browser.runtime.sendMessage({ type: "leia:reader:seek", token: nextToken(status.tokenPos, status.tokenCount) });
    }
  });

  // Close: hand the controls to the popup. The storage flag flip unmounts
  // this bar via the onChanged listener below.
  const closeBtn = els.root.querySelector("#leia-cmd-close") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => {
    void browser.storage.local.set({ [CONTROLS_IN_PAGE_KEY]: false });
  });

  els.speed.addEventListener("change", () => {
    void browser.runtime.sendMessage({ type: "leia:reader:prefs", rate: Number(els!.speed.value) });
  });

  // Sync with background state.
  void browser.runtime.sendMessage({ type: "leia:reader:status" }).then((s) => {
    if (s) status = s as SessionStatus;
    render();
  });
  render();
}

function unmount(): void {
  els?.root.remove();
  els = null;
}

function applySurface(inPage: boolean): void {
  if (inPage) mount();
  else unmount();
}

// Respond-only-if-handled wiring (see messaging.ts for the WHY): every arm
// here is a sync plain return, so the async-listener version either dropped
// them (polyfill) or hijacked channels for messages it doesn't own.
function handleBarStatus(): RouterReply {
  return { ok: true, replyType: "leia:bar-status", data: { mounted: els !== null, id: BAR_ID } };
}

function handleBarHighlightSet(msg: RouterMessage): undefined {
  // First highlight = audio actually began: end the Play pending state.
  if (loading && shouldClearLoading({ type: "highlight" })) clearLoading();
  const m = msg as unknown as {
    sessionId: string;
    from: number;
    to: number;
    word?: { begin: number; end: number };
    timeline?: Parameters<typeof march.arm>[3];
  };
  highlighter.show(m.sessionId, m.from, m.to, m.word);
  if (m.timeline) march.arm(m.sessionId, m.from, m.to, m.timeline);
  return undefined;
}

function handleBarHighlightClear(msg: RouterMessage): undefined {
  march.disarm();
  highlighter.clear((msg as unknown as { sessionId: string }).sessionId);
  return undefined;
}

// Pause/stop/seek halt the local march (no further words arrive).
function handleBarSessionState(msg: RouterMessage): undefined {
  status = (msg as unknown as { status: SessionStatus }).status;
  if (status.state !== "playing") march.disarm();
  if (loading && shouldClearLoading({ type: "state", state: status.state })) clearLoading();
  render();
  return undefined;
}

// Surface engine failures directly on the bar (T17) — the popup is
// usually closed exactly when these fire.
function handleBarSessionError(msg: RouterMessage): undefined {
  if (loading && shouldClearLoading({ type: "error" })) clearLoading();
  staleNotice = `engine: ${(msg as unknown as { message: string }).message}`;
  render();
  return undefined;
}

addReplyListener((msg: unknown) => {
  if (!isRouterMessage(msg)) return undefined;
  switch (msg.type) {
    case "leia:bar-status":
      return handleBarStatus();
    // Marching highlight for the bar-captured path: the background only
    // binds the content-script highlighter for its own captures, so the
    // bar applies highlight events to the scope it bound itself — and runs
    // the local word march for them (see content/march.ts).
    case "leia:highlight:set":
      return handleBarHighlightSet(msg);
    case "leia:highlight:clear":
      return handleBarHighlightClear(msg);
    case "leia:session:state":
      return handleBarSessionState(msg);
    case "leia:session:error":
      return handleBarSessionError(msg);
    default:
      return routeMessage(msg) ?? undefined;
  }
});

// Surface flag: mount per stored value, then follow live toggles from the
// popup ("Open in page") without a tab reload.
browser.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area !== "local" || !(CONTROLS_IN_PAGE_KEY in changes)) return;
  applySurface(changes[CONTROLS_IN_PAGE_KEY].newValue === true);
});

void browser.storage.local.get(CONTROLS_IN_PAGE_KEY).then((got) => {
  applySurface(controlsInPage(got[CONTROLS_IN_PAGE_KEY]));
});
