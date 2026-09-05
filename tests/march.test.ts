// SPDX-License-Identifier: MPL-2.0
/**
 * createMarch (content/march.ts): owns-gating, the 250ms background media
 * clock poll, word application through the word clock (600ms lead), poll
 * resilience (non-numeric replies and rejections are swallowed), and disarm
 * semantics. Deterministic via fake timers (Date + intervals + rAF).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** Runtime messages sent by the march (the leia:audio:clock poll). */
  sent: [] as unknown[],
  /** Reply for leia:audio:clock polls. */
  clockReply: undefined as unknown,
  /** Reject the poll send when set (network-ish failure). */
  rejectSend: false,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async (msg: unknown) => {
        if (state.rejectSend) throw new Error("receiving end does not exist");
        state.sent.push(msg);
        return state.clockReply;
      },
      onMessage: { addListener: () => {} },
    },
  },
}));

import { createMarch, type MarchOpts } from "../src/content/march";
import type { WordTimeline } from "../src/reader/contract";

/** Timeline anchored at the (frozen) current wall clock, media clock 0. */
function timeline(words: Array<{ t: number; begin: number; end: number }>): WordTimeline {
  return { words, anchorWall: Date.now(), anchorClock: 0 };
}

const WORDS = [
  { t: 1000, begin: 0, end: 4 },
  { t: 2000, begin: 5, end: 9 },
  { t: 3000, begin: 10, end: 15 },
];

describe("createMarch", () => {
  beforeEach(() => {
    state.sent = [];
    state.clockReply = { data: { clock: null } };
    state.rejectSend = false;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMarch(owned: (id: string) => boolean) {
    const applied: Array<{ sessionId: string; from: number; to: number; word: { begin: number; end: number } }> = [];
    const opts: MarchOpts = {
      apply: (sessionId, from, to, word) => void applied.push({ sessionId, from, to, word }),
      owns: owned,
    };
    return { march: createMarch(opts), applied };
  }

  it("ignores arm() for a session this script does not own (no clock, no poll)", async () => {
    const { march, applied } = makeMarch((id) => id === "s1");
    march.arm("other", 3, 7, timeline(WORDS));
    await vi.advanceTimersByTimeAsync(1000); // poll window + word window
    expect(state.sent).toEqual([]); // no poll interval was started
    expect(applied).toEqual([]); // word clock never armed
  });

  it("applies owned-session words through apply() with the armed chunk bounds", async () => {
    const { march, applied } = makeMarch((id) => id === "s1");
    march.arm("s1", 3, 7, timeline(WORDS));
    // rAF step at ~16ms: clockNow 16 < first onset minus 600 lead → nothing yet.
    await vi.advanceTimersByTimeAsync(16);
    expect(applied).toEqual([]);
    // Past word 1's lead-adjusted onset (1000 - 600 = 400).
    await vi.advanceTimersByTimeAsync(400);
    expect(applied).toEqual([{ sessionId: "s1", from: 3, to: 7, word: { begin: 0, end: 4 } }]);
    // Word 2 (2000 - 600 = 1400).
    await vi.advanceTimersByTimeAsync(1100);
    expect(applied).toHaveLength(2);
    expect(applied[1].word).toEqual({ begin: 5, end: 9 });
    expect(state.sent.length).toBeGreaterThan(0); // the poll is alive by now
  });

  it("starts exactly one poll across re-arms and every tick polls leia:audio:clock", async () => {
    const { march } = makeMarch(() => true);
    march.arm("s1", 0, 0, timeline(WORDS));
    march.arm("s1", 1, 1, timeline(WORDS)); // re-arm must not stack a second interval
    state.sent = [];
    await vi.advanceTimersByTimeAsync(250);
    const audioClockPolls = state.sent.filter((m) => (m as { type?: string }).type === "leia:audio:clock");
    expect(audioClockPolls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(state.sent.filter((m) => (m as { type?: string }).type === "leia:audio:clock")).toHaveLength(2);
  });

  it("re-anchors from a numeric poll reply (resample) — rewind lets words replay", async () => {
    const { march, applied } = makeMarch(() => true);
    march.arm("s1", 0, 0, timeline(WORDS));
    await vi.advanceTimersByTimeAsync(2100); // words 1 and 2 applied, index at 2
    expect(applied).toHaveLength(2);
    // One poll reply rewinds the media clock to 0 (the stale-anchor rewind);
    // later polls answer null again so the rewritten anchor extrapolates.
    state.clockReply = { data: { clock: 0 } };
    await vi.advanceTimersByTimeAsync(260); // tick at 2250 delivers the resample
    state.clockReply = { data: { clock: null } };
    applied.length = 0;
    // clockNow = 0 + (T - 2250): word 1 due again at clockNow ≥ 1000 - 600.
    await vi.advanceTimersByTimeAsync(500);
    expect(applied.map((a) => a.word)).toEqual([{ begin: 0, end: 4 }]);
  });

  it("ignores non-numeric clock replies (dead reckoning continues)", async () => {
    const { march, applied } = makeMarch(() => true);
    state.clockReply = { data: { clock: "garbage" } };
    march.arm("s1", 0, 0, timeline(WORDS));
    // Without a resample the anchor stays at wall-clock 0: at +700ms only
    // word 1 is due (a resample to the reply's junk must never happen).
    await vi.advanceTimersByTimeAsync(700);
    expect(applied.map((a) => a.word)).toEqual([{ begin: 0, end: 4 }]);
  });

  it("swallows poll send failures (keepalive must never throw)", async () => {
    const { march, applied } = makeMarch(() => true);
    march.arm("s1", 0, 0, timeline(WORDS));
    state.rejectSend = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied.length).toBeGreaterThan(0); // local sweep unaffected
    state.rejectSend = false;
    await vi.advanceTimersByTimeAsync(250); // poll keeps ticking after failures
  });

  it("disarm() stops the poll and the word sweep", async () => {
    const { march, applied } = makeMarch(() => true);
    march.arm("s1", 0, 0, timeline(WORDS));
    await vi.advanceTimersByTimeAsync(450); // poll alive, word 1 due at 400
    expect(applied).toHaveLength(1);
    march.disarm();
    const sentAtDisarm = state.sent.length;
    const appliedAtDisarm = applied.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.sent).toHaveLength(sentAtDisarm); // interval cleared
    expect(applied).toHaveLength(appliedAtDisarm); // sweep stopped (timeline dropped)
  });

  it("disarm() without an active march is a safe no-op", () => {
    const { march } = makeMarch(() => true);
    expect(() => march.disarm()).not.toThrow(); // stopPoll early-return path
  });
});
