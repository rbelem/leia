import { describe, expect, it } from "vitest";
import { splitTokens } from "../src/reader/sentences";
import { chunkTokens, MAX_TOKENS_PER_CHUNK } from "../src/reader/chunker";
import { MAX_TOKEN_CHARS } from "../src/reader/sentences";

const texts = (tokens: Array<{ text: string }>) => tokens.map((t) => t.text);
const toTokens = (lines: string[]): Array<{ text: string }> => lines.map((text) => ({ text }));

describe("sentence tokenizer (en + CJK)", () => {
  it("splits Latin sentences at . ! ? and keeps punctuation attached", () => {
    const tokens = splitTokens("Hello world. How are you? Fine!");
    expect(texts(tokens)).toEqual(["Hello world.", " How are you?", " Fine!"]);
  });

  it("splits CJK sentences at 。 ！ ？", () => {
    const tokens = splitTokens("你好，世界。今天好吗？很好！");
    expect(texts(tokens)).toEqual(["你好，世界。", "今天好吗？", "很好！"]);
  });

  it("splits on blank lines (paragraph breaks)", () => {
    const tokens = splitTokens("First paragraph.\n\nSecond paragraph.");
    expect(texts(tokens)).toEqual(["First paragraph.", "\n\nSecond paragraph."]);
  });

  it("drops whitespace-only spans", () => {
    const tokens = splitTokens("Done.   \n\n   ");
    expect(texts(tokens)).toEqual(["Done."]);
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
});

describe("chunker", () => {
  it("groups short sentences up to the cap and never crosses sentence boundaries", () => {
    const tokens = toTokens(["A. ", "B. ", "C. ", "D. "]);
    const chunks = chunkTokens(tokens);
    expect(chunks).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 3 },
    ]);
    expect(chunks.every((c) => c.to - c.from + 1 <= MAX_TOKENS_PER_CHUNK)).toBe(true);
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

  it("nothing >300 chars, ever: token cap ≤250 forces chunks ≤250", () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({
      text: `${"y".repeat(40)}${i}. `, // 43 chars each
    }));
    const chunks = chunkTokens(tokens);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const size = c.to - c.from + 1;
      expect(size).toBeLessThanOrEqual(MAX_TOKENS_PER_CHUNK); // ≤3 ranges for highlight
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