// SPDX-License-Identifier: MPL-2.0
// Contract test for the property Chrome's popup sizing depends on.
//
// A shipped bug opened the popup 114px wide: `body.popup` carried `max-width`
// with no `width`, and a browser sizes an extension popup window to the
// document's content width, so the panel collapsed to its narrowest control
// (the voice select, at 18px). jsdom has no layout and cannot see this, and a
// viewport-emulation check cannot either: an emulator SETS the viewport, so a
// width-less body simply fills it. The rule itself is the only cheap
// observable, so this asserts the rule.
//
// Both halves matter. A definite width makes the window open at the designed
// column; the clamp keeps the high-zoom reflow (at a 160px CSS viewport the
// clamp resolves to 160 and nothing strands off-screen).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read from disk, not `?raw`: the CSS pipeline hands a ?raw import to jsdom as
// something other than the stylesheet text, which silently emptied this test.
const css = readFileSync(join(process.cwd(), "src", "ui", "base.css"), "utf8");

/** Declarations of the first `selector { ... }` block, or null. */
function ruleBody(source: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  return match ? match[1] : null;
}

describe("popup width contract", () => {
  it("declares a definite pixel width, which is what sizes the popup window", () => {
    const body = ruleBody(css, "body.popup");
    expect(body, "body.popup rule is missing from base.css").not.toBeNull();
    expect(body!).toMatch(/(?:^|[{;])\s*width:\s*\d+px\s*(?:;|$)/);
  });

  it("clamps that width to the viewport so high zoom still reflows", () => {
    const body = ruleBody(css, "body.popup");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/(?:^|[{;])\s*max-width:\s*(?:100%|100vw)\s*(?:;|$)/);
  });

  it("never ships a max-width-only body, the shape that collapsed", () => {
    const body = ruleBody(css, "body.popup")!;
    const hasDefiniteWidth = /(?:^|[{;])\s*width:\s*\d+px\s*(?:;|$)/.test(body);
    const hasMaxOnly = /(?:^|[{;])\s*max-width:\s*\d+px\s*(?:;|$)/.test(body) && !hasDefiniteWidth;
    expect(hasMaxOnly, "body.popup relies on max-width alone, which sets no width").toBe(false);
  });
});
