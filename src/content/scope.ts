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
import { tokenIndexFromRange, tokenIndexFromSelection, wordIndexFromRange, type Token } from "../reader/token-index";
import { wordSpans, type TokenSpan } from "../reader/sentences";
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
  /** Fired when a click inside the live scope maps to a token (T7 seek). */
  onSeek?: (token: number) => void;
}

/**
 * Map a viewport point to the sentence-token index whose range covers it
 * (T7 click-to-seek). Pure: callers resolve the caret and pass it in.
 */
export function tokenIndexAtPoint(ranges: Range[], x: number, y: number, doc: Document): number | null {
  const caret = caretRangeAtPoint(doc, x, y);
  if (caret === null || ranges.length === 0) return null;
  // Ranges are in document order and contiguous: the containing token is the
  // last whose start <= caret start; confirm the caret hasn't passed its end.
  let index = -1;
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges[i].compareBoundaryPoints(Range.START_TO_START, caret) <= 0) index = i;
    else break;
  }
  if (index < 0) return null;
  // Caret is collapsed, so caret.end <= token.end is the same containment
  // check as the spec's token.end >= caret.start — but END_TO_END is used
  // because jsdom inverts END_TO_START (this.start vs source.end).
  return caret.compareBoundaryPoints(Range.END_TO_END, ranges[index]) <= 0 ? index : null;
}

/** Collapsed caret range at a viewport point; null when unresolvable. */
function caretRangeAtPoint(doc: Document, x: number, y: number): Range | null {
  if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
  const caret = doc.caretPositionFromPoint?.(x, y);
  if (!caret) return null;
  const range = doc.createRange();
  range.setStart(caret.offsetNode, caret.offset);
  range.collapse(true);
  return range;
}

/** One live binding per content-script context; the newest capture wins. */
export class ScopeHighlighter {
  private sessionId: string | null = null;
  private ranges: Range[] = [];
  private doc: Document | null = null;
  private observer: MutationObserver | null = null;
  private stale = false;
  private readonly onStale?: () => void;
  private readonly onSeek?: (token: number) => void;
  /** Word-level index (T4) over the full scope + parallel char spans, built when a locale is given. */
  private wordMap: { words: Token[]; spans: TokenSpan[] } | null = null;
  /** Sentence token i → char offset of its start in the full scope text. */
  private prefix: Int32Array | null = null;

  constructor(options: ScopeHighlighterOptions = {}) {
    this.onStale = options.onStale;
    this.onSeek = options.onSeek;
  }

  bind(sessionId: string, scope: CapturedScope, locale?: string | null): void {
    this.sessionId = sessionId;
    this.ranges = scope.ranges;
    this.doc = scope.ranges[0]?.startContainer.ownerDocument ?? null;
    this.stale = false;
    this.wordMap = null;
    this.prefix = null;
    if (locale) {
      const full = fullScopeRange(scope.ranges);
      if (full) {
        const idx = wordIndexFromRange(full, locale);
        if (idx && idx.words.length > 0) {
          // Offsets derive from the same text + segmenter the index used;
          // the round-trip invariant makes scope.tokens.join("") === range text.
          const spans = wordSpans(scope.tokens.map((t) => t.text).join(""), locale);
          this.wordMap = { words: idx.words, spans };
          this.prefix = sentenceCharPrefixes(scope.tokens);
        }
      }
    }
    this.startObserving(scopeRangesRoot(scope.ranges));
    this.doc?.addEventListener("click", this.onClick);
  }

  /** Apply the highlight for token indices [from..to]; word-level span when given. */
  show(sessionId: string, from: number, to: number, word?: { begin: number; end: number }): void {
    if (sessionId !== this.sessionId || this.stale) return;
    if (!this.isLive()) {
      this.markStale(); // observer missed it, but the ranges are dead
      return;
    }
    if (word && word.end > word.begin && this.wordMap && this.prefix && from < this.prefix.length) {
      // Engine offsets are chunk-relative; map onto the full-scope word map.
      const global = this.prefix[from] + word.begin;
      const i = findWordIndex(this.wordMap.spans, global);
      if (i >= 0) {
        setHighlight([this.wordMap.words[i].range]);
        return;
      }
      // Word not in the map (whitespace boundary / split mismatch) — fall back.
    }
    setHighlight(this.ranges.slice(from, to + 1));
  }

  clear(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.sessionId = null;
    this.ranges = [];
    this.doc?.removeEventListener("click", this.onClick);
    this.doc = null;
    this.wordMap = null;
    this.prefix = null;
    this.stale = false;
    this.stopObserving();
    clearHighlight();
  }

  // --- internals ---

  /**
   * T7 click-to-seek: while bound, map a click inside the live scope to a
   * token index and fire onSeek. Extension chrome (id starting "leia-", e.g.
   * the floating bar) and stale scopes are ignored; page clicks keep their
   * default behavior (the listener never stops propagation).
   */
  private readonly onClick = (ev: MouseEvent): void => {
    if (this.sessionId === null || this.stale || this.onSeek === undefined || this.doc === null) return;
    if (ev.target instanceof Element && ev.target.closest("[id^='leia-']")) return;
    const token = tokenIndexAtPoint(this.ranges, ev.clientX, ev.clientY, this.doc);
    if (token === null) return;
    this.onSeek(token);
  };

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

/** Full-scope range (first token start → last token end); null when empty. */
function fullScopeRange(ranges: Range[]): Range | null {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first || !last) return null;
  const doc = first.startContainer.ownerDocument;
  if (!doc) return null;
  const r = doc.createRange();
  r.setStart(first.startContainer, first.startOffset);
  r.setEnd(last.endContainer, last.endOffset);
  return r;
}

/** prefix[i] = char offset of token i's start in the concatenated token text. */
function sentenceCharPrefixes(tokens: Array<{ text: string }>): Int32Array {
  const prefix = new Int32Array(tokens.length + 1);
  for (let i = 0; i < tokens.length; i += 1) prefix[i + 1] = prefix[i] + tokens[i].text.length;
  return prefix;
}

/** Binary search the word span containing `pos` (spans are [start, end)). */
function findWordIndex(spans: TokenSpan[], pos: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s.start) hi = mid - 1;
    else if (pos >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}