import { beforeEach, describe, expect, it } from "vitest";
import {
  STALE_CHAR_THRESHOLD,
  STALE_NODE_THRESHOLD,
  ScopeHighlighter,
  captureArticle,
  type CapturedScope,
} from "../src/content/scope";
import { tokenIndexFromRange } from "../src/reader/token-index";

const PROSE =
  "The quick brown fox jumps over the lazy dog and keeps on reading. ".repeat(5) +
  "A second sentence to lengthen the article prose for the reader. ".repeat(4);

function articleScope(): CapturedScope {
  document.body.innerHTML = `<main id='a'><p>${PROSE}</p><p>${PROSE}</p></main>`;
  const scope = captureArticle(window);
  if (!scope) throw new Error("fixture must be capturable");
  return scope;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)); // let MutationObserver callbacks run
}

/** Minimal CSS Custom Highlight shim so setHighlight calls are observable. */
function installHighlightShim(): () => number {
  let applied = 0;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: { set: () => void (applied += 1), delete: () => {} } },
  });
  (globalThis as unknown as { Highlight: unknown }).Highlight = class Highlight {};
  return () => applied;
}

describe("freeze-scope staleness (T3)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("marks the scope stale on heavy subtree mutation and drops further highlights", async () => {
    const applied = installHighlightShim();
    let staleCalls = 0;
    const highlighter = new ScopeHighlighter({ onStale: () => void (staleCalls += 1) });
    highlighter.bind("s1", articleScope());
    highlighter.show("s1", 0, 0);
    expect(applied()).toBe(1);

    const root = document.querySelector("main")!;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < STALE_NODE_THRESHOLD; i++) frag.appendChild(document.createElement("div"));
    root.appendChild(frag);
    await flush();

    expect(staleCalls).toBe(1);
    highlighter.show("s1", 0, 0); // stale: highlight must not re-apply
    expect(applied()).toBe(1);
  });

  it("ignores light mutations (small additions and tiny text edits)", async () => {
    let staleCalls = 0;
    const highlighter = new ScopeHighlighter({ onStale: () => void (staleCalls += 1) });
    highlighter.bind("s1", articleScope());

    const root = document.querySelector("main")!;
    root.appendChild(document.createElement("span")); // 1 node
    // Small-delta edit, like a live clock tick: replaces a few chars, keeps length.
    const p = root.querySelector("p")!.firstChild as Text;
    p.data = p.data.slice(0, 10) + "Small clock tick edit. " + p.data.slice(33);
    await flush();
    expect(staleCalls).toBe(0);
  });

  it("stales on a heavy characterData rewrite", async () => {
    let staleCalls = 0;
    const highlighter = new ScopeHighlighter({ onStale: () => void (staleCalls += 1) });
    highlighter.bind("s1", articleScope());

    const p = document.querySelector("p")!.firstChild as Text;
    p.data = "x".repeat(STALE_CHAR_THRESHOLD + 1);
    await flush();
    expect(staleCalls).toBe(1);
  });

  it("stales when the scope root itself is replaced (SPA content swap)", async () => {
    let staleCalls = 0;
    const highlighter = new ScopeHighlighter({ onStale: () => void (staleCalls += 1) });
    highlighter.bind("s1", articleScope());

    document.querySelector("main")!.remove();
    await flush();
    expect(staleCalls).toBe(1);
  });

  it("clear() detaches the observer and resets the binding", async () => {
    let staleCalls = 0;
    const highlighter = new ScopeHighlighter({ onStale: () => void (staleCalls += 1) });
    highlighter.bind("s1", articleScope());
    highlighter.clear("s1");

    const root = document.querySelector("main")!;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < STALE_NODE_THRESHOLD; i++) frag.appendChild(document.createElement("div"));
    root.appendChild(frag);
    await flush();
    expect(staleCalls).toBe(0);
  });
});

/** Highlight shim that records the exact ranges setHighlight receives. */
function installCaptureShim(): { last: Range[]; applied: number } {
  const state = { last: [] as Range[], applied: 0 };
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: { set: () => void (state.applied += 1), delete: () => {} } },
  });
  (globalThis as unknown as { Highlight: unknown }).Highlight = class Highlight {
    constructor(...ranges: Range[]) {
      state.last = ranges;
    }
  };
  return state;
}

function textScope(text: string): CapturedScope {
  document.body.innerHTML = `<p id='t'>${text}</p>`;
  const node = document.getElementById("t")!.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.data.length);
  const tokens = tokenIndexFromRange(range);
  if (tokens.length === 0) throw new Error("fixture must tokenize");
  return { tokens, ranges: tokens.map((t) => t.range) };
}

describe("word-level highlight (T20)", () => {
  // "The quick fox reads pages aloud. Hello world."
  // words (en): The[0,3) quick[4,9) fox[10,13) reads[14,19) pages[20,25) aloud.[26,32) Hello[33,38) world.[39,45)
  // tokens: "The quick fox reads pages aloud. " (0..33) and "Hello world." (33..45)
  const TEXT = "The quick fox reads pages aloud. Hello world.";

  it("highlights the single page word range a chunk-relative word event points at", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT);
    highlighter.bind("s1", scope, "en");

    // Chunk [0..0]: its text starts at scope offset 0; word "reads" = chunk offsets 14..19.
    highlighter.show("s1", 0, 0, { begin: 14, end: 19 });
    expect(state.applied).toBe(1);
    expect(state.last).toHaveLength(1);
    expect(state.last[0].toString()).toBe("reads");

    // Chunk [1..1]: chunk text starts at scope offset 33 ("Hello world."); word [0..5) → "Hello".
    highlighter.show("s1", 1, 1, { begin: 0, end: 5 });
    expect(state.last).toHaveLength(1);
    expect(state.last[0].toString()).toBe("Hello");
  });

  it("falls back to the sentence chunk highlight when the word offset maps between words (whitespace)", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT);
    highlighter.bind("s1", scope, "en");

    // Offset 3 is the space after "The" — inside no word span.
    highlighter.show("s1", 0, 1, { begin: 3, end: 3 });
    expect(state.last).toHaveLength(2);
    expect(state.last.map((r) => r.toString()).join("")).toBe(TEXT);
  });

  it("uses sentence-range behavior when bound without a locale", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT);
    highlighter.bind("s1", scope); // no locale → no word map

    highlighter.show("s1", 0, 1, { begin: 14, end: 19 });
    expect(state.last).toHaveLength(2);
  });

  it("clear() drops the word index with the binding", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT);
    highlighter.bind("s1", scope, "en");
    highlighter.clear("s1");

    highlighter.show("s1", 0, 0, { begin: 14, end: 19 });
    expect(state.applied).toBe(0); // binding gone — no highlight applied
  });
});