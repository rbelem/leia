// SPDX-License-Identifier: MPL-2.0
/**
 * Local word-march scheduler for the visible page. The engine ships the
 * chunk timeline once with a best-effort (wall, clock) anchor; this sweeper
 * extrapolates the media clock from that anchor at 1× playback, applies
 * words via rAF, and is re-anchored every ~250ms by a live clock poll
 * (content/index.ts) — so a stale anchor self-corrects within one poll.
 * Visible-tab rAF is unthrottled; hidden background pages clamp timers
 * (1s → 30s), which is why the march cannot run there.
 */
import type { WordTiming, WordTimeline } from "../reader/contract";

export interface WordClockOpts {
  apply: (word: { begin: number; end: number }) => void;
  /** Wall clock; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Frame scheduler; injectable for tests. Default requestAnimationFrame. */
  schedule?: (cb: () => void) => () => void;
  /** Apply each word this many ms before its subtitle timestamp. Calibration
   * for engines whose timestamps trail the audible voice (constant bias). */
  leadMs?: number;
}

export function createWordClock(opts: WordClockOpts) {
  const now = opts.now ?? ((): number => Date.now());
  const lead = opts.leadMs ?? 0;
  const schedule =
    opts.schedule ??
    ((cb: () => void): (() => void) => {
      const id = requestAnimationFrame(() => cb());
      return () => cancelAnimationFrame(id);
    });

  let timeline: WordTimeline | null = null;
  let model = { wall: 0, clock: 0 };
  let i = 0;
  let cancel: (() => void) | null = null;

  const step = (): void => {
    cancel = null;
    if (!timeline) return;
    const clockNow = model.clock + (now() - model.wall);
    while (i < timeline.words.length && clockNow >= timeline.words[i].t - lead) {
      const w: WordTiming = timeline.words[i];
      opts.apply({ begin: w.begin, end: w.end });
      i += 1;
    }
    if (i < timeline.words.length) cancel = schedule(step);
  };

  return {
    /** Arm (or replace) the active timeline; index resets to its first word. */
    set(tl: WordTimeline): void {
      timeline = tl;
      model = { wall: now(), clock: tl.anchorClock + (now() - tl.anchorWall) };
      i = 0;
      if (!cancel) cancel = schedule(step);
    },
    /** Re-anchor from a live media-clock sample (bg poll reply). Also
     * recovers the index from any over-run: a stale anchor can make the
     * sweep exhaust the timeline before the audio reaches those words. */
    resample(clock: number): void {
      model = { wall: now(), clock };
      if (!timeline || timeline.words.length === 0) return;
      while (i > 0 && timeline.words[i - 1].t > clock + lead) i -= 1;
      while (i < timeline.words.length && timeline.words[i].t <= clock + lead) i += 1;
      if (i < timeline.words.length && !cancel) cancel = schedule(step);
    },
    stop(): void {
      timeline = null;
      if (cancel) {
        cancel();
        cancel = null;
      }
    },
  };
}
