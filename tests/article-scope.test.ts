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

  it("dedupes a heading echoed as the leading body text (P2, heard-twice fix)", () => {
    document.body.innerHTML =
      "<main id='article'>" +
      "<h1>X</h1>" +
      "<p>X rest of the lead sentence.</p>" +
      // isProbablyReaderable needs one node with sqrt(len-140) > 20.
      `<p>${"Filler sentence for the readability check. ".repeat(14)}</p>` +
      "</main>";
    const scope = captureArticle(window);
    expect(scope).not.toBeNull();
    const joined = scope!.tokens.map((t) => t.text).join("");
    // Echo string appears exactly once — as the heading token itself.
    expect(joined.match(/X/g) ?? []).toHaveLength(1);
    // Every token keeps the round-trip invariant (remainder ranges included).
    for (const [i, token] of scope!.tokens.entries()) {
      expect(token.text).toBe(scope!.ranges[i].toString());
    }
  });

  it("opens the scope with the article title when it sits above the body root (UOL)", () => {
    // UOL pattern: the H1 lives in a separate container far above the body
    // root, with junk between them — the read must open on the headline.
    document.body.innerHTML =
      "<h1>Title here</h1>" +
      "<div>ad junk</div>" +
      "<div><p>Body text here. Second sentence. " +
      // isProbablyReaderable needs one node with sqrt(len-140) > 20.
      `${"Filler sentence for the readability check. ".repeat(14)}</p></div>`;
    const scope = captureArticle(window);
    expect(scope).not.toBeNull();
    expect(scope!.tokens[0]!.text).toBe("Title here");
    expect(scope!.tokens[0]!.heading).toBe(true);
    // The body follows the title, in document order.
    const joined = scope!.tokens.map((t) => t.text).join("");
    expect(joined.indexOf("Body text here")).toBeGreaterThan(0);
    expect(joined.indexOf("Second sentence")).toBeGreaterThan(joined.indexOf("Body text here"));
    // Every token keeps the round-trip invariant (title range included).
    for (const [i, token] of scope!.tokens.entries()) {
      expect(token.text).toBe(scope!.ranges[i].toString());
    }
  });

  it("keeps capture unchanged when no preceding heading exists", () => {
    document.body.innerHTML =
      "<div><p>Body text here. Second sentence. " +
      `${"Filler sentence for the readability check. ".repeat(14)}</p></div>`;
    const scope = captureArticle(window);
    expect(scope).not.toBeNull();
    const joined = scope!.tokens.map((t) => t.text).join("");
    expect(joined).toContain("Body text here");
    expect(joined).not.toContain("Title here");
    expect(joined.indexOf("Body text here")).toBe(0); // body opens the scope
    for (const [i, token] of scope!.tokens.entries()) {
      expect(token.text).toBe(scope!.ranges[i].toString());
    }
  });

  it("keeps a title already inside the root untouched (read once, in place)", () => {
    articleFixture();
    const scope = captureArticle(window)!;
    const joined = scope.tokens.map((t) => t.text).join("");
    // The in-root heading is still the scope's first token, exactly once.
    expect(scope.tokens[0]!.text).toBe("Reading aloud on the web");
    expect(scope.tokens[0]!.heading).toBe(true);
    expect(joined.match(/Reading aloud on the web/gi) ?? []).toHaveLength(1);
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