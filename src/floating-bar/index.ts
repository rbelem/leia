/**
 * Floating bar (page context): "Read selection", Play/Pause, Stop, speed.
 * Captures the page scope itself (T2 item 6 — the bar lives in the
 * page — with the T3 article fallback), binds the sentence-token index to
 * the session, and applies the marching highlight from background events.
 * `mousedown` is prevented on the bar so clicking it never steals the
 * page's selection or focus.
 */
import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "../background/router";
import { captureScope, ScopeHighlighter } from "../content/scope";
import { ensureHighlightStyle } from "../content/highlight";
import type { SessionStatus } from "../reader/session";

const BAR_ID = "leia-floating-bar";
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];

ensureHighlightStyle(document);
// A heavy mutation on the bound scope (SPA content swap) invalidates the
// read: stop playback and surface the page-changed state.
const highlighter = new ScopeHighlighter({ onStale: handleScopeStale });

interface BarElements {
  root: HTMLElement;
  read: HTMLButtonElement;
  toggle: HTMLButtonElement;
  stop: HTMLButtonElement;
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

function handleScopeStale(): void {
  staleNotice = "page changed — select text";
  render();
  void browser.runtime.sendMessage({ type: "leia:reader:stop" }).catch(() => {});
}

function render(): void {
  if (!els) return;
  els.toggle.disabled = status.state === "stopped";
  els.stop.disabled = status.state === "stopped";
  els.toggle.textContent = stateLabel(status.state);
  els.speed.value = String(status.settings.rate);
  els.status.textContent =
    staleNotice ??
    (status.state === "stopped"
      ? "select text, then Read selection"
      : `${status.state} · sentence ${Math.min(status.tokenPos + 1, status.tokenCount)}/${status.tokenCount}`);
}

function stateLabel(s: SessionStatus["state"]): string {
  return s === "playing" ? "⏸ Pause" : s === "paused" ? "▶ Resume" : "▶ Play";
}

function ensureBar(): BarElements {
  const existing = document.getElementById(BAR_ID);
  if (existing) {
    const c = (id: string) => existing.querySelector(id) as HTMLButtonElement;
    return {
      root: existing,
      read: c("#leia-cmd-read"),
      toggle: c("#leia-cmd-toggle"),
      stop: c("#leia-cmd-stop"),
      speed: existing.querySelector("#leia-speed") as HTMLSelectElement,
      status: existing.querySelector("#leia-bar-status") as HTMLSpanElement,
    };
  }

  const root = document.createElement("div");
  root.id = BAR_ID;
  root.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:6px;align-items:center;" +
    "padding:8px 12px;border-radius:999px;background:#1f2937;color:#f9fafb;" +
    "font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgb(0 0 0 / .35);user-select:none;";
  root.addEventListener("mousedown", (e) => e.preventDefault()); // keep page selection/focus

  const makeButton = (id: string, label: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.id = id;
    b.textContent = label;
    b.style.cssText =
      "border:1px solid rgb(255 255 255 / .25);background:rgb(255 255 255 / .1);color:inherit;" +
      "border-radius:999px;padding:3px 10px;font:inherit;cursor:pointer;";
    return b;
  };

  const read = makeButton("leia-cmd-read", "Read selection");
  const toggle = makeButton("leia-cmd-toggle", "▶ Play");
  const stop = makeButton("leia-cmd-stop", "Stop");

  const speed = document.createElement("select");
  speed.id = "leia-speed";
  speed.title = "Speed";
  speed.style.cssText = "border-radius:999px;padding:2px 4px;font:inherit;background:#374151;color:inherit;border:0;";
  for (const v of SPEED_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = `${v}×`;
    speed.appendChild(opt);
  }
  speed.value = "1";

  const statusSpan = document.createElement("span");
  statusSpan.id = "leia-bar-status";
  statusSpan.style.cssText = "color:#9ca3af;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

  root.append(read, toggle, stop, speed, statusSpan);
  document.documentElement.appendChild(root);
  return { root, read, toggle, stop, speed, status: statusSpan };
}

function initBar(): void {
  els = ensureBar();

  els.read.addEventListener("click", () => {
    staleNotice = null;
    const scope = captureScope(window);
    if (!scope) {
      els!.status.textContent = "no readable article — select text";
      return;
    }
    void browser.runtime
      .sendMessage({ type: "leia:reader:start", tokens: scope.tokens })
      .then((reply) => {
        const status = (reply as RouterReply | undefined)?.data as SessionStatus | undefined;
        if (status?.sessionId) highlighter.bind(status.sessionId, scope);
      })
      .catch(() => {
        els!.status.textContent = "start failed";
      });
  });

  els.toggle.addEventListener("click", () => {
    const type = status.state === "playing" ? "leia:reader:pause" : "leia:reader:resume";
    void browser.runtime.sendMessage({ type });
  });

  els.stop.addEventListener("click", () => {
    void browser.runtime.sendMessage({ type: "leia:reader:stop" });
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

browser.runtime.onMessage.addListener((msg: unknown): RouterReply | undefined => {
  if (!isRouterMessage(msg)) return undefined;
  if (msg.type === "leia:bar-status") {
    return { ok: true, replyType: "leia:bar-status", data: { mounted: true, id: BAR_ID } };
  }
  if (msg.type === "leia:session:state") {
    status = (msg as unknown as { status: SessionStatus }).status;
    render();
    return undefined;
  }
  return routeMessage(msg) ?? undefined;
});

initBar();