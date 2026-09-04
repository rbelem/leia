// SPDX-License-Identifier: MPL-2.0
import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterMessage, type RouterReply } from "../background/router";
import { addReplyListener } from "../messaging";
import { pageInfoFromDocument } from "./page-info";
import { captureScopeDetailed, ScopeHighlighter, type CapturedScope } from "./scope";
import { ensureHighlightStyle, setTheme } from "./highlight";
import { createMarch } from "./march";
import { THEME_IDS, type ThemeId } from "./themes";

// Honor the stored highlight theme (popup settings, T14) on page load.
void browser.storage.local
  .get("leia:settings:theme")
  .then((got: Record<string, unknown>) => {
    const t = got["leia:settings:theme"];
    if (typeof t === "string" && (THEME_IDS as string[]).includes(t)) setTheme(t as ThemeId);
  })
  .catch(() => {});

// Marching-highlight stylesheet + capture state for the toolbar-action path.
ensureHighlightStyle(document);
// A heavy mutation on the bound scope (SPA content swap) invalidates the
// read: stop playback; the page is no longer what we tokenized.
const highlighter = new ScopeHighlighter({
  onStale: () => void browser.runtime.sendMessage({ type: "leia:reader:stop" }).catch(() => {}),
  onSeek: (token) => void browser.runtime.sendMessage({ type: "leia:reader:seek", token }).catch(() => {}),
});

// Local word march (visible tab = unthrottled rAF; the engine ships the
// chunk timeline once). Only meaningful when THIS script's highlighter is
// the bound renderer (toolbar-selection path); the floating-bar path runs
// its own march for the scope it captured.
const march = createMarch({
  apply: (sessionId, from, to, word) => highlighter.show(sessionId, from, to, word),
  owns: (sessionId) => highlighter.hasSession(sessionId),
});

let captureSeq = 0;
let pendingScope: CapturedScope | null = null;

function handlePageInfoMsg(): RouterReply {
  return { ok: true, replyType: "leia:page-info", data: pageInfoFromDocument(document) };
}

// Toolbar-action fallback: capture the page scope on demand (T2 item 6, T3
// article fallback). The scope lives in this page context, so it stays
// here; the background later binds the session id to it.
function handleCaptureMsg(): RouterReply {
  const { scope, reason } = captureScopeDetailed(window);
  if (!scope) {
    return {
      ok: false,
      replyType: "leia:selection:capture",
      error: reason ?? "no selection and no readable article on this page",
    };
  }
  captureSeq += 1;
  pendingScope = scope;
  return { ok: true, replyType: "leia:selection:capture", data: { captureId: captureSeq, tokens: scope.tokens } };
}

function handleBindMsg(msg: RouterMessage): RouterReply {
  const m = msg as unknown as { sessionId: string; captureId?: number; locale?: string | null };
  if (m.captureId === undefined || m.captureId === captureSeq) {
    if (pendingScope) highlighter.bind(m.sessionId, pendingScope, m.locale ?? null);
    pendingScope = null;
  }
  return { ok: true, replyType: "leia:selection:bind" };
}

interface HighlightSet {
  sessionId: string;
  from: number;
  to: number;
  word?: { begin: number; end: number };
  timeline?: Parameters<typeof march.arm>[3];
}

function handleHighlightSetMsg(msg: RouterMessage): undefined {
  const m = msg as unknown as HighlightSet;
  highlighter.show(m.sessionId, m.from, m.to, m.word);
  if (m.timeline) march.arm(m.sessionId, m.from, m.to, m.timeline);
  return undefined;
}

function handleHighlightClearMsg(msg: RouterMessage): undefined {
  march.disarm();
  highlighter.clear((msg as unknown as { sessionId: string }).sessionId);
  return undefined;
}

// Pause/stop/seek must halt the local march (no further words arrive).
function handleSessionStateMsg(msg: RouterMessage): undefined {
  const st = (msg as unknown as { status?: { state?: string } }).status;
  if (st?.state !== "playing") march.disarm();
  return undefined;
}

// Live theme swaps relayed from the popup settings (T14).
function handleThemeSetMsg(msg: RouterMessage): undefined {
  const t = (msg as unknown as { theme?: string }).theme;
  if (t && (THEME_IDS as string[]).includes(t)) setTheme(t as ThemeId);
  return undefined;
}

// Respond-only-if-handled wiring (see messaging.ts for the WHY): the triage
// below is synchronous, so unhandled message types never claim this tab's
// reply channel. Handlers stay untouched.
addReplyListener((msg: unknown) => {
  if (!isRouterMessage(msg)) return undefined;
  switch (msg.type) {
    case "leia:page-info":
      return handlePageInfoMsg();
    case "leia:selection:capture":
      return handleCaptureMsg();
    case "leia:selection:bind":
      return handleBindMsg(msg);
    case "leia:highlight:set":
      return handleHighlightSetMsg(msg);
    case "leia:highlight:clear":
      return handleHighlightClearMsg(msg);
    case "leia:session:state":
      return handleSessionStateMsg(msg);
    case "leia:theme:set":
      return handleThemeSetMsg(msg);
    default:
      return routeMessage(msg) ?? undefined;
  }
});
