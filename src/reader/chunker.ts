/**
 * Chunking: group consecutive sentence tokens into utterance chunks.
 * Constraints:
 *  - chunks never cross DOM block boundaries (TokenText.blockStart from the
 *    capture walk): a paragraph, list item, or table cell is the reading
 *    unit; headings (heading) read alone.
 *  - ≤ cap chars (default MAX_TOKEN_CHARS; CJK sessions pass
 *    CJK_TOKEN_CHARS so CJK utterances stay ~100 chars — never one long
 *    utterance, Chrome silent-stop bug): tokens are already ≤ cap, so no
 *    chunk can exceed it and the 300-char ceiling holds by construction.
 *    Long paragraphs split into several utterances; the content-side wash
 *    still covers the whole block.
 *
 * Tokens without flags (old stored sessions) degrade to char-cap grouping,
 * which for ≤250-char tokens approximates the old 3-sentence behavior.
 */
import { MAX_TOKEN_CHARS } from "./sentences";
import type { TokenText } from "./session";

export interface ChunkSpan {
  from: number; // first token index (inclusive)
  to: number; // last token index (inclusive)
}

function startsUnit(t: TokenText | undefined): boolean {
  return !!t && (t.blockStart === true || t.heading === true);
}

export function chunkTokens(tokens: TokenText[], cap: number = MAX_TOKEN_CHARS): ChunkSpan[] {
  const chunks: ChunkSpan[] = [];
  let from = 0;
  while (from < tokens.length) {
    let to = from;
    let chars = tokens[from].text.length;
    while (
      to + 1 < tokens.length &&
      !startsUnit(tokens[to + 1]) &&
      !tokens[to].heading && // a heading never absorbs following text
      chars + tokens[to + 1].text.length <= cap
    ) {
      to += 1;
      chars += tokens[to].text.length;
    }
    chunks.push({ from, to });
    from = to + 1;
  }
  return chunks;
}

export function chunkText(tokens: Array<{ text: string }>, chunk: ChunkSpan): string {
  let out = "";
  for (let i = chunk.from; i <= chunk.to; i += 1) out += tokens[i].text;
  return out;
}
