/**
 * Token → DOM-range index over a selection (T2 item 6). Maps the sentence
 * tokenization of the selected text back onto live Range objects, one per
 * token, so the floating bar / content script can re-highlight any token
 * index without touching the page's DOM.
 *
 * token.text === token.range.toString() always holds (round-trip invariant),
 * because tokens keep the exact source text between split points, including
 * inter-sentence whitespace.
 */
import { splitTokens, type TokenSpan } from "./sentences";

export interface Token {
  text: string;
  range: Range;
}

interface TextPart {
  node: Text;
  start: number; // absolute offset in the concatenated text
  end: number;
  nodeStart: number; // character offset within node where `start` maps
}

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

  const emit = (node: Text, from: number, to: number): void => {
    const len = to - from;
    if (len <= 0) return;
    parts.push({ node, start: abs, end: abs + len, nodeStart: from });
    abs += len;
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length;
      let from = 0;
      let to = len;
      if (startIsText && node === range.startContainer) from = range.startOffset;
      if (endIsText && node === range.endContainer) to = range.endOffset;
      emit(node as Text, from, to);
      return;
    }
    const children = Array.from(node.childNodes);
    for (let i = 0; i < children.length; i += 1) {
      if (!startIsText && node === range.startContainer && i < range.startOffset) continue;
      if (!endIsText && node === range.endContainer && i >= range.endOffset) break;
      walk(children[i]);
    }
  };

  walk(range.commonAncestorContainer);
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

/** Build the sentence-token index for the given DOM range. */
export function tokenIndexFromRange(range: Range): Token[] {
  const parts = textParts(range);
  if (parts.length === 0) return [];

  const fullText = parts.map((p) => p.node.data.slice(p.nodeStart, p.nodeStart + (p.end - p.start))).join("");
  const spans: TokenSpan[] = splitTokens(fullText);
  const doc = range.startContainer.ownerDocument;
  if (!doc) return [];

  const tokens: Token[] = [];
  for (const span of spans) {
    const r = doc.createRange();
    const start = locate(parts, span.start);
    const end = locate(parts, span.end);
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
    tokens.push({ text: span.text, range: r });
  }
  return tokens;
}

/** Capture the current page selection as tokens; null when nothing selected. */
export function tokenIndexFromSelection(win: Window): Token[] | null {
  const selection = win.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const tokens = tokenIndexFromRange(selection.getRangeAt(0));
  return tokens.length > 0 ? tokens : null;
}