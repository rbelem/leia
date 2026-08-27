/**
 * Token → DOM-range index over a selection (T2 item 6, T4 word map). Maps
 * the sentence or word tokenization of the selected text back onto live
 * Range objects, one per token, so the floating bar / content script can
 * re-highlight any token index without touching the page's DOM.
 *
 * Ranges are live DOM Range objects: they track layout natively (inserts,
 * removals, and re-wrapping outside the selection text do not invalidate
 * them). Only TEXT mutation inside the selection desynchronizes the index;
 * an external content-side observer owns that (scope staleness is not this
 * layer's concern).
 *
 * token.text === token.range.toString() always holds (round-trip
 * invariant), because tokens keep the exact source text between split
 * points, including inter-sentence whitespace.
 */
import { splitTokens, wordSpans, type TokenSpan } from "./sentences";

export interface Token {
  text: string;
  range: Range;
  /** Flags stamped by the capture walk (see TokenText). */
  blockStart?: boolean;
  heading?: boolean;
}

/** Locale-scoped word granularity index over a selection. */
export interface WordIndex {
  locale: string;
  words: Token[];
}

interface TextPart {
  node: Text;
  start: number; // absolute offset in the concatenated text
  end: number;
  nodeStart: number; // character offset within node where `start` maps
  /** Innermost block-level ancestor of `node` — paragraph/heading/cell the
   * text visually belongs to. null when none matches (tests / exotic pages). */
  block: Element | null;
}

/**
 * Elements that start a new READING unit. A token whose innermost block
 * ancestor differs from the previous token's marks a block start; H1–H6
 * additionally read alone. Inline containers (span/b/em/a) never appear —
 * sentences flowing through them stay in one unit.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS",
  "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "LABEL", "LI", "MAIN", "NAV", "OL",
  "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TH", "THEAD",
  "TR", "UL",
]);

function isHeadingTag(el: Element | null): boolean {
  return !!el && /^H[1-6]$/.test(el.tagName);
}

/** Never readable: markup/data containers, plus TABLES by product decision
 * (a data table read aloud is noise — cells, headers and their CSS don't
 * survive linearization). Explicit selections *inside* a table still work:
 * the walk only skips when it can enter the element itself. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TABLE",
]);

/**
 * Walk the text nodes intersecting `range`, in document order, mapping each
 * to an absolute span in the concatenated text. Handles text containers
 * (char offsets) and element containers (child-index offsets).
 */
function textParts(range: Range): TextPart[] {
  const parts: TextPart[] = [];
  let abs = 0;

  const startIsText = range.startContainer.nodeType === Node.TEXT_NODE;
  const endIsText = range.endContainer.nodeType === Node.TEXT_NODE;

  const emit = (node: Text, from: number, to: number, block: Element | null): void => {
    const len = to - from;
    if (len <= 0) return;
    parts.push({ node, start: abs, end: abs + len, nodeStart: from, block });
    abs += len;
  };

  const walk = (node: Node, block: Element | null): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length;
      let from = 0;
      let to = len;
      if (startIsText && node === range.startContainer) from = range.startOffset;
      if (endIsText && node === range.endContainer) to = range.endOffset;
      emit(node as Text, from, to, block);
      return;
    }
    // Descending into a block-level element rebinds the subtree's owner;
    // style/script subtrees never emit text at all.
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    const inner = BLOCK_TAGS.has(el.tagName) ? el : block;
    const children = Array.from(node.childNodes);
    for (let i = 0; i < children.length; i += 1) {
      if (!startIsText && node === range.startContainer && i < range.startOffset) continue;
      if (!endIsText && node === range.endContainer && i >= range.endOffset) break;
      walk(children[i], inner);
    }
  };

  walk(range.commonAncestorContainer, null);
  return parts;
}

/** Absolute offset → (node, offset) using the part spans. */
function locate(parts: TextPart[], abs: number): { node: Text; offset: number } {
  for (const p of parts) {
    if (abs >= p.start && abs <= p.end) {
      return { node: p.node, offset: p.nodeStart + (abs - p.start) };
    }
  }
  const last = parts[parts.length - 1];
  return { node: last.node, offset: last.nodeStart + (last.end - last.start) };
}

function joinedText(parts: TextPart[]): string {
  return parts.map((p) => p.node.data.slice(p.nodeStart, p.nodeStart + (p.end - p.start))).join("");
}

/** Part whose span covers absolute offset `abs`. */
function partAt(parts: TextPart[], abs: number): TextPart {
  for (const p of parts) {
    if (abs >= p.start && abs < p.end) return p;
  }
  return parts[parts.length - 1];
}

/** Lay spans onto live ranges over the text parts, stamping block flags
 * and cutting spans at block boundaries (a heading glued to the next
 * paragraph has no terminal punctuation — the DOM edge IS the break). */
function buildTokens(parts: TextPart[], spans: TokenSpan[], doc: Document, full: string): Token[] {
  const tokens: Token[] = [];
  // Block of the last emitted token; undefined until the first one.
  let lastBlock: Element | null | undefined;
  for (const span of spans) {
    // Cut the span wherever its innermost block ancestor changes.
    const pieces: Array<{ start: number; end: number; block: Element | null }> = [];
    let cur = span.start;
    while (cur < span.end) {
      const p = partAt(parts, cur);
      const end = Math.min(p.end, span.end);
      const lastPiece = pieces[pieces.length - 1];
      if (lastPiece && lastPiece.block === p.block) lastPiece.end = end;
      else pieces.push({ start: cur, end, block: p.block });
      cur = end;
    }
    for (const piece of pieces) {
      const text = full.slice(piece.start, piece.end);
      if (text.trim().length === 0) continue; // blank cut remainder — unreadable
      const r = doc.createRange();
      const start = locate(parts, piece.start);
      const end = locate(parts, piece.end);
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      const token: Token = { text, range: r };
      if (lastBlock === undefined || piece.block !== lastBlock) {
        token.blockStart = true;
        if (isHeadingTag(piece.block)) token.heading = true;
      }
      tokens.push(token);
      lastBlock = piece.block;
    }
  }
  return tokens;
}

/** Build the sentence-token index for the given DOM range. */
export function tokenIndexFromRange(range: Range): Token[] {
  const parts = textParts(range);
  if (parts.length === 0) return [];
  const doc = range.startContainer.ownerDocument;
  if (!doc) return [];
  const full = joinedText(parts);
  return buildTokens(parts, splitTokens(full), doc, full);
}

/** Build the word-token index for the range (block-aware cuts, like the
 * sentence index). */
export function wordIndexFromRange(range: Range, locale: string): WordIndex | null {
  const parts = textParts(range);
  if (parts.length === 0) return null;
  const doc = range.startContainer.ownerDocument;
  if (!doc) return null;
  const fullText = joinedText(parts);
  const spans = wordSpans(fullText, locale);
  if (spans.length === 0) return null;
  return { locale, words: buildTokens(parts, spans, doc, fullText) };
}

/** Capture the current page selection as tokens; null when nothing selected. */
export function tokenIndexFromSelection(win: Window): Token[] | null {
  const selection = win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const tokens = tokenIndexFromRange(selection.getRangeAt(0));
  return tokens.length > 0 ? tokens : null;
}

/** Capture the current page selection at word granularity; null when empty. */
export function wordIndexFromSelection(win: Window, locale: string): WordIndex | null {
  const selection = win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  return wordIndexFromRange(selection.getRangeAt(0), locale);
}