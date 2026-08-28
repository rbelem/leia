// SPDX-License-Identifier: MPL-2.0
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

  it("highlights the word within the whole-paragraph wash on word events", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT); // one <p> → one block, two sentence tokens
    highlighter.bind("s1", scope, "en");

    // Chunk [0..0] speaks the first sentence; the wash covers the WHOLE
    // paragraph and the word layer marches inside it.
    highlighter.show("s1", 0, 0, { begin: 14, end: 19 });
    expect(state.applied).toBe(2); // wash + word layers
    expect(state.last.map((r) => r.toString()).join("")).toBe(TEXT);
    expect(state.wordLast?.[0]?.toString()).toBe("reads");

    // Second utterance, same paragraph: wash stays whole-paragraph.
    highlighter.show("s1", 1, 1, { begin: 0, end: 5 });
    expect(state.last.map((r) => r.toString()).join("")).toBe(TEXT);
    expect(state.wordLast?.[0]?.toString()).toBe("Hello");
  });

  it("word layer keeps the previous underline when the offset maps between words (whitespace)", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope(TEXT);
    highlighter.bind("s1", scope, "en");

    // A real word first, so the layer holds an underline.
    highlighter.show("s1", 0, 1, { begin: 0, end: 3 });
    expect(state.wordLast?.[0]?.toString()).toBe("The");

    // Offset 3 is the space after "The" — inside no word span (subtitle
    // gap entry): the previous underline stays instead of flickering off.
    highlighter.show("s1", 0, 1, { begin: 3, end: 3 });
    expect(state.deleted).not.toContain("leia-word");
    expect(state.wordLast?.[0]?.toString()).toBe("The");
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
    expect(state.wordLast).toBeNull(); // no map → no word layer
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

describe("block-structured reading units (paragraphs / headings / cells)", () => {
  /** Two blocks, second with two sentences: [P1][P2a P2b] over h1+p. */
  function twoBlockScope(): { scope: CapturedScope; texts: string[] } {
    document.body.innerHTML = "<div><p id='a'>First para here.</p><h1 id='b'>Big Title</h1>" +
      "<p id='c'>Second body speaks now. More words follow.</p></div>";
    const div = document.getElementById("a")!.parentElement!;
    const range = document.createRange();
    range.selectNodeContents(div);
    const tokens = tokenIndexFromRange(range);
    if (tokens.length === 0) throw new Error("fixture must tokenize");
    return {
      scope: { tokens, ranges: tokens.map((t) => t.range) },
      texts: tokens.map((t) => t.text),
    };
  }

  it("capture stamps blockStart on paragraph/heading boundaries and heading flags", () => {
    const { scope, texts } = twoBlockScope();
    // Token plan: "First para here. " | "Big Title" (heading) | body ×2.
    expect(texts).toHaveLength(4);
    expect(scope.tokens[0].blockStart).toBe(true); // first token always anchors a block
    expect(scope.tokens[1].heading).toBe(true); // <h1> differs from <p>
    expect(scope.tokens[2].blockStart).toBe(true); // p after h1
    expect(scope.tokens[3].blockStart).toBeUndefined(); // same paragraph continues
  });

  it("the wash covers the whole block while only part of it is spoken", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const { scope } = twoBlockScope();
    highlighter.bind("s1", scope);

    // Chunk = sentence token 2 only; wash must span tokens 2..3 (its paragraph).
    highlighter.show("s1", 2, 2);
    expect(state.last).toHaveLength(2);
    expect(state.last.map((r) => r.toString()).join("")).toBe(
      "Second body speaks now. More words follow.",
    );
  });

  it("the heading highlights alone; its paragraph never bleeds into it", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const { scope } = twoBlockScope();
    highlighter.bind("s1", scope);

    highlighter.show("s1", 1, 1);
    expect(state.last).toHaveLength(1);
    expect(state.last[0].toString()).toBe("Big Title");
  });

  it("scopes without block flags keep tight chunk-sized washes (old sessions)", () => {
    const state = installCaptureShim();
    const highlighter = new ScopeHighlighter();
    const scope = textScope("Alpha sentence. Beta sentence.");
    for (const t of scope.tokens) delete t.blockStart; // simulate pre-block capture
    highlighter.bind("s1", scope);

    highlighter.show("s1", 1, 1);
    expect(state.last).toHaveLength(1);
    expect(state.last[0].toString()).toBe("Beta sentence.");
  });
});