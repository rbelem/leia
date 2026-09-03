// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { captureArticle, captureScope, captureScopeDetailed } from "../src/content/scope";

/** Article with global noise OUTSIDE the article root (nav/aside/footer). */
function articleFixture(): void {
  document.body.innerHTML =
    "<nav><a href='/one'>Global navigation</a><a href='/two'>More global navigation links</a></nav>" +
    "<main id='article'>" +
    "<h1>Reading aloud on the web</h1>" +
    "<p>The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. </p>" +
    "<p>A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. </p>" +
    "</main>" +
    "<aside>Sidebar noise that nobody wants read aloud. Sidebar noise that nobody wants read aloud.</aside>" +
    "<footer>Footer legal text nobody wants to hear.</footer>";
}

describe("article scope capture (T3)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures the article container and covers it end to end", () => {
    articleFixture();
    const scope = captureArticle(window);
    expect(scope).not.toBeNull();
    expect(scope!.tokens.length).toBeGreaterThan(5);
    const text = scope!.tokens.map((t) => t.text).join(" ");
    expect(text).toContain("quick brown fox");
    expect(text).toContain("second paragraph");
    expect(text).not.toContain("Global navigation");
    expect(text).not.toContain("Sidebar noise");
    expect(text).not.toContain("Footer legal");
  });

  it("keeps the token round-trip invariant (token.text === range.toString())", () => {
    articleFixture();
    const scope = captureArticle(window)!;
    for (const [i, token] of scope.tokens.entries()) {
      expect(token.text).toBe(scope.ranges[i].toString());
    }
  });

  it("returns null when the page has no extractable article", () => {
    document.body.innerHTML = "<p>tiny</p>";
    expect(captureArticle(window)).toBeNull();
  });

  it("falls back selection → article → null", () => {
    articleFixture();
    const p1 = document.querySelector("p")!.firstChild as Text;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(p1, 0);
    range.setEnd(p1, Math.min(30, p1.data.length));
    sel.removeAllRanges();
    sel.addRange(range);

    const selected = captureScope(window);
    expect(selected).not.toBeNull();
    expect(selected!.ranges[0].startContainer).toBe(p1); // selection wins
    const selectedTokenCount = selected!.tokens.length;

    sel.removeAllRanges();
    const article = captureScope(window);
    expect(article).not.toBeNull();
    expect(article!.tokens.length).toBeGreaterThan(selectedTokenCount);

    document.body.innerHTML = "<p>tiny</p>";
    expect(captureScope(window)).toBeNull();
  });
});

describe("captureScopeDetailed failure reasons (popup diagnostics)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("gives a null reason on success (article path)", () => {
    articleFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).not.toBeNull();
    expect(reason).toBeNull();
  });

  it("names the article stage when the page is not readable", () => {
    document.body.innerHTML = "<p>tiny</p>";
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("no selection");
    expect(reason).toContain("page is not readable");
  });

  it("names the article stage when Readability extracts nothing", () => {
    // Readable-looking (500+ chars inside <p>) but the extracted article
    // body is empty text: whitespace-only nodes survive readability scoring
    // yet normalize to nothing.
    document.body.innerHTML = `<p>${"&nbsp;".repeat(600)}</p>`;
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("no selection");
  });

  it("names the missing-body stage", () => {
    document.body.remove();
    const { scope, reason } = captureScopeDetailed(window);
    expect(scope).toBeNull();
    expect(reason).toContain("page has no body");
    document.documentElement.appendChild(document.createElement("body")); // restore for beforeEach
  });
});