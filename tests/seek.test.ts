// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from "vitest";
import { STALE_NODE_THRESHOLD, ScopeHighlighter, tokenIndexAtPoint } from "../src/content/scope";
import { tokenIndexFromRange } from "../src/reader/token-index";

/**
 * T7 click-to-seek hit-testing. jsdom has no layout, so Document.prototype.
 * caretRangeFromPoint (which jsdom lacks entirely) is stubbed to return a
 * collapsed range at a known (node, offset); tokenIndexAtPoint ignores the
 * coordinates and works purely off that range.
 */

/**
 * <pre> before the scope, <post> after it — carets there must miss.
 * Text (trailing space included in sentence tokens): "First sentence. "
 * [0,16) | " Second sentence. " [16,33) | "Third sentence!" [33,49).
 */
function scopeRanges(): Range[] {
  document.body.innerHTML =
    "<span id='pre'>before</span><main id='m'>" +
    "<p id='a'>First sentence. Second sentence. </p>" +
    "<p id='b'>Third sentence!</p></main><span id='post'>after</span>";
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("m")!);
  const tokens = tokenIndexFromRange(range);
  if (tokens.length !== 3) throw new Error("fixture must tokenize to 3 sentences");
  return tokens.map((t) => t.range);
}

/** Main-scope text: "First sentence. " [0,16) | " Second sentence. " [16,33) | "Third sentence!" [33,49). */
function caretAt(node: Node, offset: number): Range {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  return r;
}

type CaretRangeFn = (x: number, y: number) => Range | null;
type CaretPositionFn = (x: number, y: number) => { offsetNode: Node; offset: number } | null;

function stubCaretRange(range: Range | null): void {
  (Document.prototype as { caretRangeFromPoint?: CaretRangeFn }).caretRangeFromPoint = () => range;
}

function clearCaretStubs(): void {
  delete (Document.prototype as { caretRangeFromPoint?: CaretRangeFn }).caretRangeFromPoint;
  delete (Document.prototype as { caretPositionFromPoint?: CaretPositionFn }).caretPositionFromPoint;
}

describe("tokenIndexAtPoint (seek hit-testing)", () => {
  afterEach(clearCaretStubs);

  it("maps a caret inside a token to that token's index", () => {
    const ranges = scopeRanges();
    const textA = document.getElementById("a")!.firstChild as Text;
    const textB = document.getElementById("b")!.firstChild as Text;

    stubCaretRange(caretAt(textA, 6)); // inside "First sentence."
    expect(tokenIndexAtPoint(ranges, 10, 10, document)).toBe(0);

    stubCaretRange(caretAt(textA, 20)); // inside " Second sentence."
    expect(tokenIndexAtPoint(ranges, 10, 10, document)).toBe(1);

    stubCaretRange(caretAt(textB, 7)); // inside "Third sentence!"
    expect(tokenIndexAtPoint(ranges, 10, 10, document)).toBe(2);
  });

  it("maps a caret on an interior token boundary to the following token", () => {
    const ranges = scopeRanges();
    const textA = document.getElementById("a")!.firstChild as Text;
    stubCaretRange(caretAt(textA, 16)); // end of token 0 == start of token 1
    expect(tokenIndexAtPoint(ranges, 0, 0, document)).toBe(1);
  });

  it("returns null for carets outside the scope (before, after)", () => {
    const ranges = scopeRanges();
    const pre = document.getElementById("pre")!.firstChild as Text;
    const post = document.getElementById("post")!.firstChild as Text;
    stubCaretRange(caretAt(pre, 2));
    expect(tokenIndexAtPoint(ranges, 0, 0, document)).toBeNull();
    stubCaretRange(caretAt(post, 2));
    expect(tokenIndexAtPoint(ranges, 0, 0, document)).toBeNull();
  });

  it("returns null when no caret resolves or no ranges are bound", () => {
    stubCaretRange(null);
    expect(tokenIndexAtPoint(scopeRanges(), 0, 0, document)).toBeNull();
    expect(tokenIndexAtPoint([], 0, 0, document)).toBeNull();
  });

  it("falls back to caretPositionFromPoint when caretRangeFromPoint is missing (Firefox)", () => {
    const ranges = scopeRanges();
    const textB = document.getElementById("b")!.firstChild as Text;
    clearCaretStubs();
    (Document.prototype as { caretPositionFromPoint?: CaretPositionFn }).caretPositionFromPoint = () => ({
      offsetNode: textB,
      offset: 3, // inside "Third sentence!"
    });

    expect(tokenIndexAtPoint(ranges, 0, 0, document)).toBe(2);
  });
});

describe("ScopeHighlighter click binding (seek)", () => {
  let highlighter: ScopeHighlighter | null = null;

  afterEach(() => {
    highlighter?.clear("s1");
    highlighter = null;
    clearCaretStubs();
    document.body.innerHTML = "";
  });

  function bindHighlighter(onSeek: (token: number) => void): ScopeHighlighter {
    const ranges = scopeRanges();
    const h = new ScopeHighlighter({ onSeek });
    h.bind("s1", { tokens: [], ranges });
    highlighter = h;
    return h;
  }

  it("fires onSeek for clicks inside the scope and does not stop propagation", () => {
    const seeks: number[] = [];
    const h = bindHighlighter((t) => seeks.push(t));
    const seenByPage: number[] = [];
    const pageListener = (): void => void seenByPage.push(1);
    document.addEventListener("click", pageListener);

    const textA = document.getElementById("a")!.firstChild as Text;
    stubCaretRange(caretAt(textA, 6));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));

    expect(seeks).toEqual([0]);
    expect(seenByPage).toHaveLength(1); // page listener still ran
    document.removeEventListener("click", pageListener);
    h.clear("s1");
  });

  it("stops seeking once unbound (clear) or stale", async () => {
    const seeks: number[] = [];
    const h = bindHighlighter((t) => seeks.push(t));
    const textA = document.getElementById("a")!.firstChild as Text;
    stubCaretRange(caretAt(textA, 6));

    h.clear("s1");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seeks).toEqual([]);

    // Re-bind, then force staleness with a heavy mutation (observer path).
    const ranges = scopeRanges();
    h.bind("s1", { tokens: [], ranges });
    const frag = document.createDocumentFragment();
    for (let i = 0; i < STALE_NODE_THRESHOLD; i++) frag.appendChild(document.createElement("div"));
    document.getElementById("a")!.appendChild(frag);
    await new Promise((r) => setTimeout(r, 0)); // let the MutationObserver run

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seeks).toEqual([]);
  });

  it("ignores clicks on extension UI (id starting leia-)", () => {
    const seeks: number[] = [];
    bindHighlighter((t) => seeks.push(t));
    const bar = document.createElement("div");
    bar.id = "leia-floating-bar";
    bar.textContent = "bar";
    document.body.appendChild(bar);

    stubCaretRange(caretAt(bar.firstChild as Text, 2)); // would map to a token if consulted
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seeks).toEqual([]);
  });

  it("ignores clicks while unbound (no active session)", () => {
    const seeks: number[] = [];
    const h = new ScopeHighlighter({ onSeek: (t) => seeks.push(t) });
    highlighter = h; // never bound
    scopeRanges(); // set up the DOM (ranges unused: no binding to hit-test)
    const textA = document.getElementById("a")!.firstChild as Text;
    stubCaretRange(caretAt(textA, 6));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seeks).toEqual([]);
  });
});