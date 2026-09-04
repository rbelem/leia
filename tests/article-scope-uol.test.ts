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
});
