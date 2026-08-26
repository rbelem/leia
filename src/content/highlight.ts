/**
 * Marching highlight via the CSS Custom Highlight API (platform floor:
 * Chrome ≥ 105 / Firefox ≥ 140, docs/platform-floor.md). One Highlight
 * registration owns the current chunk's ranges — ≤ 3 ranges (chunks cap at
 * 3 sentences) — and no page DOM is mutated for highlighting. The one
 * <style> element injected by the content script carries the ::highlight
 * rule (extension stylesheet, not page content).
 */
export const HIGHLIGHT_NAME = "leia-marching";

const MAX_RANGES = 3;

function highlights(): HighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  return CSS.highlights;
}

/** Highlight the given sentence ranges (must be ≤ MAX_RANGES). */
export function setHighlight(ranges: Range[]): void {
  const reg = highlights();
  if (!reg) return; // floor browsers all have it; jsdom/tests don't
  const trimmed = ranges.slice(0, MAX_RANGES);
  const highlight = new Highlight(...trimmed);
  reg.set(HIGHLIGHT_NAME, highlight);
}

export function clearHighlight(): void {
  const reg = highlights();
  if (reg) reg.delete(HIGHLIGHT_NAME);
}

/** One-time: inject the ::highlight rule into the page (idempotent). */
export function ensureHighlightStyle(doc: Document): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (doc.getElementById("leia-highlight-style")) return;
  const style = doc.createElement("style");
  style.id = "leia-highlight-style";
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background: rgba(250, 204, 21, 0.55); color: inherit; }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}