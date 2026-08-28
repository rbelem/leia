// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { pageInfoFromDocument } from "../src/content/page-info";

// Proves the jsdom environment is usable for headless content-script logic.
describe("page info (content-script scoped, jsdom)", () => {
  it("reads title, url, lang and text length from the document", () => {
    document.title = "Sample page";
    document.documentElement.lang = "pt-BR";
    document.body.innerHTML = "<p>Hello leia</p>";

    const info = pageInfoFromDocument(document);
    expect(info.title).toBe("Sample page");
    expect(info.url).toBe("https://example.test/");
    expect(info.lang).toBe("pt-BR");
    expect(info.textLength).toBe(10); // "Hello leia"
  });

  it("handles a document without a body", () => {
    document.body.remove();
    const info = pageInfoFromDocument(document);
    expect(info.textLength).toBe(0);
  });
});