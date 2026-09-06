// SPDX-License-Identifier: MPL-2.0
/**
 * Inline SVG media-control icons shared by the popup and the floating bar.
 * The old Unicode glyphs (⏮ ▶ ⏹ …) tofu out on systems without font
 * coverage for the Miscellaneous Technical block; these render identically
 * everywhere. All icons are 24×24, currentColor, 1em square so they track
 * the button's font metrics. popup.html is static markup — it inlines the
 * same strings by hand (no build step).
 */
import type { ReaderState } from "./reader/session";
import { playLabel } from "./controls";

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;

/** Filled triangle / two bars: instant play/pause recognition. */
const PLAY_PATH = '<path d="M8 5v14l11-7z"/>';
const PAUSE_PATHS = '<path d="M7 5h4v14H7z"/><path d="M13 5h4v14h-4z"/>';

export const ICON_PLAY = svg(PLAY_PATH);
export const ICON_PAUSE = svg(PAUSE_PATHS);
/** Skip-to-start / skip-to-end: bar on the side you land on. */
export const ICON_BACK = svg('<path d="M6 5h2.5v14H6z"/><path d="M19 5v14L9.5 12z"/>');
export const ICON_FWD = svg('<path d="M15.5 5H18v14h-2.5z"/><path d="M5 5v14L14.5 12z"/>');
/** Stop: rounded square. */
export const ICON_STOP = svg('<rect x="6" y="6" width="12" height="12" rx="2"/>');
/** Close: stroked X (a filled X reads too heavy at 1em). */
export const ICON_CLOSE = svg(
  '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
);

/**
 * Set a Play/Pause button's content for `state`: a persistent <svg> whose
 * paths swap (triangle ↔ bars) plus a .play-label word span. State changes
 * rewrite those two nodes only, never the whole button; the structure is
 * (re)built when missing — e.g. after the loading spinner wiped it.
 */
export function setPlayState(button: HTMLElement, state: ReaderState): void {
  const playing = state === "playing";
  const span = button.querySelector<HTMLSpanElement>("span.play-label");
  if (span) {
    const icon = button.querySelector("svg");
    if (icon) icon.innerHTML = playing ? PAUSE_PATHS : PLAY_PATH;
    else button.insertAdjacentHTML("afterbegin", svg(playing ? PAUSE_PATHS : PLAY_PATH));
    span.textContent = playLabel(state);
  } else {
    button.innerHTML = `${svg(playing ? PAUSE_PATHS : PLAY_PATH)}<span class="play-label">${playLabel(state)}</span>`;
  }
}
