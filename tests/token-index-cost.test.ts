import { describe, expect, it } from "vitest";
import { tokenIndexFromRange, wordIndexFromRange } from "../src/reader/token-index";

const PARAGRAPH =
  "Leia reads web pages aloud with a marching highlight that follows the text being spoken. " +
  "The reader chunks the selection into short utterances so the highlight stays responsive. " +
  "中文阅读器可以把网页内容朗读出来，高亮会跟随正在朗读的文字。每一个句子都会切分成词语。";

/** ~40k-char article: 300 paragraphs × ~133 chars. */
function articleFixture(): Document {
  const ps: string[] = [];
  for (let i = 0; i < 300; i += 1) {
    ps.push(`<p>${i % 3 === 0 ? PARAGRAPH : PARAGRAPH.slice(0, 90)}</p>`);
  }
  document.body.innerHTML = ps.join("");
  return document;
}

describe("token-index build cost (T4 AC: bounded)", () => {
  it("builds sentence + word indexes over a long article well under a generous bound", () => {
    const doc = articleFixture();
    const body = doc.body;
    const full = body.textContent ?? "";
    expect(full.length).toBeGreaterThan(30000);

    const range = doc.createRange();
    range.setStart(body, 0);
    range.setEnd(body, body.childNodes.length);
    const start = performance.now();
    const tokens = tokenIndexFromRange(range);
    const wordIdx = wordIndexFromRange(range, "zh-CN");
    const elapsed = performance.now() - start;

    expect(tokens.length).toBeGreaterThan(100);
    expect(wordIdx).not.toBeNull();
    expect(wordIdx!.words.length).toBeGreaterThan(100);
    // Round-trip spot check on the full index: every range stringifies to its text.
    for (const t of tokens) expect(t.range.toString()).toBe(t.text);
    for (const w of wordIdx!.words) expect(w.range.toString()).toBe(w.text);
    expect(wordIdx!.counts.reduce((n, c) => n + c, 0)).toBe(wordIdx!.words.length);
    // Generous bound: catches accidental quadratic blowups (a quadratic walk on
    // 40k chars would take minutes), never trips on slow CI machines.
    expect(elapsed).toBeLessThan(5000);
  });
});