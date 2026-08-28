// SPDX-License-Identifier: MPL-2.0
/** Page facts the content script exposes to the rest of the extension. */
export interface PageInfo {
  title: string;
  url: string;
  lang: string | null;
  textLength: number;
}

/** Pure DOM extraction — runs headlessly in the test harness (jsdom). */
export function pageInfoFromDocument(doc: Document): PageInfo {
  return {
    title: doc.title,
    url: doc.URL,
    lang: doc.documentElement.lang || null,
    // innerText is the readable text in browsers; jsdom lacks it, so fall back.
textLength: (doc.body?.innerText ?? doc.body?.textContent ?? "").length,
  };
}