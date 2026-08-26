import { beforeEach, describe, expect, it } from "vitest";
import {
  STALE_CHAR_THRESHOLD,
  STALE_NODE_THRESHOLD,
  ScopeHighlighter,
  captureArticle,
  type CapturedScope,
} from "../src/content/scope";

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