// SPDX-License-Identifier: MPL-2.0
// Regression: on the live UOL "Caso Master" DOM, captureScopeDetailed did
// not open on the headline. The title extension built ONE merged range
// (title start → body-root end); the index walk then starts at the two
// boundaries' common ancestor and emits every visible text around them —
// the page opened with the "Política" section eyebrow instead of the h1,
// followed by byline and sibling-chunk junk. The fixture is the live DOM
// (scripts/iframes/links stripped) dumped via CDP from the real page.
import { beforeEach, describe, expect, it } from "vitest";
import { captureScopeDetailed } from "../src/content/scope";
import fixtureHtml from "./fixtures/uol-title-cover.html?raw";

const H1 = "Caso Master: Fachin pede explicações a Moraes, Mendonça, Gonet e Andrei";

function loadFixture(): void {
  const parsed = new DOMParser().parseFromString(fixtureHtml, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

describe("article scope on the live UOL title-cover DOM (fixtures/uol-title-cover)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the scope on the h1 headline (heading flag, no eyebrow first)", () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    expect(scope).not.toBeNull();
    const tokens = scope!.tokens;
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens[0]!.text).toBe(H1);
    expect(tokens[0]!.heading).toBe(true);
    // The section eyebrow sits above the headline — page chrome, never the
    // scope opener.
    expect(tokens[0]!.text).not.toBe("Política");
  });

  it("reads title + article body without the page furniture around them", () => {
    loadFixture();
    const { scope } = captureScopeDetailed(window);
    const text = scope!.tokens.map((t) => t.text).join(" ");
    // Article body (Readability's extraction lives in the cover root).
    expect(text).toContain("Fachin fala em analisar futuramente");
    // Between-junk excluded: eyebrow link, byline, related-content heading.
    expect(text).not.toContain("Cézar Feitoza");
    expect(text).not.toContain("O que aconteceu");
  });

  it("keeps the token round-trip invariant across the title/body segments", () => {
    loadFixture();
    const { scope } = captureScopeDetailed(window);
    expect(scope!.tokens.length).toBeGreaterThan(5);
    for (const [i, token] of scope!.tokens.entries()) {
      expect(token.text).toBe(scope!.ranges[i].toString());
    }
    // The title is a separate segment; the body tokens start right after it.
    expect(scope!.bodyFrom).toBe(1);
    expect(scope!.ranges.length).toBe(scope!.tokens.length);
  });
});
