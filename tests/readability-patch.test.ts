import { describe, expect, it } from "vitest";
import { HELPER, patchReadability } from "../scripts/readability-patch.mjs";
import installed from "../node_modules/@mozilla/readability/Readability.js?raw";

describe("readability innerHTML patch", () => {
  it("replaces both flagged assignments in the installed Readability", () => {
    const patched = patchReadability(installed);
    expect(patched).toContain("__leiaSetInnerHtml(page, pageCacheHtml);");
    expect(patched).toContain("__leiaSetInnerHtml(tmp, noscript.innerHTML);");
    expect(patched).not.toContain("page.innerHTML = pageCacheHtml;");
    expect(patched).not.toContain("tmp.innerHTML = noscript.innerHTML;");
  });

  it("fails loudly if upstream drops a patch target", () => {
    expect(() => patchReadability("var x = 1;")).toThrow(/patch target missing/);
  });

  it("helper behaves like innerHTML assignment (replace + restore)", () => {
    const setInnerHtml = new Function(
      "el",
      "html",
      `${HELPER}; return __leiaSetInnerHtml(el, html);`,
    );
    const el = document.createElement("div");
    el.append(Object.assign(document.createElement("p"), { textContent: "stale" }));
    setInnerHtml(el, "<p>one</p><b>two</b>");
    expect(el.innerHTML).toBe("<p>one</p><b>two</b>");
  });
});
