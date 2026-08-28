// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_THEME,
  THEMES,
  THEME_IDS,
  composite,
  contrastRatio,
  fallbackVariant,
  parseColor,
  pickVariant,
  relativeLuminance,
  type Rgba,
  type Variant,
} from "../src/content/themes";
import {
  ensureHighlightStyle,
  getTheme,
  setHighlight,
  setTheme,
} from "../src/content/highlight";

const rgb = (s: string): Rgba => {
  const c = parseColor(s);
  if (!c) throw new Error(`unparseable color: ${s}`);
  return c;
};

/** WCAG ratio of a picked variant, honestly composited over the page bg. */
const effectiveRatio = (v: Pick<Variant, "background" | "color">, pageBg: string): number => {
  if (!v.color) throw new Error("fallback variant has no ink to measure");
  const page = rgb(pageBg);
  const ground = v.background ? composite(rgb(v.background), page) : page;
  return contrastRatio(rgb(v.color), ground);
};

const LIGHT_PAGES = ["#ffffff", "#f5f5f5", "#fdf6e3"];
const DARK_PAGES = ["#111111", "#1e1e2e", "#000000"];

describe("WCAG contrast math", () => {
  it("computes the canonical 21:1 for black on white", () => {
    expect(contrastRatio(rgb("#000000"), rgb("#ffffff"))).toBeCloseTo(21, 5);
    expect(relativeLuminance(rgb("#ffffff"))).toBeCloseTo(1, 5);
    expect(relativeLuminance(rgb("#000000"))).toBe(0);
  });

  it("parses hex / rgb / rgba and rejects junk", () => {
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("rgb(30, 30, 46)")).toEqual({ r: 30, g: 30, b: 46, a: 1 });
    expect(parseColor("rgba(250, 204, 21, 0.55)")?.a).toBeCloseTo(0.55);
    expect(parseColor("rebeccapurple")).toBeNull();
    expect(parseColor("")).toBeNull();
  });

  it("composites translucent washes over their ground", () => {
    // 50% black over white → mid-gray
    expect(composite({ r: 0, g: 0, b: 0, a: 0.5 }, rgb("#ffffff"))).toEqual({
      r: 128,
      g: 128,
      b: 128,
    });
  });
});

describe("theme palettes", () => {
  it("ships the five themes with palette data the picker can render", () => {
    expect(THEME_IDS).toEqual(["sun", "ocean", "mint", "berry", "paper"]);
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      expect(theme.label).toBeTruthy();
      expect(theme.variants.length).toBeGreaterThanOrEqual(2);
      for (const v of theme.variants) {
        if (v.background) expect(parseColor(v.background), v.background).not.toBeNull();
        if (v.color) expect(parseColor(v.color), v.color).not.toBeNull();
      }
    }
    expect(ACTIVE_THEME).toBe("sun");
  });

  it.each(THEME_IDS)("every variant of %s clears AA on its own band", (id) => {
    const theme = THEMES[id];
    for (const v of theme.variants) {
      if (v.band === "light") {
        for (const page of LIGHT_PAGES) expect(effectiveRatio(v, page)).toBeGreaterThanOrEqual(4.5);
      }
      if (v.band === "dark") {
        for (const page of DARK_PAGES) expect(effectiveRatio(v, page)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEME_IDS)("pickVariant(%s) returns a ≥4.5:1 variant on light and dark pages", (id) => {
    for (const page of [...LIGHT_PAGES, ...DARK_PAGES]) {
      const v = pickVariant(THEMES[id], page);
      expect(v.color, `${id} on ${page} should not fall back`).toBeTruthy();
      expect(effectiveRatio(v, page)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("picks the band-appropriate variant, not just any passing one", () => {
    expect(pickVariant(THEMES.sun, "#ffffff").band).toBe("light");
    expect(pickVariant(THEMES.sun, "#000000").band).toBe("dark");
  });

  it("falls back to paper's underline variant when nothing clears AA", () => {
    // #808080 sits in sun's dead zone: light 3.83, dark 3.59 — both fail.
    const v = pickVariant(THEMES.sun, "#808080");
    expect(v).toBe(fallbackVariant());
    expect(v.textDecoration).toBe("underline");
    expect(v.background).toBeUndefined();
    expect(v.color).toBeUndefined(); // page text untouched → always safe
    // paper itself dead-zones on the same gray (light 3.72, dark 2.66).
    expect(pickVariant(THEMES.paper, "#808080")).toBe(fallbackVariant());
  });
});

describe("highlight.ts theme engine (jsdom)", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = "";
    setTheme(ACTIVE_THEME); // reset module state
  });

  const styleRule = (): string => {
    const el = document.getElementById("leia-highlight-style");
    expect(el).not.toBeNull();
    return el!.textContent ?? "";
  };

  const ruleColor = (prop: string): string => {
    const m = new RegExp(`(?:^|[;{]\\s*)${prop}: ([^;]+)`).exec(styleRule());
    expect(m, `${prop} in rule`).not.toBeNull();
    return m![1];
  };

  it("injects one idempotent style element", () => {
    ensureHighlightStyle(document);
    ensureHighlightStyle(document);
    expect(document.querySelectorAll("#leia-highlight-style")).toHaveLength(1);
  });

  it("adapts the rule to the page background (dark fixture)", () => {
    document.body.style.backgroundColor = "#1e1e2e";
    ensureHighlightStyle(document);
    expect(getTheme()).toBe("sun");
    expect(styleRule()).toContain("color: #ffd98c"); // sun's dark inversion
    expect(effectiveRatio(
      { background: ruleColor("background-color"), color: ruleColor("color") },
      "#1e1e2e",
    )).toBeGreaterThanOrEqual(4.5);
  });

  it("setTheme swaps the injected rule instantly against the current ground", () => {
    document.body.style.backgroundColor = "#ffffff";
    ensureHighlightStyle(document);
    const before = styleRule();
    expect(before).toContain("#573a00"); // sun light ink

    setTheme("berry");
    expect(getTheme()).toBe("berry");
    const after = styleRule();
    expect(after).not.toBe(before);
    expect(after).toContain("color: #6d0f38");
    expect(after).toContain("background-color: rgba(244, 114, 182, 0.34)");
    expect(effectiveRatio(
      { background: ruleColor("background-color"), color: ruleColor("color") },
      "#ffffff",
    )).toBeGreaterThanOrEqual(4.5);
  });

  it("samples the highlight's own ancestor, not just <body>", () => {
    document.body.innerHTML =
      '<main style="background-color: #111111"><p id="s">Um trecho escuro.</p></main>';
    ensureHighlightStyle(document); // body is still white → sun light rule
    expect(styleRule()).toContain("#573a00");

    const p = document.getElementById("s")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    setHighlight([range]); // jsdom has no CSS.highlights; ranges still tracked
    expect(styleRule()).toMatch(/leia-sentence[^}]*#ffd98c/); // re-sampled: dark ground
  });

  it("writes the underline fallback rule on a dead-zone background", () => {
    document.body.style.backgroundColor = "#808080";
    ensureHighlightStyle(document);
    const rule = styleRule();
    expect(rule).toMatch(/::highlight\(leia-sentence\)[^}]*text-decoration: underline/);
    expect(rule).not.toContain("background-color");
    // The word layer always carries its emphasis, independent of the theme wash.
    expect(rule).toContain("::highlight(leia-word)");
  });
});
