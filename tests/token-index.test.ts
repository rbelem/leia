import { describe, expect, it } from "vitest";
import { tokenIndexFromRange, wordIndexFromRange } from "../src/reader/token-index";
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
    // Trailing whitespace attaches to the preceding sentence (Intl placement).
    expect(tokens.map((t) => t.text)).toEqual([
      "Leia reads pages aloud. ",
      "Hello world.",
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

describe("word ↔ range index (T4)", () => {
  it("word-segments a Latin + CJK selection into real words, round-tripping each range", () => {
    const doc = fixture();
    const body = doc.body;
    const range = doc.createRange();
    range.setStart(body, 0);
    range.setEnd(body, 2);

    const idx = wordIndexFromRange(range, "zh-CN");
    expect(idx).not.toBeNull();
    expect(idx!.words.map((w) => w.text)).toEqual([
      "Leia", "reads", "pages", "aloud.", "Hello", "world.",
      "中文", "句子。", "另", "一个", "句子！", "第三", "句。",
    ]);
    for (const w of idx!.words) {
      expect(w.range.toString()).toBe(w.text); // round-trip invariant at word granularity
    }
  });

  it("merges punctuation runs into the preceding word and drops whitespace", () => {
    const doc = fixture();
    document.body.innerHTML = "<p id='t'>Hello, world! How are you?</p>";
    const node = doc.getElementById("t")!.firstChild! as Text;
    const range = doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);

    const idx = wordIndexFromRange(range, "en")!;
    expect(idx.words.map((w) => w.text)).toEqual(["Hello,", "world!", "How", "are", "you?"]);
    // Words fully cover the text with no gaps or overlaps, whitespace excluded.
    const joined = idx.words.map((w) => w.text).join("");
    expect(joined).toBe(node.data.replace(/\s+/g, ""));
  });

  it("skips style/script/template subtrees — and tables by product decision", () => {
    document.body.innerHTML =
      "<style>.x{color:red}</style><table id='tab'><tr><td>CellA</td><td>CellB</td></tr></table>" +
      "<p id='t'>Readable text only.</p>" +
      "<script>var a=1;</script>";
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const tokens = tokenIndexFromRange(range);
    const joined = tokens.map((t) => t.text).join("");
    expect(joined).not.toContain("color");
    expect(joined).not.toContain("Cell");
    expect(joined).toContain("Readable text only.");
  });

  it("selections starting inside a table still capture that table's text", () => {
    document.body.innerHTML =
      "<table><tr><td id='cell'>Selected cell words</td><td>Other</td></tr></table>";
    const node = document.getElementById("cell")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.data.length);
    const tokens = tokenIndexFromRange(range);
    expect(tokens.map((t) => t.text).join("")).toBe("Selected cell words");
  });

  it("returns null for a collapsed or whitespace-only range", () => {
    const doc = fixture();
    const node = doc.getElementById("a")!.firstChild! as Text;
    const collapsed = doc.createRange();
    collapsed.setStart(node, 2);
    collapsed.setEnd(node, 2);
    expect(wordIndexFromRange(collapsed, "en")).toBeNull();

    document.body.innerHTML = "<p id='ws'>   \n  </p>";
    const wsNode = doc.getElementById("ws")!.firstChild! as Text;
    const wsRange = doc.createRange();
    wsRange.setStart(wsNode, 0);
    wsRange.setEnd(wsNode, wsNode.data.length);
    expect(wordIndexFromRange(wsRange, "en")).toBeNull();
  });
});

describe("re-layout validity (live ranges)", () => {
  it("ranges keep resolving to the same text when layout shifts around them", () => {
    const doc = fixture();
    const body = doc.body;
    const range = doc.createRange();
    range.setStart(body, 0);
    range.setEnd(body, 2);
    const before = tokenIndexFromRange(range);
    const texts = before.map((t) => t.text);

    // Layout shifts around the scope: a sibling before it, a sibling after
    // it, both removed again, and container styles that force a reflow.
    const lead = doc.createElement("p");
    lead.textContent = "Inserted before the scope. ";
    body.insertBefore(lead, doc.getElementById("a")!);

    const tail = doc.createElement("aside");
    tail.textContent = "Ad after the scope. ";
    body.appendChild(tail);

    body.removeChild(lead);
    body.removeChild(tail);

    const a = doc.getElementById("a")!;
    a.style.width = "200px";
    a.style.fontSize = "3em"; // real browsers reflow; ranges are DOM positions, immune
    a.className = "reflow";

    // Live ranges track the shifts: each original token still stringifies to
    // its text, and a fresh index over the (now shifted) range agrees.
    for (const t of before) expect(t.range.toString()).toBe(t.text);
    expect(tokenIndexFromRange(range).map((t) => t.text)).toEqual(texts);
  });
});