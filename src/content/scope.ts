/**
 * Page-side read-scope capture + highlight binding (content-script world).
 * A page context captures the user's selection once (floating bar, or the
 * content script on the toolbar-action fallback), converts it to sentence
 * tokens, and binds the resulting index to the session id the background
 * assigns. Highlight events from the background are applied locally.
 */
import type { TokenText } from "../reader/session";
import { tokenIndexFromSelection } from "../reader/token-index";
import { clearHighlight, setHighlight } from "./highlight";

export interface CapturedScope {
  tokens: TokenText[];
  /** Range per token index — kept in the page, never serialized. */
  ranges: Range[];
}

export function captureSelection(win: Window): CapturedScope | null {
  const tokens = tokenIndexFromSelection(win);
  if (!tokens) return null;
  return { tokens: tokens.map((t) => ({ text: t.text })), ranges: tokens.map((t) => t.range) };
}

/** One live binding per content-script context; the newest capture wins. */
export class ScopeHighlighter {
  private sessionId: string | null = null;
  private ranges: Range[] = [];

  bind(sessionId: string, scope: CapturedScope): void {
    this.sessionId = sessionId;
    this.ranges = scope.ranges;
  }

  /** Apply the highlight for token indices [from..to] when bound. */
  show(sessionId: string, from: number, to: number): void {
    if (sessionId !== this.sessionId) return;
    setHighlight(this.ranges.slice(from, to + 1));
  }

  clear(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.sessionId = null;
    this.ranges = [];
    clearHighlight();
  }
}