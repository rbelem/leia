// SPDX-License-Identifier: MPL-2.0
/**
 * Page-side read-scope capture + highlight binding (content-script world).
 * A page context captures the user's selection or the page's main article
 * (T3: Mozilla Readability extraction on a detached clone, mapped back to a
 * live container), converts it to sentence tokens, and binds the resulting
 * index to the session id the background assigns. Highlight events from the
 * background are applied locally.
 */
import type { TokenText } from "../reader/session";
import { Readability, isProbablyReaderable } from "@mozilla/readability";import { tokenIndexFromRange, tokenIndexFromSelection, wordIndexFromRange, type Token } from "../reader/token-index";
import { wordSpans, type TokenSpan } from "../reader/sentences";
import { clearHighlight, setHighlight, setWordHighlight } from "./highlight";

/** Token begins its own reading unit (block start or heading). */
function startsUnit(t: TokenText | undefined): boolean {
  return !!t && (t.blockStart === true || t.heading === true);
}

export interface CapturedScope {
  tokens: TokenText[];
  /** Range per token index — kept in the page, never serialized. */
  ranges: Range[];
  /**
   * Token index where the article body starts; tokens before it were
   * captured from a separate title element (UOL pattern). Absent/0 when the
   * whole scope is one contiguous range walk.
   */
  bodyFrom?: number;
}

export function captureSelection(win: Window): CapturedScope | null {
  const tokens = tokenIndexFromSelection(win);
  if (!tokens) return null;
  return {
    tokens: tokens.map(({ text, blockStart, heading }) =>
      blockStart || heading ? { text, ...(blockStart && { blockStart }), ...(heading && { heading }) } : { text },
    ),
    ranges: tokens.map((t) => t.range),
  };
}

/**
 * T3 article capture. Readability.parse mutates its input document, so it
 * runs on a detached body clone; the article container is then located on
 * the LIVE DOM as the deepest element whose normalized text still covers
 * the extracted text (Readability only ever removed text, so the container
 * is the tightest superset of it). The body container's range and the
 * title's range are tokenized SEPARATELY and concatenated: one merged
 * range (title start → body end) makes the index walk start at the two
 * ranges' common ancestor and emit every visible text in between and
 * beyond (kicker eyebrow, byline, sibling chunks — the UOL collapse), so
 * the scope must be assembled from tight per-element ranges. See
 * captureArticleDetailed for the stage-tracked variant.
 */
export function captureArticle(win: Window): CapturedScope | null {
  return captureArticleDetailed(win).scope;
}

/** Scope decision: explicit selection first, else the article (T3), else null. */
export function captureScope(win: Window): CapturedScope | null {
  return captureScopeDetailed(win).scope;
}

export interface ScopeCapture {
  scope: CapturedScope | null;
  /** Human-readable reason the capture failed; null when scope is non-null. */
  reason: string | null;
}

/** captureScope with the failure reason surfaced (popup diagnostics T-err). */
export function captureScopeDetailed(win: Window): ScopeCapture {
  const selection = captureSelection(win);
  if (selection) return { scope: selection, reason: null };
  const article = captureArticleDetailed(win);
  if (article.scope) return { scope: article.scope, reason: null };
  return { scope: null, reason: `no selection; ${article.reason}` };
}

/** Stage-by-stage article capture; keeps captureArticle's public shape. */
function captureArticleDetailed(win: Window): { scope: CapturedScope | null; reason: string } {
  const doc = win.document;
  if (!doc.body) return { scope: null, reason: "page has no body" };
  if (!isProbablyReaderable(doc)) return { scope: null, reason: "page is not readable (no article-like content)" };
  const cloneDoc = doc.implementation.createHTMLDocument("");
  cloneDoc.body.appendChild(cloneDoc.importNode(doc.body, true));
  let textContent: string;
  try {
    const parsed = new Readability(cloneDoc).parse();
    if (!parsed?.textContent) return { scope: null, reason: "Readability extracted no article text" };
    textContent = parsed.textContent;
  } catch (err) {
    return { scope: null, reason: `Readability failed: ${String(err)}` };
  }
  const norm = textContent.replace(/\s+/g, "");
  if (norm.length === 0) return { scope: null, reason: "Readability extracted no article text" };
  const root = deepestCoveringElement(doc.body, norm);
  if (!root) return { scope: null, reason: "no element in the page covers the extracted article text" };
  // UOL pattern: the H1 lives in a separate container far above the body
  // root (ads/hero in between), so opening on the root reads mid-article
  // with no headline. When a title qualifies it is tokenized as its own
  // leading segment (heading flag, read exactly once) — unless the body
  // root already opens with the title text (echo), which must not be read
  // twice.
  const title = articleTitleElement(doc, root);
  const titleTokens =
    title && !opensWithNormalized(root.textContent, title.textContent)
      ? tokenIndexFromRange(tightRange(doc, title))
      : [];
  const bodyTokens = tokenIndexFromRange(tightRange(doc, root));
  const tokens = [...titleTokens, ...bodyTokens];
  if (tokens.length === 0) return { scope: null, reason: "extracted article produced no readable tokens" };
  return {
    scope: {
      tokens: tokens.map(({ text, blockStart, heading }) =>
        blockStart || heading ? { text, ...(blockStart && { blockStart }), ...(heading && { heading }) } : { text },
      ),
      ranges: tokens.map((t) => t.range),
      ...(titleTokens.length > 0 && { bodyFrom: titleTokens.length }),
    },
    reason: "",
  };
}

/** Contents of `el` as a range (the only shape whose index walk emits
 * exactly the element's own visible text — a wider range's walk starts at
 * the common ancestor and leaks the siblings around it). */
function tightRange(doc: Document, el: Element): Range {
  const range = doc.createRange();
  range.selectNodeContents(el);
  return range;
}

/** True when `text`'s normalized form starts with `prefix`'s normalized
 * form (the body root's first block already IS the title — an echo). */
function opensWithNormalized(text: string | null, prefix: string | null): boolean {
  const norm = (s: string | null) => (s ?? "").replace(/\s+/g, "").toLowerCase();
  const p = norm(prefix);
  return p.length > 0 && norm(text).startsWith(p);
}

/**
 * Deepest element whose normalized text contains `articleText` (normalized,
 * whitespace-free). Readability only ever removed text from a faithful
 * clone, so the extracted article text is a subsequence of every true
 * ancestor container — the deepest such element is the tightest superset,
 * i.e. the article container. The cheap length check prunes whole subtrees
 * first, but a bare length match is not containment: a deep <style> block
 * or nav menu can reach the article's text length without holding it (real
 * UOL regression), so candidates must contain the text as a subsequence.
 * When no element contains the text (exotic extraction differences), fall
 * back to the deepest element covering a substantial fraction of it
 (LENGTH_COVER_FRACTION) — a deep widget that shares only stray words with
 * the article must not win the cover just by being long. Only when even
 * that finds nothing does the legacy deepest-length pick stand, so exotic
 * pages keep today's behavior instead of failing the capture.
 */
const LENGTH_COVER_FRACTION = 0.6;

function deepestCoveringElement(root: Element, articleText: string): Element | null {
  let best: Element | null = null;
  let bestDepth = -1;
  let partial: Element | null = null;
  let partialDepth = -1;
  let loose: Element | null = null;
  let looseDepth = -1;
  const walk = (el: Element, depth: number): void => {
    if (el.textContent.length >= articleText.length) {
      const covered = coversText(el.textContent.replace(/\s+/g, ""), articleText) / articleText.length;
      if (depth > looseDepth) {
        loose = el;
        looseDepth = depth;
      }
      if (covered >= LENGTH_COVER_FRACTION && depth > partialDepth) {
        partial = el;
        partialDepth = depth;
      }
      if (covered === 1 && depth > bestDepth) {
        best = el;
        bestDepth = depth;
      }
      for (const child of el.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return best ?? partial ?? loose;
}

/** Greedy two-pointer subsequence count: how many chars of `probe` appear
 * in `text`, in order (probe.length = full containment). */
function coversText(text: string, probe: string): number {
  let i = 0;
  for (let j = 0; j < text.length && i < probe.length; j += 1) {
    if (text.charCodeAt(j) === probe.charCodeAt(i)) i += 1;
  }
  return i;
}

/** Closest article/main ancestor, falling back to document.body. */
function sharedArticleContainer(el: Element, doc: Document): Element {
  return el.closest("article, main") ?? doc.body;
}

/**
 * Title element to read before the article body root: the nearest preceding
 * h1 (fallback h2) in document order that (a) shares the root's article/main
 * ancestor (document.body fallback), (b) is not already inside the root (it
 * is read first by the root walk there), (c) is visible, and (d) has
 * non-blank text. null when no heading qualifies — capture stays
 * byte-identical.
 */
function articleTitleElement(doc: Document, root: Element): Element | null {
  const container = sharedArticleContainer(root, doc);
  for (const tag of ["h1", "h2"]) {
    let nearest: Element | null = null;
    for (const el of container.querySelectorAll(tag)) {
      if (root.contains(el)) continue;
      if (sharedArticleContainer(el, doc) !== container) continue;
      // Nearest preceding in document order: keep the last one before root.
      if (!(el.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (isHiddenElement(el) || el.textContent.trim().length === 0) continue;
      nearest = el;
    }
    if (nearest) return nearest;
  }
  return null;
}

/** Mirror of the capture walk's hidden-subtree test ([hidden],
 * aria-hidden="true", inline or computed display:none): a title the reader
 * cannot see must not be read. Kept local — token-index does not export it. */
function isHiddenElement(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const inline = (el as HTMLElement).style;
  if (inline && inline.display === "none") return true;
  const view = el.ownerDocument?.defaultView;
  if (view && typeof view.getComputedStyle === "function") {
    try {
      if (view.getComputedStyle(el).display === "none") return true;
    } catch {
      // exotic element/view — the attribute and inline checks above stand
    }
  }
  return false;
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
  /**
   * Body-segment bookkeeping (title-extended scopes): tokens before
   * bodyFrom live in a separate title element; the word index covers only
   * the body range, so word lookups re-base by the title's char length.
   */
  private bodyFrom = 0;
  private titleChars = 0;
  /** Scope carries block structure (blockStart/heading flags) — enables whole-block washes. */
  private hasBlocks = false;
  /** Raw token texts+flags of the bound scope (block wash expansion). */
  private scopeTokens: TokenText[] | null = null;

  constructor(options: ScopeHighlighterOptions = {}) {
    this.onStale = options.onStale;
    this.onSeek = options.onSeek;
  }

  bind(sessionId: string, scope: CapturedScope, locale?: string | null): void {
    this.sessionId = sessionId;
    this.ranges = scope.ranges;
    this.scopeTokens = scope.tokens;
    this.doc = scope.ranges[0]?.startContainer.ownerDocument ?? null;
    this.stale = false;
    this.wordMap = null;
    this.prefix = null;
    this.bodyFrom = scope.bodyFrom ?? 0;
    this.titleChars = scope.tokens
      .slice(0, this.bodyFrom)
      .reduce((n, t) => n + t.text.length, 0);
    this.hasBlocks = scope.tokens.some((t) => t.blockStart === true || t.heading === true);
    if (locale) {
      // The word index must flow through the same walk as the tokens it
      // aligns with: title-extended scopes tokenize the title and the body
      // as separate ranges, so only the body segment is one walk — index
      // it alone and re-base word lookups past the title's characters.
      const bodyRanges = this.bodyFrom > 0 ? scope.ranges.slice(this.bodyFrom) : scope.ranges;
      const full = fullScopeRange(bodyRanges);
      if (full) {
        const idx = wordIndexFromRange(full, locale);
        if (idx && idx.words.length > 0) {
          const bodyText = scope.tokens
            .slice(this.bodyFrom)
            .map((t) => t.text)
            .join("");
          // Offsets derive from the same text + segmenter the index used;
          // both indexes flow through the same capture walk (hidden-subtree
          // and heading-echo filtering included), so
          // bodyText === the word index's joined text.
          const spans = wordSpans(bodyText, locale);
          this.wordMap = { words: idx.words, spans };
          this.prefix = sentenceCharPrefixes(scope.tokens);
        }
      }
    }
    this.startObserving(scopeRangesRoot(scope.ranges));
    this.doc?.addEventListener("click", this.onClick);
  }

  /**
   * Apply the highlight for token indices [from..to]. Two layers: the
   * sentence wash always covers the chunk; a word span (when the engine
   * has word timing) adds the spoken-word emphasis on top of it.
   * The sentence start also re-centers the viewport on the reading
   * position (deadzone-smoothed — see followReading).
   */
  show(sessionId: string, from: number, to: number, word?: { begin: number; end: number }): void {
    if (sessionId !== this.sessionId || this.stale) return;
    if (!this.isLive()) {
      this.markStale(); // observer missed it, but the ranges are dead
      return;
    }
    const sentence = this.ranges.slice(from, to + 1);
    setHighlight(this.blockExtent(from, to) ?? sentence);
    // A word that fails to map (subtitle gap/space entries) keeps the
    // previous underline instead of flickering it off for a frame.
    const wordRange = this.wordRange(from, word);
    if (wordRange !== null || !word) setWordHighlight(wordRange);
    this.followReading(sentence[0] ?? null);
  }

  /**
   * Widen [from..to] (the spoken chunk — long blocks split across
   * utterances) out to the enclosing block so the wash covers the whole
   * paragraph/cell/heading even while only part of it is being spoken.
   * null when the scope predates block capture.
   */
  private blockExtent(from: number, to: number): Range[] | null {
    if (!this.hasBlocks || !this.scopeTokens) return null;
    const n = Math.min(to, this.scopeTokens.length - 1);
    let s = from;
    while (s > 0 && !startsUnit(this.scopeTokens[s])) s -= 1;
    let e = n;
    while (e + 1 < this.scopeTokens.length && !startsUnit(this.scopeTokens[e + 1])) e += 1;
    // A heading that shares a chunk tail with body text keeps its wash tight.
    if (this.scopeTokens[s].heading && s < from) s = from;
    return this.ranges.slice(s, e + 1);
  }

  /**
   * Keep the sentence being read visible. Gentle centering scroll only when
   * the range is off-screen; user scrolling is never fought with — a fresh
   * sentence boundary is the next chance to re-center.
   */
  /**
   * Keep the sentence being read near the CENTER of the viewport. Each
   * sentence boundary nudges the page so the reading line lands mid-screen,
   * with a deadzone (±25% of the viewport) so tiny drifts don't cause
   * scroll chatter; bigger offsets glide smoothly to center.
   */
  private followReading(range: Range | null): void {
    const view = this.doc?.defaultView;
    if (!range || !view) return;
    // jsdom and friends lack range geometry — following is a live-page concern.
    if (typeof range.getBoundingClientRect !== "function") return;
    const rect = range.getBoundingClientRect();
    const offsetFromCenter = rect.top + rect.height / 2 - view.innerHeight / 2;
    const deadzone = view.innerHeight * 0.25;
    if (Math.abs(offsetFromCenter) <= deadzone) return;
    try {
      view.scrollBy({ top: offsetFromCenter, behavior: "smooth" });
    } catch {
      // older engines without options — best effort only
      range.startContainer.parentElement?.scrollIntoView(true);
    }
  }

  /** Map chunk-relative engine word offsets onto the full-scope word map. */
  private wordRange(from: number, word?: { begin: number; end: number }): Range | null {
    if (!word || word.end <= word.begin || !this.wordMap || !this.prefix || from >= this.prefix.length) return null;
    // Title-segment tokens have no word mapping (the word index covers the
    // body range only) — keep the previous underline instead.
    if (from < this.bodyFrom) return null;
    // Engine offsets are chunk-relative; map onto the body word map,
    // re-based past the title's characters.
    const global = this.prefix[from] - this.titleChars + word.begin;
    const i = findWordIndex(this.wordMap.spans, global);
    return i >= 0 ? this.wordMap.words[i].range : null;
  }

  /** Whether this highlighter is the bound renderer for that session. */
  hasSession(sessionId: string): boolean {
    return this.sessionId === sessionId;
  }

  clear(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.sessionId = null;
    this.ranges = [];
    this.scopeTokens = null;
    this.hasBlocks = false;
    this.doc?.removeEventListener("click", this.onClick);
    this.doc = null;
    this.wordMap = null;
    this.prefix = null;
    this.bodyFrom = 0;
    this.titleChars = 0;
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