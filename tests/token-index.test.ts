import { describe, expect, it } from "vitest";
import { tokenIndexFromRange } from "../src/reader/token-index";
import { splitTokens } from "../src/reader/sentences";

function fixture(): Document {
  document.body.innerHTML =
    "<p id='a'>Leia reads pages aloud. Hello world.</p>" +
    "<p id='b'>中文句子。另一个句子！第三句。</p>";
  return document;
}

describe("token ↔ range index (en + CJK)", () => {
  it("indexes a multi-paragraph selection at sentence granularity", () => {
    const doc = fixture();
    const body = doc.body;
    const range = doc.createRange();
    range.setStart(body, 0); // element container: child index
    range.setEnd(body, 2);

    const tokens = tokenIndexFromRange(range);
    expect(tokens.map((t) => t.text)).toEqual([
      "Leia reads pages aloud.",
      " Hello world.",
      "中文句子。",
      "另一个句子！",
      "第三句。",
    ]);
  });

  it("round-trips: every token's range stringifies to its exact text", () => {
    const doc = fixture();
    const startNode = doc.getElementById("a")!.firstChild! as Text;
    const endNode = doc.getElementById("b")!.firstChild! as Text;
    const range = doc.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.data.length);

    const tokens = tokenIndexFromRange(range);
    expect(tokens.length).toBeGreaterThan(1);
    for (const t of tokens) {
      expect(t.range.toString()).toBe(t.text);
    }
  });

  it("tokenizer and DOM index agree on the same text", () => {
    const doc = fixture();
    const startNode = doc.getElementById("a")!.firstChild! as Text;
    const endNode = doc.getElementById("b")!.firstChild! as Text;
    const full = startNode.data + endNode.data;
    const fromTokens = splitTokens(full).map((t) => t.text);

    const range = doc.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.data.length);
    const fromDom = tokenIndexFromRange(range).map((t) => t.text);

    expect(fromDom).toEqual(fromTokens);
  });

  it("splits an over-cap sentence into sub-ranges that stay contiguous", () => {
    document.body.innerHTML = "<p id='long'>" + "Alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(30) + "</p>";
    const doc = document;
    const node = doc.getElementById("long")!.firstChild! as Text;
    const range = doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);

    const tokens = tokenIndexFromRange(range);
    expect(tokens.length).toBeGreaterThan(1); // one 1650-char sentence → several pieces
    for (const t of tokens) {
      expect(t.text.length).toBeLessThanOrEqual(250);
      expect(t.range.toString()).toBe(t.text);
    }
    // Pieces are contiguous and cover the selection exactly.
    const joined = tokens.map((t) => t.text).join("");
    expect(joined.length).toBe(node.data.length);
    expect(joined).toBe(node.data);
  });

  it("returns an empty index for a collapsed range", () => {
    const doc = fixture();
    const node = doc.getElementById("a")!.firstChild!;
    const range = doc.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 2);
    expect(tokenIndexFromRange(range)).toEqual([]);
  });
});