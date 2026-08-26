/**
 * Chunking: group consecutive sentence tokens into utterance chunks.
 * Constraints (T2 Web Speech specifics):
 *  - chunks never cross sentence boundaries (highlight advances per
 *    utterance start; sentence granularity)
 *  - ≤ MAX_TOKEN_CHARS total (never one long utterance — Chrome silent-stop
 *    bug); tokens are already ≤ MAX_TOKEN_CHARS, so no chunk can exceed it
 *    and the 300-char ceiling holds by construction
 *  - ≤ MAX_TOKENS_PER_CHUNK sentences per chunk: the marching highlight
 *    renders one range per sentence and caps at 3 ranges.
 */
import { MAX_TOKEN_CHARS } from "./sentences";

export const MAX_TOKENS_PER_CHUNK = 3;

export interface ChunkSpan {
  from: number; // first token index (inclusive)
  to: number; // last token index (inclusive)
}

export function chunkTokens(tokens: Array<{ text: string }>): ChunkSpan[] {
  const chunks: ChunkSpan[] = [];
  let from = 0;
  while (from < tokens.length) {
    let to = from;
    let chars = tokens[from].text.length;
    while (
      to + 1 < tokens.length &&
      to + 1 - from < MAX_TOKENS_PER_CHUNK &&
      chars + tokens[to + 1].text.length <= MAX_TOKEN_CHARS
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