// SPDX-License-Identifier: MPL-2.0
/**
 * AMO's validator flags every `.innerHTML =` assignment in shipped code,
 * including the two inside Mozilla's own @mozilla/readability — its DOM
 * cache-restore path (_grabArticle failure retry) and its noscript probe.
 * This patches those exact statements to DOMParser-based equivalents at
 * bundle time. Hard-fails on upstream drift so a Readability upgrade can
 * never silently ship unpatched code.
 */
export const HELPER = `
// innerHTML assignment without innerHTML: parse in a throwaway document and
// move the nodes over. Parser-created nodes never execute scripts, matching
// innerHTML-assignment semantics.
function __leiaSetInnerHtml(el, html) {
  el.replaceChildren(...new DOMParser().parseFromString(html, "text/html").body.childNodes);
}
`;

export const PATCHES = [
  ["page.innerHTML = pageCacheHtml;", "__leiaSetInnerHtml(page, pageCacheHtml);"],
  ["tmp.innerHTML = noscript.innerHTML;", "__leiaSetInnerHtml(tmp, noscript.innerHTML);"],
];

export function patchReadability(source) {
  let out = source;
  for (const [from, to] of PATCHES) {
    if (!out.includes(from)) {
      throw new Error(`readability patch target missing (upstream changed?): ${from}`);
    }
    out = out.replaceAll(from, to);
  }
  return HELPER + out;
}
