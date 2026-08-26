import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "../background/router";
import { pageInfoFromDocument } from "./page-info";
import { captureSelection, ScopeHighlighter, type CapturedScope } from "./scope";
import { ensureHighlightStyle } from "./highlight";

// Marching-highlight stylesheet + capture state for the toolbar-action path.
ensureHighlightStyle(document);
const highlighter = new ScopeHighlighter();

let captureSeq = 0;
let pendingScope: CapturedScope | null = null;

browser.runtime.onMessage.addListener((msg: unknown): RouterReply | undefined => {
  if (!isRouterMessage(msg)) return undefined;
  if (msg.type === "leia:page-info") {
    return { ok: true, replyType: "leia:page-info", data: pageInfoFromDocument(document) };
  }
  // Toolbar-action fallback: capture the page selection on demand (T2 item 6).
  // The selection lives in this page context, so the scope stays here; the
  // background later binds the session id to it.
  if (msg.type === "leia:selection:capture") {
    const scope = captureSelection(window);
    if (!scope) {
      return { ok: false, replyType: "leia:selection:capture", error: "no text selected" };
    }
    captureSeq += 1;
    pendingScope = scope;
    return { ok: true, replyType: "leia:selection:capture", data: { captureId: captureSeq, tokens: scope.tokens } };
  }
  if (msg.type === "leia:selection:bind") {
    const m = msg as unknown as { sessionId: string; captureId?: number };
    if (m.captureId === undefined || m.captureId === captureSeq) {
      if (pendingScope) highlighter.bind(m.sessionId, pendingScope);
      pendingScope = null;
    }
    return { ok: true, replyType: "leia:selection:bind" };
  }
  if (msg.type === "leia:highlight:set") {
    const m = msg as unknown as { sessionId: string; from: number; to: number };
    highlighter.show(m.sessionId, m.from, m.to);
    return undefined;
  }
  if (msg.type === "leia:highlight:clear") {
    highlighter.clear((msg as unknown as { sessionId: string }).sessionId);
    return undefined;
  }
  return routeMessage(msg) ?? undefined;
});