// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { chunkTokens } from "../src/reader/chunker";
import { MAX_TOKEN_CHARS, splitTokens, sentenceSpans, CJK_TOKEN_CHARS } from "../src/reader/sentences";
import type { TokenText } from "../src/reader/session";

const texts = (tokens: Array<{ text: string }>) => tokens.map((t) => t.text);
const toTokens = (lines: string[]): Array<{ text: string }> => lines.map((text) => ({ text }));

describe("sentence tokenizer (en + CJK)", () => {
  it("splits Latin sentences at . ! ? and keeps punctuation attached", () => {
    const tokens = splitTokens("Hello world. How are you? Fine!");
    expect(texts(tokens)).toEqual(["Hello world. ", "How are you? ", "Fine!"]);
  });

  it("splits CJK sentences at 。 ！ ？ (Intl.Segmenter script rules)", () => {
    const tokens = splitTokens("你好，世界。今天好吗？很好！");
    expect(texts(tokens)).toEqual(["你好，世界。", "今天好吗？", "很好！"]);
  });

  it("keeps abbreviations and ellipsis runs whole (char-set splitters broke these)", () => {
    expect(texts(splitTokens("Use e.g. this. "))).toEqual(["Use e.g. this. "]);
    expect(texts(splitTokens("The U.S. is big. "))).toEqual(["The U.S. is big. "]);
    expect(texts(splitTokens("Hello... world."))).toEqual(["Hello... world."]);
  });

  it("splits on blank lines (paragraph breaks)", () => {
    const tokens = splitTokens("First paragraph.\n\nSecond paragraph.");
    expect(texts(tokens)).toEqual(["First paragraph.\n", "Second paragraph."]);
  });

  it("drops whitespace-only spans", () => {
    const tokens = splitTokens("Done.   \n\n   ");
    expect(texts(tokens)).toEqual(["Done.   \n"]);
  });

  it("never emits a token longer than the cap, splitting at word boundaries", () => {
    const long = "word ".repeat(80); // 400 chars, no final punctuation
    const tokens = splitTokens(long);
    for (const t of tokens) {
      expect(t.text.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
      expect(t.text.length).toBeGreaterThan(0);
    }
    expect(tokens.reduce((n, t) => n + t.text.length, 0)).toBe(long.length);
    // Pieces align to word boundaries (they all start/end at spaces except edges).
    for (const t of tokens.slice(1)) expect(t.text[0]).toBe(" ");
  });

  it("hard-cuts an unbroken CJK run at the CJK cap", () => {
    const long = "这是一个没有标点符号的超级长句子".repeat(20); // 360 chars, no punct
    const tokens = sentenceSpans(long, "zh-CN", CJK_TOKEN_CHARS);
    for (const t of tokens) {
      expect(t.text.length).toBeLessThanOrEqual(CJK_TOKEN_CHARS);
      expect(t.text.length).toBeGreaterThan(0);
    }
    expect(tokens.reduce((n, t) => n + t.text.length, 0)).toBe(long.length);
  });
});

describe("chunker", () => {
  it("groups sentences of one block into a single utterance up to the char cap", () => {
    const tokens = toTokens(["A. ", "B. ", "C. ", "D. "]);
    expect(chunkTokens(tokens)).toEqual([{ from: 0, to: 3 }]);
  });

  it("never merges across a block start: each paragraph speaks alone", () => {
    const tokens = [
      ...toTokens(["Para one A. ", "Para one B. "]),
      { text: "Para two. ", blockStart: true },
    ];
    expect(chunkTokens(tokens)).toEqual([{ from: 0, to: 1 }, { from: 2, to: 2 }]);
  });

  it("a heading reads and highlights alone, before and after body text", () => {
    const tokens = [
      { text: "The Title ", heading: true, blockStart: true },
      ...toTokens(["Body one. ", "Body two. "]),
      { text: "Next Title ", heading: true, blockStart: true },
    ];
    const chunks = chunkTokens(tokens);
    expect(chunks).toEqual([
      { from: 0, to: 0 }, // heading alone
      { from: 1, to: 2 }, // its paragraph as one
      { from: 3, to: 3 }, // second heading alone
    ]);
  });

  it("reads table cells one at a time when they reach the chunker (e.g. cell selections)", () => {
    const tokens = [
      { text: "Name ", blockStart: true },
      { text: "Age ", blockStart: true },
      { text: "Ada ", blockStart: true },
      { text: "36 ", blockStart: true },
    ];
    expect(chunkTokens(tokens)).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 3 },
    ]);
  });

  it("long blocks split across utterances inside the same paragraph (wash stays whole)", () => {
    const para = Array.from({ length: 8 }, (_, i) => `${"z".repeat(40)}${i}. `); // 43 chars × 8
    const chunks = chunkTokens(toTokens(para));
    expect(chunks.length).toBe(2); // cap splits at 5+3 tokens; no block flag interferes
    // Every chunk ≤ char cap.
    for (const c of chunks) {
      const len = para.slice(c.from, c.to + 1).reduce((n, t) => n + t.length, 0);
      expect(len).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
    }
  });

  it("caps chunk size at chars: a long token gets its own chunk", () => {
    const long = "x".repeat(250);
    const tokens = toTokens(["Short. ", long, "Tail. "]);
    const chunks = chunkTokens(tokens);
    expect(chunks).toEqual([
      { from: 0, to: 0 }, // "Short. " + 250 > 250 → not merged
      { from: 1, to: 1 }, // the 250-char token stands alone
      { from: 2, to: 2 }, // 250 + 6 > 250 → alone
    ]);
  });

  it("caps CJK chunks at CJK_TOKEN_CHARS so utterances stay ~100 chars", () => {
    const tokens = toTokens(["你好，世界。", "今天好吗？", "很好！", "再见。"]);
    const chunks = chunkTokens(tokens, CJK_TOKEN_CHARS); // 17 chars total ≤ 100 → one utterance
    expect(chunks).toEqual([{ from: 0, to: 3 }]);
    // A 40-char sentence token already saturates the CJK cap: stands alone.
    const big = "这是一句很长的但没有标点的话".repeat(10); // 160 chars
    const bigTokens = toTokens([big, "短句。"]);
    const bigChunks = chunkTokens(bigTokens, CJK_TOKEN_CHARS);
    expect(bigChunks).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }]);
  });

  it("nothing >300 chars, ever: token cap ≤250 forces chunk text ≤250", () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({
      text: `${"y".repeat(40)}${i}. `, // 43 chars each
    }));
    const chunks = chunkTokens(tokens);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const len = tokens.slice(c.from, c.to + 1).reduce((n, t) => n + t.text.length, 0);
      expect(len).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
    }
    // Every chunk is a contiguous slice of tokens.
    expect(chunks[0].from).toBe(0);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].from).toBe(chunks[i - 1].to + 1);
    }
  });

  it("handles selection-sized input in one pass", () => {
    const tokens = toTokens(["One. ", "Two. ", "Three. "]); // 3 tokens, ≤250 total
    expect(chunkTokens(tokens)).toEqual([{ from: 0, to: 2 }]);
  });
});

// --- Property: randomized inputs always partition [0, n) ---

/** Deterministic PRNG (mulberry32) — reproducible "random" inputs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("chunker property: chunks partition [0, n)", () => {
  it("randomized token arrays partition with no overlaps and no gaps", () => {
    const rand = mulberry32(0x1e2a);
    for (let iter = 0; iter < 300; iter += 1) {
      const n = Math.floor(rand() * 61); // 0..60 tokens
      const tokens: TokenText[] = Array.from({ length: n }, () => {
        const token: TokenText = { text: "t".repeat(1 + Math.floor(rand() * 300)) };
        if (rand() < 0.25) token.blockStart = true;
        if (rand() < 0.15) token.heading = true;
        return token;
      });
      const cap = 1 + Math.floor(rand() * 400);

      const chunks = chunkTokens(tokens, cap);

      if (n === 0) {
        expect(chunks).toEqual([]);
        continue;
      }
      expect(chunks.length).toBeGreaterThan(0);
      // Chain: starts at 0, each chunk begins exactly one past the previous.
      expect(chunks[0].from).toBe(0);
      for (let i = 1; i < chunks.length; i += 1) {
        expect(chunks[i].from).toBe(chunks[i - 1].to + 1);
      }
      // Coverage: the last chunk ends at the final token.
      expect(chunks[chunks.length - 1].to).toBe(n - 1);
      for (const c of chunks) {
        expect(c.from).toBeLessThanOrEqual(c.to);
        expect(c.from).toBeGreaterThanOrEqual(0);
        expect(c.to).toBeLessThan(n);
      }
    }
  });
});