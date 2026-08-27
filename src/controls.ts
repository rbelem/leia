/**
 * Shared playback-control helpers for the floating bar and the popup.
 * Pure functions — unit-tested in tests/controls.test.ts.
 */
import type { ReaderState, SessionStatus } from "./reader/session";

/** storage.local flag: the in-page bar is opt-in — present-and-true shows it. */
export const CONTROLS_IN_PAGE_KEY = "leia:controls-in-page";

/** Hidden by default: only an explicit true (popup "Open controls in page") mounts the bar. */
export function controlsInPage(value: unknown): boolean {
  return value === true;
}

export type PlayAction = "start" | "resume" | "pause";

/** One Play button: stopped starts a fresh read, paused resumes, playing pauses. */
export function playAction(state: ReaderState): PlayAction {
  return state === "playing" ? "pause" : state === "paused" ? "resume" : "start";
}

export function playLabel(state: ReaderState): string {
  return state === "playing" ? "⏸ Pause" : "▶ Play";
}

/** Failsafe: never leave the Play button spinning, whatever the engine does. */
export const LOADING_TIMEOUT_MS = 30_000;

export type LoadingKind = "starting" | "resuming";

/** Start and resume both cross a silent synthesis gap; pause is instant. */
export function loadingKindForAction(action: PlayAction): LoadingKind | null {
  return action === "start" ? "starting" : action === "resume" ? "resuming" : null;
}

/**
 * Events that can end the Play button's loading state. The truthful
 * "audio started" signal is the first leia:highlight:set — bg flips state
 * to "playing" BEFORE synthesis, so a playing state must NOT clear it.
 */
export type LoadingClearEvent =
  | { type: "highlight" } // first leia:highlight:set for the session
  | { type: "error" } // leia:session:error
  | { type: "state"; state: ReaderState } // leia:session:state
  | { type: "reply"; ok: boolean } // the start/resume command reply
  | { type: "timeout" }; // LOADING_TIMEOUT_MS failsafe

export function shouldClearLoading(ev: LoadingClearEvent): boolean {
  if (ev.type === "state") return ev.state === "stopped";
  if (ev.type === "reply") return !ev.ok;
  return true;
}

export function prevToken(pos: number): number {
  return Math.max(0, pos - 1);
}

export function nextToken(pos: number, count: number): number {
  return Math.min(Math.max(count - 1, 0), pos + 1);
}

export function canSeekBack(s: Pick<SessionStatus, "state" | "tokenPos">): boolean {
  return s.state !== "stopped" && s.tokenPos > 0;
}

export function canSeekForward(s: Pick<SessionStatus, "state" | "tokenPos" | "tokenCount">): boolean {
  return s.state !== "stopped" && s.tokenCount > 0 && s.tokenPos < s.tokenCount - 1;
}

/** Clamp a dragged bar's top-left corner into the viewport. */
export function clampBarPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, viewportWidth - width)),
    y: Math.min(Math.max(0, y), Math.max(0, viewportHeight - height)),
  };
}
