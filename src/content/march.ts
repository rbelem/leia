/**
 * Word-march controller shared by both content scripts. The engine ships a
 * whole-chunk timeline once (contract.EngineEvent "timeline"); whichever
 * script owns the bound highlighter arms the visible-tab sweeper here, and
 * a 250ms background media-clock poll re-anchors it. The poll doubles as a
 * keepalive: hidden background pages clamp timers and media events mid-read
 * (chunk-end events arrived minutes late, stalling sessions), while the
 * visible tab's timers run unthrottled and a synchronous currentTime read is
 * always truthful.
 */
import browser from "webextension-polyfill";
import { createWordClock } from "./word-clock";
import type { WordTimeline } from "../reader/contract";

export interface MarchOpts {
  /** Render one spoken word through this script's bound highlighter. */
  apply: (sessionId: string, from: number, to: number, word: { begin: number; end: number }) => void;
  /** Whether this script's highlighter is bound to that session. */
  owns: (sessionId: string) => boolean;
}

export function createMarch(opts: MarchOpts) {
  let active: { sessionId: string; from: number; to: number } | null = null;
  let poll: number | null = null;

  // MiniMax subtitle timestamps trail the audible voice by a constant
  // ~0.3-1s (encoder/padding bias, user-ear-calibrated at 1x on wired
  // output; 500 lagged a little, 700 led a little → 600). Apply each word
  // this much early to land on the spoken word.
  const WORD_LEAD_MS = 600;

  const clock = createWordClock({
    leadMs: WORD_LEAD_MS,
    apply: (word) => {
      if (active) opts.apply(active.sessionId, active.from, active.to, word);
    },
  });

  const stopPoll = (): void => {
    if (poll === null) return;
    window.clearInterval(poll);
    poll = null;
  };

  return {
    /** Arm (or re-arm) the march for a chunk whose wash just shipped. */
    arm(sessionId: string, from: number, to: number, timeline: WordTimeline): void {
      if (!opts.owns(sessionId)) return; // the other script renders this session
      active = { sessionId, from, to };
      clock.set(timeline);
      if (poll === null) {
        poll = window.setInterval(() => {
          void browser.runtime
            .sendMessage({ type: "leia:audio:clock" })
            .then((reply: unknown) => {
              const clockMs = (reply as { data?: { clock?: number | null } } | undefined)?.data?.clock;
              if (typeof clockMs === "number") clock.resample(clockMs);
            })
            .catch(() => {});
        }, 250);
      }
    },
    /** Halt the march (chunk cleared, paused, stopped, or seeked). */
    disarm(): void {
      clock.stop();
      active = null;
      stopPoll();
    },
  };
}
