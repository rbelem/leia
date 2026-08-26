/**
 * Page-side read-scope capture + highlight binding (content-script world).
 * A page context captures the user's selection or the page's main article
 * (T3: Mozilla Readability extraction on a detached clone, mapped back to a
 * live container), converts it to sentence tokens, and binds the resulting
 * index to the session id the background assigns. Highlight events from the
 * background are applied locally.
 */
import type { TokenText } from "../reader/session";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { tokenIndexFromRange, tokenIndexFromSelection } from "../reader/token-index";
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

/**
 * T3 article capture. Readability.parse mutates its input document, so it
 * runs on a detached body clone; the article container is then located on
 * the LIVE DOM as the deepest element whose normalized text still covers
 * the extracted text (Readability only ever removed text, so the container
 * is the tightest superset of it), and that container's full text range is
 * tokenized like any selection.
 */
export function captureArticle(win: Window): CapturedScope | null {
  const doc = win.document;
  if (!doc.body || !isProbablyReaderable(doc)) return null;
  const cloneDoc = doc.implementation.createHTMLDocument("");
  cloneDoc.body.appendChild(cloneDoc.importNode(doc.body, true));
  let textContent: string;
  try {
    const parsed = new Readability(cloneDoc).parse();
    if (!parsed?.textContent) return null;
    textContent = parsed.textContent;
  } catch {
    return null; // malformed page — degrade to the selection flow
  }
  const norm = textContent.replace(/\s+/g, "");
  if (norm.length === 0) return null;
  const root = deepestCoveringElement(doc.body, norm.length);
  if (!root) return null;
  const range = doc.createRange();
  range.selectNodeContents(root);
  const tokens = tokenIndexFromRange(range);
  if (tokens.length === 0) return null;
  return { tokens: tokens.map((t) => ({ text: t.text })), ranges: tokens.map((t) => t.range) };
}

/** Scope decision: explicit selection first, else the article (T3), else null. */
export function captureScope(win: Window): CapturedScope | null {
  return captureSelection(win) ?? captureArticle(win);
}

/**
 * Deepest element whose text covers `minLen` normalized (whitespace-free)
 * characters. Normalization only shrinks text, so the cheap length check
 * prunes whole subtrees first.
 */
function deepestCoveringElement(root: Element, minLen: number): Element | null {
  let best: Element | null = null;
  let bestDepth = -1;
  const walk = (el: Element, depth: number): void => {
    if (el.textContent.length >= minLen) {
      if (el.textContent.replace(/\s+/g, "").length >= minLen && depth > bestDepth) {
        best = el;
        bestDepth = depth;
      }
      for (const child of el.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return best;
}

/**
 * Heavy-mutation thresholds: a mutation batch at/above either one marks the
 * scope stale. ponytail: fixed heuristics — tune against real SPA mutation
 * profiles if false positives/negatives show up.
 */
export const STALE_NODE_THRESHOLD = 24;
export const STALE_CHAR_THRESHOLD = 120;

export interface ScopeHighlighterOptions {
  /** Fired once when the bound scope is invalidated by heavy page mutation. */
  onStale?: () => void;
}

/** One live binding per content-script context; the newest capture wins. */
export class ScopeHighlighter {
  private sessionId: string | null = null;
  private ranges: Range[] = [];
  private observer: MutationObserver | null = null;
  private stale = false;
  private readonly onStale?: () => void;

  constructor(options: ScopeHighlighterOptions = {}) {
    this.onStale = options.onStale;
  }

  bind(sessionId: string, scope: CapturedScope): void {
    this.sessionId = sessionId;
    this.ranges = scope.ranges;
    this.stale = false;
    this.startObserving(scopeRangesRoot(scope.ranges));
  }

  /** Apply the highlight for token indices [from..to] when bound and live. */
  show(sessionId: string, from: number, to: number): void {
    if (sessionId !== this.sessionId || this.stale) return;
    if (!this.isLive()) {
      this.markStale(); // observer missed it, but the ranges are dead
      return;
    }
    setHighlight(this.ranges.slice(from, to + 1));
  }

  clear(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.sessionId = null;
    this.ranges = [];
    this.stale = false;
    this.stopObserving();
    clearHighlight();
  }

  // --- internals ---

  private isLive(): boolean {
    return this.ranges.every((r) => r.startContainer.isConnected);
  }

  private markStale(): void {
    if (this.stale) return;
    this.stale = true;
    this.stopObserving();
    clearHighlight();
    this.onStale?.();
  }

  private startObserving(root: Node | null): void {
    this.stopObserving();
    if (!root) return;
    const rootEl = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
    if (!rootEl) return;
    // Observe the parent: a content swap that replaces the root itself is
    // visible as the root appearing in removedNodes.
    const target = rootEl.parentElement ?? rootEl;
    this.observer = new MutationObserver((records) => this.onMutations(records, rootEl));
    this.observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
  }

  private stopObserving(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private onMutations(records: MutationRecord[], root: Element): void {
    if (this.stale) return;
    let nodes = 0;
    let chars = 0;
    for (const rec of records) {
      if (rec.type === "childList") {
        if (Array.from(rec.removedNodes).includes(root)) {
          this.markStale(); // the scope root itself was replaced
          return;
        }
        if (root.contains(rec.target)) nodes += rec.addedNodes.length + rec.removedNodes.length;
      } else if (rec.type === "characterData" && root.contains(rec.target)) {
        chars += Math.abs((rec.target as Text).data.length - (rec.oldValue ?? "").length);
      }
    }
    if (nodes >= STALE_NODE_THRESHOLD || chars >= STALE_CHAR_THRESHOLD) this.markStale();
  }
}

/** Minimal node spanning the whole scope (first range start → last range end). */
function scopeRangesRoot(ranges: Range[]): Node | null {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first || !last) return null;
  const doc = first.startContainer.ownerDocument;
  if (!doc) return null;
  const r = doc.createRange();
  r.setStart(first.startContainer, first.startOffset);
  r.setEnd(last.endContainer, last.endOffset);
  const root = r.commonAncestorContainer;
  return root.nodeType === Node.ELEMENT_NODE ? root : (root.parentElement ?? root);
}