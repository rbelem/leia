import { describe, expect, it } from "vitest";
import {
  isCjkLocale,
  sentenceSpans,
  wordParentIndex,
  wordSpans,
  CJK_TOKEN_CHARS,
  MAX_TOKEN_CHARS,
} from "../src/reader/sentences";

const texts = (spans: Array<{ text: string }>) => spans.map((s) => s.text);

describe("sentence segmentation (locale-parameterized)", () => {
  it("splits CJK text per-script rules under a CJK locale", () => {
    expect(texts(sentenceSpans("你好，世界。今天好吗？很好！", "zh-CN"))).toEqual([
      "你好，世界。",
      "今天好吗？",
      "很好！",
    ]);
  });

  it("splits Japanese text with Japanese sentence terminal rules", () => {
    expect(texts(sentenceSpans("今日はいい天気ですね。散歩に行きましょう。", "ja-JP"))).toEqual([
      "今日はいい天気ですね。",
      "散歩に行きましょう。",
    ]);
  });

  it("a CJK-cap long sentence splits at the cap; a Latin long sentence at spaces", () => {
    const cjk = "这是一个没有标点符号的超级长句子".repeat(20); // 320 chars, unbroken
    const cjkTokens = sentenceSpans(cjk, "zh-CN", CJK_TOKEN_CHARS);
    for (const t of cjkTokens) expect(t.text.length).toBeLessThanOrEqual(CJK_TOKEN_CHARS);
    expect(cjkTokens.reduce((n, t) => n + t.text.length, 0)).toBe(cjk.length);

    const latin = "word ".repeat(130); // 650 chars, spaces only
    const latinTokens = sentenceSpans(latin, "en", MAX_TOKEN_CHARS);
    for (const t of latinTokens) expect(t.text.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
    expect(latinTokens.reduce((n, t) => n + t.text.length, 0)).toBe(latin.length);
    for (const t of latinTokens.slice(1)) expect(t.text[0]).toBe(" ");
  });

  it("sentence spans stay absolute and contiguous (minus dropped whitespace)", () => {
    const text = "One. Two.\n\nThree.";
    const spans = sentenceSpans(text, "en");
    expect(spans[0]).toEqual({ text: "One. ", start: 0, end: 5 });
    expect(spans[1]).toEqual({ text: "Two.\n", start: 5, end: 10 });
    expect(spans[2]).toEqual({ text: "Three.", start: 11, end: 17 });
  });
});

describe("isCjkLocale", () => {
  it("recognizes zh/ja/ko/yue variants and rejects others", () => {
    for (const l of ["zh", "zh-CN", "zh-Hant-TW", "ja", "ja-JP", "ko-KR", "yue-Hant"]) {
      expect(isCjkLocale(l)).toBe(true);
    }
    for (const l of ["en", "en-US", "fr", "de", "ar", "pt-BR", ""]) {
      expect(isCjkLocale(l)).toBe(false);
    }
  });
});

describe("word segmentation", () => {
  it("Latin: words split at spaces; punctuation merges into the preceding word", () => {
    expect(texts(wordSpans("Hello world. How are you?", "en"))).toEqual([
      "Hello",
      "world.",
      "How",
      "are",
      "you?",
    ]);
  });

  it("CJK: real dictionary words, not bigrams; terminal punctuation attaches", () => {
    expect(texts(wordSpans("你好，世界。今天好吗？很好！", "zh-CN"))).toEqual([
      "你好，",
      "世界。",
      "今天",
      "好",
      "吗？",
      "很好！",
    ]);
  });

  it("Japanese: particles stay separate — no accidental sentence glue", () => {
    expect(texts(wordSpans("今日はいい天気ですね。散歩に行きましょう。", "ja-JP"))).toEqual([
      "今日",
      "は",
      "いい",
      "天気",
      "です",
      "ね。",
      "散歩",
      "に",
      "行き",
      "ま",
      "しょう。",
    ]);
  });

  it("every character is covered exactly once, whitespace excluded", () => {
    const text = "Hello, brave new world! 你好，世界！";
    const spans = wordSpans(text, "zh-CN");
    expect(spans.map((s) => s.text).join("")).toBe(text.replace(/\s+/g, ""));
    // Spans are ordered, absolute, and non-overlapping.
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("a bare leading punctuation run stands alone", () => {
    expect(texts(wordSpans("…Hello world.", "en"))).toEqual(["…", "Hello", "world."]);
  });
});

describe("word → sentence parent index", () => {
  it("maps each word to its sentence and counts words per sentence", () => {
    const text = "Hello world. How are you? 你好，世界。";
    const sentences = sentenceSpans(text, "zh-CN");
    const words = wordSpans(text, "zh-CN");
    const { parent, counts } = wordParentIndex(sentences, words);

    expect(counts).toEqual(new Int32Array([2, 3, 2]));
    expect(parent).toEqual(new Int32Array([0, 0, 1, 1, 1, 2, 2]));
  });

  it("handles empty inputs", () => {
    const { parent, counts } = wordParentIndex([], []);
    expect(parent.length).toBe(0);
    expect(counts.length).toBe(0);
  });
});
describe("segmenter locale hardening (live Firefox bug)", () => {
  it("does not throw on malformed locale tags", () => {
    expect(() => wordSpans("Hello world testing", "undefined" as unknown as string)).not.toThrow();
    expect(() => wordSpans("Hello world testing", "")).not.toThrow();
    expect(wordSpans("Hello world testing", "not a locale!!").length).toBeGreaterThan(0);
  });
});
