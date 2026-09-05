// SPDX-License-Identifier: MPL-2.0
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
 *
 * Two kinds of invisible text never enter the token stream (P2): text in
 * hidden subtrees (display:none / [hidden] / aria-hidden="true") and a
 * heading echoed verbatim as the leading text of a later body block — the
 * UOL pattern where the user heard every section title twice. Both are
 * filtered inside textParts, so the sentence index and the word index see
 * byte-identical text and every derived range stays exact.
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
  /** DOM content (hidden subtree, script/style/table) was skipped between
   * the previous part and this one. Pieces must cut at the gap: a piece
   * spanning it would stringify its range across the skipped text. */
  gapBefore: boolean;
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
  // DOM content (hidden subtree / script / style / table) was jumped over
  // since the previous emitted part — pieces must never bridge the gap.
  let skipped = false;

  const startIsText = range.startContainer.nodeType === Node.TEXT_NODE;
  const endIsText = range.endContainer.nodeType === Node.TEXT_NODE;

  const emit = (node: Text, from: number, to: number, block: Element | null): void => {
    const len = to - from;
    if (len <= 0) return;
    parts.push({ node, start: abs, end: abs + len, nodeStart: from, block, gapBefore: skipped });
    abs += len;
    skipped = false;
  };

  const emitTextNode = (node: Node, block: Element | null): void => {
    const len = (node as Text).data.length;
    let from = 0;
    let to = len;
    if (startIsText && node === range.startContainer) from = range.startOffset;
    if (endIsText && node === range.endContainer) to = range.endOffset;
    emit(node as Text, from, to, block);
  };

  /** Child-index window of `node` that the range covers (element containers). */
  const childWindow = (node: Node): { from: number; to: number } => {
    let from = 0;
    let to = node.childNodes.length;
    if (!startIsText && node === range.startContainer) from = range.startOffset;
    if (!endIsText && node === range.endContainer) to = range.endOffset;
    return { from, to };
  };

  /** Walk an element's covered child window. */
  const descend = (node: Node, block: Element | null): void => {
    const { from, to } = childWindow(node);
    const children = Array.from(node.childNodes);
    for (let i = from; i < to; i += 1) walk(children[i], block);
  };

  /**
   * Non-element nodes. Text/CDATA emits; document/fragment roots (whole-doc
   * ranges, shadow roots) descend transparently; comments/doctypes/PIs carry
   * no readable text and are skipped silently. None of these has
   * hasAttribute, so none may reach the Element path (TypeError live).
   * Returns true when the node was handled.
   */
  const walkLeaf = (node: Node, block: Element | null): boolean => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      emitTextNode(node, block);
      return true;
    }
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      descend(node, block);
      return true;
    }
    return node.nodeType !== Node.ELEMENT_NODE;
  };

  const walk = (node: Node, block: Element | null): void => {
    if (walkLeaf(node, block)) return;
    // Descending into a block-level element rebinds the subtree's owner;
    // style/script and hidden subtrees never emit text at all — but the
    // jump is recorded so pieces never bridge the skipped DOM text.
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName) || isHiddenElement(el)) {
      skipped = true;
      return;
    }
    const inner = BLOCK_TAGS.has(el.tagName) ? el : block;
    descend(node, inner);
  };

  walk(range.commonAncestorContainer, null);
  return dropHeadingEchoes(parts);
}

/**
 * Hidden-subtree test: [hidden], aria-hidden="true", or display:none
 * (inline style, or computed style where a default view can resolve it).
 * Text in such subtrees is never seen on screen, so it is never captured;
 * visible text stays byte-identical.
 */
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

/** Whitespace/case-insensitive form used to compare heading and echo text. */
function normalizeEcho(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Full text of the heading block whose last part sits at index `h`. */
function headingTextBefore(parts: TextPart[], h: number): string {
  const block = parts[h].block;
  let s = h;
  while (s > 0 && parts[s - 1].block === block) s -= 1;
  let text = "";
  for (let i = s; i <= h; i += 1) text += partText(parts[i]);
  return normalizeEcho(text);
}

/**
 * Raw length of the heading echo opening `flat` (the body block's text),
 * or null when there is no echo. The echo must repeat the whole heading
 * (whitespace/case-insensitive) and end at a word boundary — a partial
 * repeat ("Casa" matching inside "Casamento") is left untouched.
 */
function leadingEchoLength(flat: string, heading: string): number | null {
  let acc = "";
  let pendingWs = false;
  let raw = 0;
  for (const ch of flat) {
    const low = ch.toLowerCase();
    if (/\s/.test(low)) {
      if (acc.length > 0) pendingWs = true;
    } else {
      if (pendingWs) {
        acc += " ";
        pendingWs = false;
      }
      acc += low;
    }
    raw += ch.length;
    if (acc.length >= heading.length) break;
  }
  if (acc !== heading) return null;
  const rest = flat.slice(raw);
  if (rest.length > 0 && /^[\p{L}\p{N}]/u.test(rest)) return null; // mid-word match
  return raw;
}

/** First block after a heading whose text echoes it: cut spec, or null. */
function nextEchoCut(parts: TextPart[]): { from: number; to: number; length: number } | null {
  let lastHeading = -1;
  for (let j = 0; j < parts.length; j += 1) {
    const part = parts[j];
    if (isHeadingTag(part.block)) {
      lastHeading = j;
      continue;
    }
    if (lastHeading < 0) continue;
    if (j > 0 && parts[j - 1].block === part.block) continue; // not the block start
    let to = j;
    while (to + 1 < parts.length && parts[to + 1].block === part.block) to += 1;
    const heading = headingTextBefore(parts, lastHeading);
    if (heading.length === 0) continue;
    const flat = parts.slice(j, to + 1).map(partText).join("");
    const length = leadingEchoLength(flat, heading);
    if (length === null) continue;
    return { from: j, to, length };
  }
  return null;
}

/** Drop `cut` leading characters of parts[from..to]; absolute offsets of
 * every later part are rebuilt so the parts list stays contiguous. */
function cutPrefix(parts: TextPart[], from: number, to: number, cut: number): TextPart[] {
  const out: TextPart[] = [];
  let abs = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    const len = p.end - p.start;
    if (i >= from && i <= to && cut > 0) {
      if (cut >= len) {
        cut -= len;
        continue; // part fully consumed by the echo — dropped
      }
      out.push({ node: p.node, start: abs, end: abs + (len - cut), nodeStart: p.nodeStart + cut, block: p.block, gapBefore: p.gapBefore });
      abs += len - cut;
      cut = 0;
      continue;
    }
    out.push({ node: p.node, start: abs, end: abs + len, nodeStart: p.nodeStart, block: p.block, gapBefore: p.gapBefore });
    abs += len;
  }
  return out;
}

/**
 * UOL-style heading echo: the page repeats a section heading as the first
 * words of a later body block ("Moraes acusa Mendonça" as <h2>, then again
 * opening the next paragraph), so capture tokenized the title twice. When
 * a body block opens with the exact text of the nearest preceding heading
 * block (whitespace/case-insensitive, word-bounded), the echoed prefix is
 * cut from the parts — the heading is captured once, and part offsets keep
 * every derived range exact. Echoes that only partially repeat the heading
 * (a quote, a shared first word) stay untouched.
 */
function dropHeadingEchoes(parts: TextPart[]): TextPart[] {
  let out = parts;
  for (;;) {
    const cut = nextEchoCut(out);
    if (!cut) return out;
    out = cutPrefix(out, cut.from, cut.to, cut.length);
  }
}

/**
 * Absolute offset → (node, offset) using the part spans. Directional:
 * a trimmed part's start must resolve FORWARD into the part that owns the
 * position (the previous part's end is a different DOM position when an
 * echo/hidden span was cut between them), while a piece end resolves
 * BACKWARD so the range doesn't leak into the following part's text.
 */
function locateForward(parts: TextPart[], abs: number): { node: Text; offset: number } {
  for (const p of parts) {
    if (abs >= p.start && abs < p.end) {
      return { node: p.node, offset: p.nodeStart + (abs - p.start) };
    }
  }
  /* v8 ignore start -- parts are contiguous, the offset always lands inside one */
  const last = parts[parts.length - 1];
  return { node: last.node, offset: last.nodeStart + (last.end - last.start) };
  /* v8 ignore stop */
}

function locateBackward(parts: TextPart[], abs: number): { node: Text; offset: number } {
  for (const p of parts) {
    if (abs >= p.start && abs <= p.end) {
      return { node: p.node, offset: p.nodeStart + (abs - p.start) };
    }
  }
  /* v8 ignore start -- parts are contiguous, the offset always lands inside one */
  const last = parts[parts.length - 1];
  return { node: last.node, offset: last.nodeStart + (last.end - last.start) };
  /* v8 ignore stop */
}

function partText(p: TextPart): string {
  return p.node.data.slice(p.nodeStart, p.nodeStart + (p.end - p.start));
}

function joinedText(parts: TextPart[]): string {
  return parts.map(partText).join("");
}

/** Part whose span covers absolute offset `abs`. */
function partAt(parts: TextPart[], abs: number): TextPart {
  for (const p of parts) {
    if (abs >= p.start && abs < p.end) return p;
  }
  /* v8 ignore next -- parts are contiguous, the offset always lands inside one */
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
    // Cut the span wherever its innermost block ancestor changes — and at
    // hidden-content gaps, where a merged range would stringify across the
    // skipped DOM text and break the round-trip invariant.
    const pieces: Array<{ start: number; end: number; block: Element | null }> = [];
    let cur = span.start;
    while (cur < span.end) {
      const p = partAt(parts, cur);
      const end = Math.min(p.end, span.end);
      const lastPiece = pieces[pieces.length - 1];
      if (lastPiece && lastPiece.block === p.block && !p.gapBefore) lastPiece.end = end;
      else pieces.push({ start: cur, end, block: p.block });
      cur = end;
    }
    for (const piece of pieces) {
      const text = full.slice(piece.start, piece.end);
      if (text.trim().length === 0) continue; // blank cut remainder — unreadable
      const r = doc.createRange();
      const start = locateForward(parts, piece.start);
      const end = locateBackward(parts, piece.end);
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

/** Owning document of a range boundary point (the point itself when it already is one). */
function ownerDocOf(node: Node): Document | null {
  if (node.nodeType === Node.DOCUMENT_NODE) return node as Document;
  return node.ownerDocument;
}

/** Build the sentence-token index for the given DOM range. */
export function tokenIndexFromRange(range: Range): Token[] {
  const parts = textParts(range);
  if (parts.length === 0) return [];
  const doc = ownerDocOf(range.startContainer);
  /* v8 ignore next -- range boundary nodes always carry an ownerDocument */
  if (!doc) return [];
  const full = joinedText(parts);
  return buildTokens(parts, splitTokens(full), doc, full);
}

/** Build the word-token index for the range (block-aware cuts, like the
 * sentence index). */
export function wordIndexFromRange(range: Range, locale: string): WordIndex | null {
  const parts = textParts(range);
  if (parts.length === 0) return null;
  const doc = ownerDocOf(range.startContainer);
  /* v8 ignore next -- range boundary nodes always carry an ownerDocument */
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