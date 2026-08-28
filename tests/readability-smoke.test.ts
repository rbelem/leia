// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { Readability, isProbablyReaderable } from "@mozilla/readability";

function fixture(): Document {
  document.body.innerHTML =
    "<nav><a href='/x'>Link one navigation</a><a href='/y'>Link two navigation</a></nav>" +
    "<main id='main'>" +
    "<h1>Fixture article title for the smoke test</h1>" +
    "<p>The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. The quick brown fox jumps over the lazy dog and keeps on reading. </p>" +
    "<script>var x = 1;</script>" +
    "<aside><p>Sidebar noise text that nobody wants read aloud.</p></aside>" +
    "<p>A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. A second paragraph of article prose appears here for the reader. </p>" +
    "</main>";
  return document;
}

describe("readability under jsdom", () => {
  it("readerable gate + candidate extraction", () => {
    const doc = fixture();
    expect(isProbablyReaderable(doc)).toBe(true);

    const cloneDoc = doc.implementation.createHTMLDocument("");
    cloneDoc.body.appendChild(cloneDoc.importNode(doc.getElementById("main")!, true));
    const parsed = new Readability(cloneDoc).parse();
    expect(parsed).not.toBeNull();
    expect(parsed!.textContent).not.toContain("navigation");
    expect(parsed!.textContent).not.toContain("noise");
    console.log("textContent:", JSON.stringify(parsed!.textContent));
  });

  it("returns null for an empty page", () => {
    document.body.innerHTML = "<p>tiny</p>";
    expect(isProbablyReaderable(document)).toBe(false);
  });
});