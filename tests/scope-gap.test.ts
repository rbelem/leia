// SPDX-License-Identifier: MPL-2.0
/**
 * Coverage-gap tests for content/scope.ts, complementing article-scope.test.ts
 * and stale-scope.test.ts:
 *  - captureArticleDetailed failure stages via a scripted Readability mock
 *    (null parse, throwing parse, whitespace text, uncovered text, style-only
 *    root → no tokens) and the deepestCoveringElement fallbacks (partial /
 *    loose coverage, used only when no element fully contains the text);
 *  - articleTitleElement qualification branches (in-root, following, blank,
 *    hidden by attribute/inline style/computed style, foreign container,
 *    h2 fallback, heading echo);
 *  - tokenIndexAtPoint / caretRangeAtPoint caret resolution paths;
 *  - ScopeHighlighter edges (stale-on-dead-ranges, wrong session, heading
 *    clamp, followReading deadzone/scroll/fallback, title-segment word
 *    re-basing, click-to-seek guards, empty/detached binding shapes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScopeHighlighter,
  captureArticle,
  captureScopeDetailed,
  captureSelection,
  tokenIndexAtPoint,
  type CapturedScope,
} from "../src/content/scope";
import { tokenIndexFromRange } from "../src/reader/token-index";

/**
 * Document with optional (deletable) caret-resolution APIs — lib.dom types
 * caretRangeFromPoint as a required method, which would block `delete`.
 */
type CaretDoc = Omit<Document, "caretRangeFromPoint" | "caretPositionFromPoint"> & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

// Scripted Readability: parse/isProbablyReaderable are state-driven so every
// capture stage is deterministic (the real parser is exercised by
// article-scope*.test.ts; here its outcomes are the fixture).
const readabilityState = vi.hoisted(() => ({
  parse: null as null | { textContent?: string } | Error,
  readerable: true,
}));

vi.mock("@mozilla/readability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mozilla/readability")>();
  return {
    ...actual,
    Readability: class {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_doc: Document) {}
      parse(): { textContent?: string } | null {
        if (readabilityState.parse instanceof Error) throw readabilityState.parse;
        return readabilityState.parse;
      }
    },
    isProbablyReaderable: () => readabilityState.readerable,
  };
});

function captureBody(): CapturedScope | null {
  return captureArticle(window);
}

describe("captureArticleDetailed failure stages (scripted Readability)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    readabilityState.parse = null;
    readabilityState.readerable = true;
  });

  it("reports the stage when Readability extracts no article (null parse)", () => {
    document.body.innerHTML = "<article><p>Long enough body text for the readability gate.</p></article>";
    readabilityState.parse = null;
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("no selection; Readability extracted no article text");
  });

  it("reports the stage when Readability throws", () => {
    document.body.innerHTML = "<article><p>Long enough body text for the readability gate.</p></article>";
    readabilityState.parse = new Error("parser exploded");
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("Readability failed: Error: parser exploded");
  });

  it("reports the stage when the extracted text normalizes to nothing", () => {
    document.body.innerHTML = "<article><p>Filler</p></article>";
    readabilityState.parse = { textContent: " \n\t " };
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("Readability extracted no article text");
  });

  it("reports the stage when no element covers the extracted text", () => {
    document.body.innerHTML = ""; // body exists but holds nothing
    readabilityState.parse = { textContent: "nowhere to be found" };
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("no element in the page covers the extracted article text");
  });

  it("reports the stage when the covering root yields no readable tokens (style-only UOL regression)", () => {
    // A deep <style> block can reach the article's text length AND contain
    // it (the real UOL regression) — but a style's range walk emits nothing,
    // so the capture must fail with a reason instead of returning junk.
    document.body.innerHTML = "<style>.articlebody { color: red; }</style>";
    readabilityState.parse = { textContent: "articlebody" };
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("extracted article produced no readable tokens");
  });
});

describe("deepestCoveringElement fallbacks (no full containment)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    readabilityState.readerable = true;
  });

  it("falls back to the deepest element covering ≥60% of the article text", () => {
    readabilityState.parse = { textContent: "abcdefghij" };
    // Covers abcdefgh (8/10 = 80%) — no element fully contains the text.
    document.body.innerHTML = "<div><p>abcdefghxyz</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens.map((t) => t.text).join("")).toBe("abcdefghxyz");
  });

  it("falls back to the deepest length-qualified element below 60% coverage", () => {
    readabilityState.parse = { textContent: "abcdefghij" };
    // Covers only abc (3/10 = 30%) — no partial candidate either.
    document.body.innerHTML = "<div><p>abczzzzzzzzzz</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens.map((t) => t.text).join("")).toBe("abczzzzzzzzzz");
  });
});

describe("articleTitleElement qualification (title segment assembly)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    readabilityState.readerable = true;
  });

  it("skips a heading inside the body root and takes the preceding outer one", () => {
    // Multi-block root: no single child fully covers the extracted text, so
    // the root resolves to the wrapping div (not one of its blocks).
    readabilityState.parse = { textContent: "Inner headline First block of the prose. Second block of the prose." };
    document.body.innerHTML =
      "<h1 id='outer'>Outer headline</h1>" +
      "<div id='root'><h1>Inner headline</h1><p>First block of the prose.</p><p>Second block of the prose.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    // The outer h1 opens the scope (the inner one is read in place by the
    // root walk); bodyFrom marks the body segment.
    expect(scope!.tokens[0]!.text).toBe("Outer headline");
    expect(scope!.tokens[0]!.heading).toBe(true);
    expect(scope!.bodyFrom).toBe(1);
    expect(scope!.tokens.map((t) => t.text).join("")).toContain("Inner headline");
  });

  it("ignores headings that FOLLOW the body root in document order", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML =
      "<div id='root'><p>Body prose lives here.</p></div><h1>Late headline</h1>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens[0]!.heading).toBeUndefined(); // no title segment
    expect(scope!.tokens[0]!.text).toContain("Body prose");
  });

  it("ignores blank headings", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML = "<h1>   </h1><div id='root'><p>Body prose lives here.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens[0]!.heading).toBeUndefined();
  });

  it("ignores headings hidden by attribute, aria, or inline style", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML =
      "<h1 hidden>Hidden one</h1>" +
      "<h1 aria-hidden='true'>Hidden two</h1>" +
      "<h1 style='display: none'>Hidden three</h1>" +
      "<div id='root'><p>Body prose lives here.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    const joined = scope!.tokens.map((t) => t.text).join("");
    expect(joined).not.toContain("Hidden");
    expect(scope!.tokens[0]!.heading).toBeUndefined();
  });

  it("ignores headings hidden by computed style (stylesheet class)", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML =
      "<style>.ghost { display: none; }</style>" +
      "<h1 class='ghost'>Ghost headline</h1>" +
      "<div id='root'><p>Body prose lives here.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    const joined = scope!.tokens.map((t) => t.text).join("");
    expect(joined).not.toContain("Ghost headline");
  });

  it("ignores headings outside the root's article/main container", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML =
      "<article><h1>Foreign headline</h1></article>" +
      "<main><div id='root'><p>Body prose lives here.</p></div></main>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens[0]!.heading).toBeUndefined();
    expect(scope!.tokens.map((t) => t.text).join("")).not.toContain("Foreign headline");
  });

  it("falls back to a qualifying h2 when no h1 precedes the root", () => {
    readabilityState.parse = { textContent: "Body prose lives here." };
    document.body.innerHTML = "<h2>Sub headline</h2><div id='root'><p>Body prose lives here.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    expect(scope!.tokens[0]!.text).toBe("Sub headline");
    expect(scope!.tokens[0]!.heading).toBe(true);
  });

  it("skips the title segment when the body root already opens with the title (echo)", () => {
    readabilityState.parse = { textContent: "Echo title" };
    document.body.innerHTML =
      "<h1>Echo Title</h1><div id='root'><p>Echo title — rest of the lead.</p></div>";
    const scope = captureBody();
    expect(scope).not.toBeNull();
    // No separate title segment: the body's own opening covers it.
    expect(scope!.bodyFrom).toBeUndefined();
    expect(scope!.tokens[0]!.text).toContain("Echo title");
  });
});

// ---------------------------------------------------------------------------
// Selection flag mapping + caret resolution
// ---------------------------------------------------------------------------

describe("captureSelection flag mapping", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stamps heading/blockStart flags on selection tokens crossing blocks", () => {
    document.body.innerHTML = "<h1 id='h'>Big Title</h1><p id='p'>First body sentence here.</p>";
    const h = document.getElementById("h")!.firstChild as Text;
    const p = document.getElementById("p")!.firstChild as Text;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(h, 0);
    range.setEnd(p, (p as Text).data.length);
    sel.removeAllRanges();
    sel.addRange(range);

    const scope = captureSelection(window)!;
    expect(scope.tokens[0]).toEqual({ text: "Big Title", blockStart: true, heading: true });
    // Body continuation keeps no heading flag (blockStart is still stamped).
    expect(scope.tokens[1]!.heading).toBeUndefined();
    sel.removeAllRanges();
  });
});

function tokensOf(selector: string): CapturedScope {
  const el = document.querySelector(selector)!;
  const range = document.createRange();
  range.selectNodeContents(el);
  const tokens = tokenIndexFromRange(range);
  if (tokens.length === 0) throw new Error("fixture must tokenize");
  return { tokens, ranges: tokens.map((t) => t.range) };
}

function textScope(text: string): CapturedScope {
  document.body.innerHTML = `<p id='t'>${text}</p>`;
  return tokensOf("#t");
}

describe("tokenIndexAtPoint caret resolution", () => {
  let scope: CapturedScope;
  const doc = document as CaretDoc;

  beforeEach(() => {
    document.body.innerHTML = "";
    delete doc.caretRangeFromPoint;
    delete doc.caretPositionFromPoint;
    scope = textScope("Alpha sentence. Beta sentence. Gamma sentence.");
  });

  afterEach(() => {
    delete doc.caretRangeFromPoint;
    delete doc.caretPositionFromPoint;
  });

  /** Stub caret resolution to a collapsed range at (node, offset). */
  function stubCaret(node: Node, offset: number, via: "fromPoint" | "fromPosition"): void {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    if (via === "fromPoint") {
      doc.caretRangeFromPoint = () => range;
    } else {
      doc.caretPositionFromPoint = () => ({ offsetNode: node, offset });
    }
  }

  it("resolves through caretPositionFromPoint when caretRangeFromPoint is absent", () => {
    stubCaret((scope.ranges[0] as Range).startContainer, 2, "fromPosition"); // inside "Alpha"
    expect(tokenIndexAtPoint(scope.ranges, 1, 1, document)).toBe(0);
  });

  it("returns null when caretPositionFromPoint also fails", () => {
    doc.caretPositionFromPoint = () => null;
    expect(tokenIndexAtPoint(scope.ranges, 1, 1, document)).toBeNull();
  });

  it("returns null when caretRangeFromPoint fails", () => {
    doc.caretRangeFromPoint = () => null;
    expect(tokenIndexAtPoint(scope.ranges, 1, 1, document)).toBeNull();
  });

  it("returns null for an empty range set", () => {
    stubCaret((scope.ranges[0] as Range).startContainer, 2, "fromPoint");
    expect(tokenIndexAtPoint([], 1, 1, document)).toBeNull();
  });

  it("returns null when the caret sits before every token", () => {
    document.body.innerHTML = "<p id='pre'>Before text.</p><p id='t'>Alpha sentence. Beta sentence.</p>";
    const local = tokensOf("#t");
    stubCaret(document.getElementById("pre")!.firstChild!, 2, "fromPoint");
    expect(tokenIndexAtPoint(local.ranges, 1, 1, document)).toBeNull();
  });

  it("returns null when the caret sits past the last token's end", () => {
    document.body.innerHTML = "<p id='t'>Alpha sentence. Beta sentence.</p><p id='post'>After text.</p>";
    const local = tokensOf("#t");
    stubCaret(document.getElementById("post")!.firstChild!, 2, "fromPoint");
    expect(tokenIndexAtPoint(local.ranges, 1, 1, document)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ScopeHighlighter edges
// ---------------------------------------------------------------------------

/** Highlight shim capturing what the sentence/word registries receive. */
function installCaptureShim(): { last: Range[]; wordLast: Range[] | null; applied: number; deleted: string[] } {
  const state = { last: [] as Range[], wordLast: null as Range[] | null, applied: 0, deleted: [] as string[] };
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      highlights: {
        set: (name: string, hl: unknown) => {
          state.applied += 1;
          if (name === "leia-word") state.wordLast = rangesOf(hl);
          else state.last = rangesOf(hl);
        },
        delete: (name: string) => void state.deleted.push(name),
      },
    },
  });
  (globalThis as unknown as { Highlight: unknown }).Highlight = class Highlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  };
  return state;
}

function rangesOf(hl: unknown): Range[] {
  return ((hl as { ranges?: Range[] })?.ranges ?? []) as Range[];
}

/** Title-extended scope: [title h1][body p] tokenized as separate ranges. */
function titleExtendedScope(): CapturedScope {
  document.body.innerHTML = "<h1 id='title'>Title Words</h1><p id='body'>Body words speak now.</p>";
  const titleEl = document.getElementById("title")!;
  const bodyEl = document.getElementById("body")!;
  const titleRange = document.createRange();
  titleRange.selectNodeContents(titleEl);
  const bodyRange = document.createRange();
  bodyRange.selectNodeContents(bodyEl);
  const titleTokens = tokenIndexFromRange(titleRange);
  const bodyTokens = tokenIndexFromRange(bodyRange);
  return {
    tokens: [
      ...titleTokens.map((t) => ({ text: t.text, blockStart: true as const, heading: true as const })),
      ...bodyTokens.map((t) => ({ text: t.text })),
    ],
    ranges: [...titleTokens, ...bodyTokens].map((t) => t.range),
    bodyFrom: titleTokens.length,
  };
}

describe("ScopeHighlighter edges", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("show() with a foreign sessionId applies nothing", () => {
    const shim = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    highlighter.bind("s1", textScope("Alpha sentence."));
    highlighter.show("other", 0, 0);
    expect(shim.applied).toBe(0);
  });

  it("marks stale via show() when the scope tree was never connected (dead ranges)", () => {
    const shim = installCaptureShim();
    const staleCalls: number[] = [];
    const highlighter = new ScopeHighlighter({ onStale: () => void staleCalls.push(1) });
    // Never-connected subtree: the observer binds, but isLive() is false from
    // the first show → markStale on the spot. (jsdom quirk: isConnected on a
    // REMOVED node read through Range.startContainer stays stale-true, so
    // detach-after-bind cannot exercise this path — a live page can.)
    const detached = document.createElement("div");
    detached.innerHTML = "<p>Never attached prose.</p>";
    const range = document.createRange();
    range.selectNodeContents(detached.querySelector("p")!);
    const tokens = tokenIndexFromRange(range);
    expect(tokens.length).toBeGreaterThan(0);
    highlighter.bind("s1", { tokens, ranges: tokens.map((t) => t.range) });
    highlighter.show("s1", 0, 0);
    expect(staleCalls).toHaveLength(1);
    highlighter.show("s1", 0, 0); // stale guard: no second call, no highlight
    expect(staleCalls).toHaveLength(1);
    expect(shim.applied).toBe(0);
  });

  it("keeps a heading's wash tight when the chunk starts mid-heading", () => {
    const shim = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    // One h1 with two sentence tokens: [H(a: heading+blockStart), H(b: plain)].
    document.body.innerHTML = "<h1 id='h'>Title one. Title two.</h1>";
    const { tokens, ranges } = tokensOf("#h");
    expect(tokens).toHaveLength(2); // two sentences inside the heading
    expect(tokens[0].heading).toBe(true);
    expect(tokens[1].heading).toBeUndefined(); // continuation token: not a unit start
    highlighter.bind("s1", { tokens, ranges });

    highlighter.show("s1", 1, 1); // chunk = the heading's second sentence only
    expect(shim.last).toHaveLength(1); // clamped: no bleed into the sentence before it
    expect(shim.last[0].toString()).toBe("Title two.");
  });

  it("re-bases word lookups past the title segment; title tokens keep no word map", () => {
    const shim = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    highlighter.bind("s1", titleExtendedScope(), "en");

    // Title token (from < bodyFrom): word mapping is refused, and a failed
    // mapping with a word present keeps the previous underline (no delete,
    // no flicker) — with none held yet the word layer stays unset.
    highlighter.show("s1", 0, 0, { begin: 0, end: 5 });
    expect(shim.wordLast).toBeNull();
    expect(shim.deleted).not.toContain("leia-word");

    // Body token: chunk-relative offsets land past the title's characters.
    highlighter.show("s1", 1, 1, { begin: 6, end: 11 });
    expect(shim.wordLast?.[0]?.toString()).toBe("words");
  });

  it("keeps the previous word underline when the offset maps outside every span", () => {
    const shim = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    highlighter.bind("s1", textScope("Alpha sentence."), "en");
    highlighter.show("s1", 0, 0, { begin: 0, end: 5 }); // real word first
    expect(shim.wordLast?.[0]?.toString()).toBe("Alpha");
    highlighter.show("s1", 0, 0, { begin: 999_000, end: 999_004 }); // beyond all spans
    expect(shim.wordLast?.[0]?.toString()).toBe("Alpha"); // kept, not deleted
    expect(shim.deleted).not.toContain("leia-word");
  });

  it("hasSession tracks the binding lifecycle", () => {
    const highlighter = new ScopeHighlighter();
    highlighter.bind("s1", textScope("Alpha sentence."));
    expect(highlighter.hasSession("s1")).toBe(true);
    expect(highlighter.hasSession("s2")).toBe(false);
    highlighter.clear("s1");
    expect(highlighter.hasSession("s1")).toBe(false);
  });

  it("click-to-seek fires onSeek for page clicks and guards extension chrome and caret misses", () => {
    const seen: number[] = [];
    const highlighter = new ScopeHighlighter({ onSeek: (t) => void seen.push(t) });
    const scope = textScope("Alpha sentence. Beta sentence.");
    highlighter.bind("s1", scope);

    const doc = document as CaretDoc;
    const click = (target: Element): void => {
      const node = (target.firstChild ?? target) as Node;
      const range = document.createRange();
      range.setStart(node, 1);
      range.collapse(true);
      doc.caretRangeFromPoint = () => range;
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      delete doc.caretRangeFromPoint;
    };

    // Inside the scope → seek.
    click(document.getElementById("t")!);
    expect(seen).toEqual([0]);

    // Extension chrome (id^='leia-') is ignored even when the caret resolves.
    const bar = document.createElement("div");
    bar.id = "leia-bar";
    bar.textContent = "bar";
    document.body.appendChild(bar);
    click(bar);
    expect(seen).toEqual([0]);

    // Caret does not resolve → no token → no seek.
    doc.caretRangeFromPoint = () => null;
    document.getElementById("t")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    delete doc.caretRangeFromPoint;
    expect(seen).toEqual([0]);
  });

  it("ignores clicks when unbound (no onSeek) and when stale", () => {
    textScope("Alpha sentence.");
    const noSeek = new ScopeHighlighter();
    noSeek.bind("s1", tokensOf("#t"));
    expect(() =>
      document.getElementById("t")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();

    // Stale scope (never-connected tree): the doc-level listener stays bound
    // but onClick bails on stale before resolving a token.
    const detached = document.createElement("div");
    detached.innerHTML = "<p>Never attached prose.</p>";
    const range = document.createRange();
    range.selectNodeContents(detached.querySelector("p")!);
    const tokens = tokenIndexFromRange(range);
    const stale = new ScopeHighlighter({ onSeek: () => {} });
    stale.bind("s2", { tokens, ranges: tokens.map((t) => t.range) });
    stale.show("s2", 0, 0); // isLive false → stale
    expect(() =>
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
  });

  it("binds a scope with no ranges (empty index) and keeps showing a no-op", () => {
    const shim = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    highlighter.bind("s1", { tokens: [], ranges: [] }); // scopeRangesRoot → null → no observer
    expect(() => highlighter.show("s1", 0, 0)).not.toThrow();
    highlighter.bind("s2", { tokens: [], ranges: [] }, "en"); // fullScopeRange → null → no word map
    expect(() => highlighter.show("s2", 0, 0)).not.toThrow();
    // Empty index → empty washes; nothing ever underlines real text.
    expect(shim.last).toHaveLength(0);
    expect(shim.wordLast).toBeNull();
  });

  it("binds a detached-fragment scope whose root resolves to a parentless text node", () => {
    const fragment = document.createDocumentFragment();
    const text = document.createTextNode("Detached prose here.");
    fragment.appendChild(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    const tokens = tokenIndexFromRange(range);
    expect(tokens.length).toBeGreaterThan(0);
    const highlighter = new ScopeHighlighter();
    // scopeRangesRoot: commonAncestorContainer is the text node → its
    // parentElement inside the fragment is null → startObserving bails.
    expect(() => highlighter.bind("s1", { tokens, ranges: tokens.map((t) => t.range) })).not.toThrow();
    expect(() => highlighter.show("s1", 0, 0)).not.toThrow();
  });

  it("binds a fragment-rooted element scope whose parent is the fragment itself", () => {
    const fragment = document.createDocumentFragment();
    const outer = document.createElement("div");
    outer.innerHTML = "<p>Fragment prose here.</p>";
    fragment.appendChild(outer);
    const range = document.createRange();
    range.selectNodeContents(outer);
    const tokens = tokenIndexFromRange(range);
    expect(tokens.length).toBeGreaterThan(0);
    const highlighter = new ScopeHighlighter();
    // scopeRangesRoot resolves to the outer div (element); its parentElement
    // is null (fragment parent) → the observer targets the root itself.
    expect(() => highlighter.bind("s1", { tokens, ranges: tokens.map((t) => t.range) })).not.toThrow();
    expect(() => highlighter.show("s1", 0, 0)).not.toThrow();
  });

  it("binds a document-rooted range with a locale (fullScopeRange bails on a null doc)", () => {
    const highlighter = new ScopeHighlighter();
    const range = document.createRange();
    range.setStart(document, 0); // Document container → ownerDocument === null
    range.setEnd(document, 0);
    expect(() =>
      highlighter.bind("s1", { tokens: [{ text: "x" }], ranges: [range] }, "en"),
    ).not.toThrow();
  });

  // Note on remaining uncovered branches (defensive, unreachable via the DOM):
  //  - bind() L347 `idx && idx.words.length > 0` false side: wordSpans never
  //    returns empty spans for non-empty text (punctuation still flushes a
  //    span), so a tokenized scope always builds a word index.
  //  - markStale() L490 / onMutations() L520 `if (this.stale) return`: both
  //    call sites guard on stale first, and markStale disconnects the
  //    observer (discarding its queued records), so no double-mark is
  //    reachable.
  //  - opensWithNormalized() L137 `s ?? ""`: title/root textContent is never
  //    null for elements.

  describe("followReading (viewport centering)", () => {
    const originalRect = Range.prototype.getBoundingClientRect;
    const originalScrollBy = window.scrollBy;
    let scrollCalls: Array<{ top: number }>;

    beforeEach(() => {
      scrollCalls = [];
      window.scrollBy = ((opts?: ScrollOptions) => {
        if (opts && typeof opts === "object") scrollCalls.push(opts as { top: number });
      }) as typeof window.scrollBy;
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    });

    afterEach(() => {
      Range.prototype.getBoundingClientRect = originalRect;
      window.scrollBy = originalScrollBy;
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    function stubRect(top: number, height: number): void {
      Range.prototype.getBoundingClientRect = function (): DOMRect {
        return { top, height, bottom: top + height } as DOMRect;
      };
    }

    it("scrolls when the sentence is far from the viewport center", () => {
      installCaptureShim();
      const highlighter = new ScopeHighlighter();
      highlighter.bind("s1", textScope("Alpha sentence. Beta sentence."));
      stubRect(5000, 40); // offsetFromCenter = 5000 + 20 − 400 = 4620 ≫ deadzone 200
      highlighter.show("s1", 0, 0);
      expect(scrollCalls).toHaveLength(1);
      expect(scrollCalls[0].top).toBeCloseTo(4620);
    });

    it("stays quiet within the ±25% deadzone", () => {
      installCaptureShim();
      const highlighter = new ScopeHighlighter();
      highlighter.bind("s1", textScope("Alpha sentence. Beta sentence."));
      stubRect(350, 40); // offsetFromCenter = 350 + 20 − 400 = −30, |−30| ≤ 200
      highlighter.show("s1", 0, 0);
      expect(scrollCalls).toHaveLength(0);
    });

    it("falls back to scrollIntoView when smooth scrollBy throws", () => {
      installCaptureShim();
      const highlighter = new ScopeHighlighter();
      highlighter.bind("s1", textScope("Alpha sentence. Beta sentence."));
      window.scrollBy = (() => {
        throw new TypeError("no options support");
      }) as typeof window.scrollBy;
      let scrolledInto = 0;
      (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = () => void (scrolledInto += 1);
      stubRect(5000, 40);
      highlighter.show("s1", 0, 0);
      expect(scrolledInto).toBe(1);
    });
  });
});
