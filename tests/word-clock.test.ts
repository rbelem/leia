// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { createWordClock } from "../src/content/word-clock";
import type { WordTimeline } from "../src/reader/contract";

/** Manual clock + frame queue: tests drive both explicitly. One pumpFrame()
 * = one animation frame (rAF fires the queued callback; the next frame's
 * callback is queued by that step, mirroring real rAF semantics). */
function harness() {
  let now = 1_000;
  const frames: Array<() => void> = [];
  let framesScheduled = 0;
  const schedule = (cb: () => void): (() => void) => {
    framesScheduled += 1;
    frames.push(cb);
    return () => {
      const i = frames.indexOf(cb);
      if (i >= 0) frames.splice(i, 1);
    };
  };
  const pumpFrame = (): void => {
    frames.shift()?.();
  };
  return {
    now: (): number => now,
    schedule,
    pumpFrame,
    get framesScheduled(): number {
      return framesScheduled;
    },
    get pending(): number {
      return frames.length;
    },
    advance(ms: number): void {
      now += ms;
    },
  };
}

const tl = (ts: Array<[begin: number, end: number, t: number]>, anchorWall = 1_000, anchorClock = 0): WordTimeline => ({
  words: ts.map(([begin, end, t]) => ({ begin, end, t })),
  anchorWall,
  anchorClock,
});

describe("createWordClock", () => {
  it("applies words exactly at their wall-mapped instants, in order", () => {
    const h = harness();
    const applied: Array<{ begin: number; end: number }> = [];
    const clock = createWordClock({ apply: (w) => applied.push(w), now: h.now, schedule: h.schedule });

    // anchor: wall 1000 ↔ clock 0; words at t 0 / 200 / 500 → wall 1000/1200/1500
    clock.set(tl([[0, 5, 0], [6, 12, 200], [13, 20, 500]]));

    h.advance(0);
    h.pumpFrame();
    expect(applied).toEqual([{ begin: 0, end: 5 }]); // t=0 is due now

    h.advance(199);
    h.pumpFrame();
    expect(applied).toHaveLength(1); // not yet

    h.advance(1); // wall 1200 → second word due
    h.pumpFrame();
    expect(applied).toEqual([{ begin: 0, end: 5 }, { begin: 6, end: 12 }]);

    h.advance(300); // wall 1500 → third word due
    h.pumpFrame();
    expect(applied.map((w) => w.begin)).toEqual([0, 6, 13]);
    expect(h.pending).toBe(0); // exhausted — no more frames scheduled
  });

  it("catches up words whose mapped instant already passed (late anchor)", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({ apply: (w) => applied.push(w.begin), now: h.now, schedule: h.schedule });

    // Anchor 5s in the past, clock 0: all three words are immediately due.
    h.advance(5_000);
    clock.set(tl([[0, 1, 0], [2, 3, 100], [4, 5, 200]]));
    h.pumpFrame();
    expect(applied).toEqual([0, 2, 4]);
  });

  it("stop() halts the march; later set() re-arms from the new timeline", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({ apply: (w) => applied.push(w.begin), now: h.now, schedule: h.schedule });

    clock.set(tl([[0, 1, 0], [2, 3, 10_000]]));
    clock.stop();
    h.advance(60_000);
    h.pumpFrame();
    expect(applied).toEqual([]); // stopped before any frame ran

    clock.set(tl([[7, 8, 0]]));
    h.pumpFrame();
    expect(applied).toEqual([7]);
  });

  it("set() replaces a running timeline and resets the index", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({ apply: (w) => applied.push(w.begin), now: h.now, schedule: h.schedule });

    clock.set(tl([[0, 1, 0], [2, 3, 100]]));
    h.advance(0);
    h.pumpFrame(); // first word of chunk A
    clock.set(tl([[50, 60, 0], [61, 70, 100]])); // chunk B mid-flight
    h.pumpFrame();
    expect(applied).toEqual([0, 50]); // restarts from B's first word, not B's second
  });

  it("honors a non-zero anchorClock (anchor mid-stream)", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({ apply: (w) => applied.push(w.begin), now: h.now, schedule: h.schedule });

    // anchor: wall 1000 ↔ clock 500 → word at t=600 due at wall 1100
    clock.set(tl([[0, 1, 500], [2, 3, 600]], 1_000, 500));
    h.advance(99); // wall 1099
    h.pumpFrame();
    expect(applied).toEqual([0]); // t=500 == anchorClock: due now; t=600 not yet
    h.advance(1);
    h.pumpFrame();
    expect(applied).toEqual([0, 2]);
  });

  it("resample() re-anchors to a live media-clock reading", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({ apply: (w) => applied.push(w.begin), now: h.now, schedule: h.schedule });

    // Stale anchor: timeline claims wall 1000 ↔ clock 0, but the audio is
    // actually at clock 9000 when wall reads 11000. The set-time model
    // over-runs (applies t=9500 early); the first poll then rewinds.
    h.advance(10_000);
    clock.set(tl([[0, 1, 0], [2, 3, 9500], [4, 5, 12_000]]));
    h.pumpFrame();
    expect(applied).toEqual([0, 2]); // over-run: model clock 10000 at set

    clock.resample(9_000); // live bg sample: media clock 9000 ↔ wall 11000
    h.advance(500); // extrapolated clock 9500
    h.pumpFrame();
    expect(applied).toEqual([0, 2, 2]); // rewind re-applied the not-yet-spoken word

    h.advance(2_500); // extrapolated clock 12000
    h.pumpFrame();
    expect(applied).toEqual([0, 2, 2, 4]);
  });

  it("resample() rewinds an over-run sweep back to the voice's real position", () => {
    const h = harness();
    const applied: Array<{ begin: number; end: number }> = [];
    const clock = createWordClock({ apply: (w) => applied.push(w), now: h.now, schedule: h.schedule });

    // Stale anchor: the model says clock advances from wall 1000, but the
    // audio element actually started much later — the first sweep bursts
    // through the entire timeline before the voice gets there.
    h.advance(0);
    clock.set(tl([[0, 1, 0], [2, 3, 300], [4, 5, 600]]));
    h.advance(600);
    h.pumpFrame();
    expect(applied.map((w) => w.begin)).toEqual([0, 2, 4]);

    // The poll then reports the audio only just started (clock 0).
    clock.resample(0);
    expect(applied).toHaveLength(3); // no immediate re-apply on resample

    h.advance(300); // real voice reaches t=300
    h.pumpFrame();
    expect(applied.map((w) => w.begin)).toEqual([0, 2, 4, 2]);

    h.advance(300); // t=600
    h.pumpFrame();
    expect(applied.map((w) => w.begin)).toEqual([0, 2, 4, 2, 4]);
  });

  it("leadMs applies words early by a constant calibration offset", () => {
    const h = harness();
    const applied: number[] = [];
    const clock = createWordClock({
      apply: (w) => applied.push(w.begin),
      now: h.now,
      schedule: h.schedule,
      leadMs: 500,
    });

    // anchor: wall 1000 ↔ clock 0; words at t 0 / 1000 / 1400
    clock.set(tl([[0, 1, 0], [2, 3, 1000], [4, 5, 1400]]));

    h.advance(0); // clockNow 0 → t=0 due
    h.pumpFrame();
    expect(applied).toEqual([0]);

    h.advance(400); // clockNow 400 → t=1000 needs clock ≥ 500
    h.pumpFrame();
    expect(applied).toEqual([0]);

    h.advance(100); // clockNow 500 → t=1000 − 500 = 500: due
    h.pumpFrame();
    expect(applied).toEqual([0, 2]);

    h.advance(400); // clockNow 900 → t=1400 − 500 = 900: due
    h.pumpFrame();
    expect(applied).toEqual([0, 2, 4]);
  });

  it("schedules at most one frame per rAF tick (bounded scheduling)", () => {
    const h = harness();
    const clock = createWordClock({ apply: () => {}, now: h.now, schedule: h.schedule });
    clock.set(tl([[0, 1, 0], [2, 3, 100], [4, 5, 200]]));
    h.pumpFrame();
    h.pumpFrame();
    h.pumpFrame();
    expect(h.framesScheduled).toBeLessThanOrEqual(4); // set + ≤1 reschedule per frame
  });
});
