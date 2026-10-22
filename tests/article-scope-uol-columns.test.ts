// SPDX-License-Identifier: MPL-2.0
// Regression: on this UOL column page the left rail (related-column author
// cards) lives inside <article> as nested <aside> elements, and no element
// covering Readability's text excludes the rail. The body root therefore
// starts inside the rail, so the read opened with "PVC / Alicia Klein /
// Carlos Affonso / Junior Borneli" before the article body. The fixture is
// the live DOM dumped via CDP from the real page.
import { beforeEach, describe, expect, it } from "vitest";
import { captureScopeDetailed } from "../src/content/scope";
import fixtureHtml from "./fixtures/uol-paula.html?raw";

function loadFixture(): void {
  const parsed = new DOMParser().parseFromString(fixtureHtml, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

/** Rail: related-column cards rendered in the aside next to the article. */
const RAIL_NAMES = ["PVC", "Alicia Klein", "Carlos Affonso", "Junior Borneli"];
/** Body sentence that must survive the capture. */
const BODY_OPEN = "insatisfeito com o carro";

describe("article scope on a UOL column page with a related-content rail", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // The fixture is a full 1 MB live DOM: Readability parse + index is ~1.7 s
  // warm and exceeds the 5 s default under parallel suite load.
  it("reads the article body, not the rail beside it", { timeout: 30_000 }, () => {
    loadFixture();
    const { scope, reason } = captureScopeDetailed(window);
    expect(reason).toBeNull();
    expect(scope).not.toBeNull();
    const text = scope!.tokens.map((t) => t.text).join(" ");
    for (const name of RAIL_NAMES) {
      expect(text).not.toContain(name);
    }
    expect(text).toContain(BODY_OPEN);
  });

  it("still opens on the headline before the body", { timeout: 30_000 }, () => {
    loadFixture();
    const { scope } = captureScopeDetailed(window);
    const first = scope!.tokens[0].text;
    expect(first).toContain("Carros mais baratos");
  });
});
