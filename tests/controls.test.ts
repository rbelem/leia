// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  CONTROLS_IN_PAGE_KEY,
  LOADING_TIMEOUT_MS,
  canSeekBack,
  canSeekForward,
  clampBarPosition,
  controlsInPage,
  loadingKindForAction,
  nextToken,
  playAction,
  playLabel,
  prevToken,
  shouldClearLoading,
} from "../src/controls";

describe("playAction (one Play button)", () => {
  it("maps stopped → start, paused → resume, playing → pause", () => {
    expect(playAction("stopped")).toBe("start");
    expect(playAction("paused")).toBe("resume");
    expect(playAction("playing")).toBe("pause");
  });

  it("labels ⏸ only while playing", () => {
    expect(playLabel("playing")).toBe("⏸ Pause");
    expect(playLabel("paused")).toBe("▶ Play");
    expect(playLabel("stopped")).toBe("▶ Play");
  });
});

describe("sentence skip", () => {
  it("clamps prev/next into [0, tokenCount-1]", () => {
    expect(prevToken(0)).toBe(0);
    expect(prevToken(3)).toBe(2);
    expect(nextToken(1, 3)).toBe(2);
    expect(nextToken(2, 3)).toBe(2); // last sentence
    expect(nextToken(0, 0)).toBe(0); // empty scope
  });

  it("disables seek at bounds and when stopped", () => {
    expect(canSeekBack({ state: "playing", tokenPos: 0 })).toBe(false);
    expect(canSeekBack({ state: "playing", tokenPos: 2 })).toBe(true);
    expect(canSeekBack({ state: "stopped", tokenPos: 2 })).toBe(false);
    expect(canSeekForward({ state: "paused", tokenPos: 1, tokenCount: 3 })).toBe(true);
    expect(canSeekForward({ state: "paused", tokenPos: 2, tokenCount: 3 })).toBe(false);
    expect(canSeekForward({ state: "stopped", tokenPos: 0, tokenCount: 3 })).toBe(false);
    expect(canSeekForward({ state: "playing", tokenPos: 0, tokenCount: 0 })).toBe(false);
  });
});

describe("clampBarPosition", () => {
  it("keeps the bar fully inside the viewport", () => {
    expect(clampBarPosition(50, 60, 200, 40, 800, 600)).toEqual({ x: 50, y: 60 });
    expect(clampBarPosition(-10, -5, 200, 40, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(clampBarPosition(700, 590, 200, 40, 800, 600)).toEqual({ x: 600, y: 560 });
  });

  it("handles a bar larger than the viewport", () => {
    expect(clampBarPosition(10, 10, 900, 700, 800, 600)).toEqual({ x: 0, y: 0 });
  });
});

describe("CONTROLS_IN_PAGE_KEY", () => {
  it("is the shared surface flag", () => {
    expect(CONTROLS_IN_PAGE_KEY).toBe("leia:controls-in-page");
  });

  it("is opt-in: only an explicit true shows the in-page bar", () => {
    expect(controlsInPage(undefined)).toBe(false);
    expect(controlsInPage(false)).toBe(false);
    expect(controlsInPage(true)).toBe(true);
  });
});

describe("Play loading state", () => {
  it("maps actions to loading kinds; pause has none", () => {
    expect(loadingKindForAction("start")).toBe("starting");
    expect(loadingKindForAction("resume")).toBe("resuming");
    expect(loadingKindForAction("pause")).toBeNull();
  });

  it("clears on first highlight (audio began), engine error, and the failsafe timeout", () => {
    expect(shouldClearLoading({ type: "highlight" })).toBe(true);
    expect(shouldClearLoading({ type: "error" })).toBe(true);
    expect(shouldClearLoading({ type: "timeout" })).toBe(true);
  });

  it("clears on a stopped state but never on playing/paused (playing precedes synthesis)", () => {
    expect(shouldClearLoading({ type: "state", state: "stopped" })).toBe(true);
    expect(shouldClearLoading({ type: "state", state: "playing" })).toBe(false);
    expect(shouldClearLoading({ type: "state", state: "paused" })).toBe(false);
  });

  it("clears on a failed command reply only", () => {
    expect(shouldClearLoading({ type: "reply", ok: false })).toBe(true);
    expect(shouldClearLoading({ type: "reply", ok: true })).toBe(false);
  });

  it("failsafe is 30s", () => {
    expect(LOADING_TIMEOUT_MS).toBe(30_000);
  });
});
