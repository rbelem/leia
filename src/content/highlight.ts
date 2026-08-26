/**
 * Marching highlight via the CSS Custom Highlight API (platform floor:
 * Chrome ≥ 105 / Firefox ≥ 140, docs/platform-floor.md). One Highlight
 * registration owns the current chunk's ranges — ≤ 3 ranges (chunks cap at
 * 3 sentences) — and no page DOM is mutated for highlighting. The one
 * <style> element injected by the content script carries the ::highlight
 * rule (extension stylesheet, not page content).
 *
 * The look comes from the theme layer (./themes.ts): the active theme's
 * variant is picked against the page background under the highlight and the
 * injected rule is rewritten in place — the ::highlight pseudo picks up the
 * new rule live, no Highlight re-registration needed, so theme swaps are
 * instant. setHighlight re-samples on every move, so the marching highlight
 * adapts as it crosses sections with different backgrounds (code blocks,
 * callouts).
 */
import {
  ACTIVE_THEME,
  THEMES,
  composite,
  parseColor,
  pickVariant,
  type Rgb,
  type ThemeId,
  type Variant,
} from "./themes";

export const HIGHLIGHT_NAME = "leia-marching";
const STYLE_ID = "leia-highlight-style";

const MAX_RANGES = 3;
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

let activeTheme: ThemeId = ACTIVE_THEME;
let currentRanges: Range[] = [];
let styleDoc: Document | null = null;

export function getTheme(): ThemeId {
  return activeTheme;
}

/** Swap the active theme; the current highlight re-styles instantly. */
export function setTheme(id: ThemeId): void {
  activeTheme = id;
  applyStyle();
}

/** Pick the active theme's variant against the highlight's current ground. */
export function pickVariantForCurrent(theme: ThemeId = activeTheme): Variant {
  return pickVariant(THEMES[theme], sampleBackground());
}

function highlights(): HighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  return CSS.highlights;
}

/** Highlight the given sentence ranges (must be ≤ MAX_RANGES). */
export function setHighlight(ranges: Range[]): void {
  currentRanges = ranges.slice(0, MAX_RANGES);
  const reg = highlights();
  if (reg) reg.set(HIGHLIGHT_NAME, new Highlight(...currentRanges));
  applyStyle(); // re-adapt: the highlight may have marched onto a new ground
}

export function clearHighlight(): void {
  currentRanges = [];
  const reg = highlights();
  if (reg) reg.delete(HIGHLIGHT_NAME);
}

/** One style element, extension-owned; the rule is (re)written per theme. */
export function ensureHighlightStyle(doc: Document): void {
  styleDoc = doc;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  applyStyle();
}

/** Effective page background under the highlight (walks up to first opaque). */
function sampleBackground(): Rgb {
  let el: Element | null = null;
  if (currentRanges.length > 0) {
    const node = currentRanges[0].commonAncestorContainer;
    el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  }
  if (!el) el = styleDoc?.body ?? styleDoc?.documentElement ?? null;
  const view = styleDoc?.defaultView;
  while (el && view) {
    const rgba = parseColor(view.getComputedStyle(el).backgroundColor);
    // ponytail: translucent page layers composite over white, ignoring
    // whatever is beneath them — good enough, true page compositing if needed
    if (rgba && rgba.a > 0) return composite(rgba, WHITE);
    el = el.parentElement;
  }
  return WHITE;
}

function ruleFor(v: Variant): string {
  const props: string[] = [];
  if (v.background) props.push(`background-color: ${v.background}`);
  if (v.color) props.push(`color: ${v.color}`);
  if (v.textDecoration) props.push(`text-decoration: ${v.textDecoration}`);
  return `::highlight(${HIGHLIGHT_NAME}) { ${props.join("; ")}; }`;
}

function applyStyle(): void {
  const style = styleDoc?.getElementById(STYLE_ID);
  if (!style) return;
  style.textContent = ruleFor(pickVariantForCurrent());
}
