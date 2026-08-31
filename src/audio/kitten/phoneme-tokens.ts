// SPDX-License-Identifier: MPL-2.0
/**
 * Phoneme→token-id encoding for KittenTTS nano (ticket 06). The model's
 * tokenizer is a flat phoneme→id vocab (same convention as its Kokoro
 * ancestor): phonemizer.js produces an espeak-style phoneme string, and the
 * ids are a greedy longest-match walk over that string. Unknown symbols are
 * skipped — the vocab covers the full espeak inventory, so gaps only occur
 * on stray markup/emoji.
 *
 * The ONNX graph receives input_ids padded with the pad id (0) at both ends,
 * kept at an even length (the Kokoro shape convention KittenTTS inherits).
 */

export const KITTEN_PAD_ID = 0;

/** Greedy longest-match phoneme→id encoding; unknown runs are skipped. */
export function encodePhonemes(vocab: Record<string, number>, text: string): number[] {
  const ids: number[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = 0;
    // Longest token in the espeak vocab is a handful of chars; walk down.
    for (let len = Math.min(5, text.length - i); len >= 1; len -= 1) {
      const id = vocab[text.slice(i, i + len)];
      if (typeof id === "number") {
        matched = len;
        ids.push(id);
        break;
      }
    }
    i += matched > 0 ? matched : 1;
  }
  return ids;
}

/** [pad, ...ids, pad] with an extra pad when the total length is odd. */
export function kittenInputIds(phonemeIds: number[]): BigInt64Array {
  const padded = [KITTEN_PAD_ID, ...phonemeIds, KITTEN_PAD_ID];
  if (padded.length % 2 !== 0) padded.push(KITTEN_PAD_ID);
  return BigInt64Array.from(padded.map(BigInt));
}
