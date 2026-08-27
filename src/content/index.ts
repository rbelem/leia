import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "../background/router";
import { pageInfoFromDocument } from "./page-info";
import { captureScope, ScopeHighlighter, type CapturedScope } from "./scope";
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

browser.runtime.onMessage.addListener((msg: unknown): RouterReply | undefined => {
  if (!isRouterMessage(msg)) return undefined;
  if (msg.type === "leia:page-info") {
    return { ok: true, replyType: "leia:page-info", data: pageInfoFromDocument(document) };
  }
  // Toolbar-action fallback: capture the page scope on demand (T2 item 6, T3
  // article fallback). The scope lives in this page context, so it stays
  // here; the background later binds the session id to it.
  if (msg.type === "leia:selection:capture") {
    const scope = captureScope(window);
    if (!scope) {
      return {
        ok: false,
        replyType: "leia:selection:capture",
        error: "no selection and no readable article on this page",
      };
    }
    captureSeq += 1;
    pendingScope = scope;
    return { ok: true, replyType: "leia:selection:capture", data: { captureId: captureSeq, tokens: scope.tokens } };
  }
  if (msg.type === "leia:selection:bind") {
    const m = msg as unknown as { sessionId: string; captureId?: number; locale?: string | null };
    if (m.captureId === undefined || m.captureId === captureSeq) {
      if (pendingScope) highlighter.bind(m.sessionId, pendingScope, m.locale ?? null);
      pendingScope = null;
    }
    return { ok: true, replyType: "leia:selection:bind" };
  }
  if (msg.type === "leia:highlight:set") {
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
  if (msg.type === "leia:highlight:clear") {
    march.disarm();
    highlighter.clear((msg as unknown as { sessionId: string }).sessionId);
    return undefined;
  }
  // Pause/stop/seek must halt the local march (no further words arrive).
  if (msg.type === "leia:session:state") {
    const st = (msg as unknown as { status?: { state?: string } }).status;
    if (st?.state !== "playing") march.disarm();
    return undefined;
  }
  // Live theme swaps relayed from the popup settings (T14).
  if (msg.type === "leia:theme:set") {
    const t = (msg as unknown as { theme?: string }).theme;
    if (t && (THEME_IDS as string[]).includes(t)) setTheme(t as ThemeId);
    return undefined;
  }
  return routeMessage(msg) ?? undefined;
});
