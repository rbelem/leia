// SPDX-License-Identifier: MPL-2.0
// Regression: on a real UOL article the article fallback picked a deeply
// nested <style> element (its CSS textContent won the length-vs-depth
// covering heuristic), so tokenIndexFromRange saw zero text and capture
// died with "extracted article produced no readable tokens". The fixture
// is the live DOM (script/link/svg/iframes stripped, <style> kept — it is
// the trigger) dumped via CDP from the real page.
import { beforeEach, describe, expect, it } from "vitest";
import { captureScopeDetailed } from "../src/content/scope";
import fixtureHtml from "./fixtures/uol-fachin.html?raw";

function loadFixture(): void {
  const parsed = new DOMParser().parseFromString(fixtureHtml, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

/** Indexes i where tokens[i] repeats tokens[i-1] verbatim (adjacent echo). */
function adjacentDuplicateIndexes(tokens: Array<{ text: string }>): number[] {
  const dupes: number[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].text === tokens[i - 1].text) dupes.push(i);
  }
  return dupes;
}

/** Every token text that appears more than once, with its positions. */
function repeatedTextReport(tokens: Array<{ text: string }>): Array<{ text: string; positions: number[] }> {
  const byText = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    const at = byText.get(t.text) ?? [];
    at.push(i);
    byText.set(t.text, at);
  });
  return [...byText.entries()]
    .filter(([, at]) => at.length > 1)
    .map(([text, at]) => ({ text, positions: at }));
}

/** True when every repeat position is consecutive (natural adjacency only). */
function onlyAdjacentRepeats(positions: number[]): boolean {
  return positions.every((p, j) => j === 0 || p === positions[j - 1] + 1);
}

describe("article scope on a real UOL article (fixtures/uol-fachin)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures article tokens, not header chrome or stylesheet text", () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    expect(scope).not.toBeNull();
    expect(scope!.tokens.length).toBeGreaterThan(0);
    const text = scope!.tokens.map((t) => t.text).join(" ");
    // Known sentence from the article body.
    expect(text).toContain("ex-banqueiro Daniel Vorcaro");
    // Header menu labels must never become the reading scope.
    expect(text).not.toContain("Home UOL");
  });

  it("captured token list contains no identical adjacent repeats (capture dedupe)", () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    expect(scope).not.toBeNull();
    const tokens = scope!.tokens;
    expect(tokens.length).toBeGreaterThan(0);

    // Hard regression: the same sentence token must never appear twice in a
    // row (overlapping-range capture would read it twice back to back).
    const adjacent = adjacentDuplicateIndexes(tokens);
    expect(adjacent).toEqual([]);

    // Report only: non-adjacent echoes are usually natural prose repetition.
    const echoes = repeatedTextReport(tokens).filter((r) => !onlyAdjacentRepeats(r.positions));
    console.info(
      `[capture-dedupe] uol-fachin.html: ${tokens.length} tokens, ` +
        `${echoes.length} text(s) repeat at non-adjacent positions ` +
        `(reported, not asserted):`,
      echoes.slice(0, 10).map((r) => ({ text: r.text.slice(0, 60), positions: r.positions })),
    );
  });

  it("never captures hidden-block text (menus / notifications stay silent)", () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    const text = scope!.tokens.map((t) => t.text).join(" ");
    // display:none notification block ("Seu time / Seu signo") and the
    // hidden mega-menu ("Home UOL") must never enter the reading scope.
    expect(text).not.toContain("Seu time");
    expect(text).not.toContain("Seu signo");
    expect(text).not.toContain("Home UOL");
  });

  it("captures each heading echo exactly once (leading-prefix body echo)", () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    const text = scope!.tokens.map((t) => t.text).join("");
    // The <h2>Moraes acusa Mendonça</h2> heading is repeated verbatim as the
    // first words of a later paragraph; the echo prefix must be cut so the
    // title is spoken once.
    expect(text.split("Moraes acusa Mendonça")).toHaveLength(2); // 1 occurrence
    // The body block keeps only the remainder after the echoed prefix.
    const remainder = scope!.tokens.find((t) => t.text.startsWith(" de quebrar a imparcialidade judicial"));
    expect(remainder).toBeDefined();
  });
});
