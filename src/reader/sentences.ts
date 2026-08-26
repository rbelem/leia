/**
 * Sentence tokenization (pure text). One token = one sentence (≤ MAX_TOKEN
 * chars) — the unit the reader speaks and the marching highlight tracks at
 * T2's sentence granularity (word map is T4, per-token timing is T5).
 *
 * Boundaries: `. ! ? …` (Latin) and `。！？` (CJK), plus blank-line runs
 * (paragraph breaks inside a selection). A sentence longer than MAX_TOKEN
 * is split at the last space within the cap, else hard-cut — never emitted
 * longer than MAX_TOKEN, so chunker output can never approach the 300-char
 * ceiling the Chrome silent-stop bug demands.
 */

export const MAX_TOKEN_CHARS = 250;

export interface TokenSpan {
  text: string;
  start: number;
  end: number;
}

const BOUNDARY_CHARS = new Set([".", "!", "?", "…", "。", "！", "？"]);

/** Absolute split points: index right AFTER which a sentence ends. */
export function sentenceSplitPoints(text: string): number[] {
  const points: number[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (BOUNDARY_CHARS.has(ch)) {
      points.push(i + 1);
      i += 1;
    } else if (ch === "\n") {
      // Blank line (two+ newlines, ignoring inline whitespace) ends a sentence.
      let j = i;
      while (j < n && (text[j] === "\n" || text[j] === " " || text[j] === "\t" || text[j] === "\r")) j += 1;
      if (j < n && text[j] === "\n") {
        points.push(j);
        i = j;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return points;
}

/** Split text into sentence tokens, enforcing MAX_TOKEN_CHARS per token. */
export function splitTokens(text: string): TokenSpan[] {
  const raw: Array<{ start: number; end: number }> = [];
  const points = sentenceSplitPoints(text);
  let start = 0;
  for (const p of points) {
    raw.push({ start, end: p });
    start = p;
  }
  raw.push({ start, end: text.length });

  const out: TokenSpan[] = [];
  for (const seg of raw) {
    if (seg.end - seg.start <= MAX_TOKEN_CHARS) {
      pushSegment(out, text, seg.start, seg.end);
      continue;
    }
    // Long sentence: split at the last space within the cap, else hard-cut.
    let s = seg.start;
    while (seg.end - s > MAX_TOKEN_CHARS) {
      const limit = s + MAX_TOKEN_CHARS;
      let cut = text.lastIndexOf(" ", limit);
      if (cut <= s || text[cut - 1] === "\n") cut = text.lastIndexOf("\n", limit);
      if (cut <= s) cut = limit; // CJK / unbroken run: hard cut
      pushSegment(out, text, s, cut);
      s = cut;
    }
    pushSegment(out, text, s, seg.end);
  }
  return out;
}

/** Whitespace-only spans carry no text — drop them. */
function pushSegment(out: TokenSpan[], text: string, start: number, end: number): void {
  if (end <= start) return;
  const t = text.slice(start, end);
  if (t.trim().length === 0) return;
  out.push({ text: t, start, end });
}