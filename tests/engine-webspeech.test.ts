// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSpeechEngine, type SpeechSynthesisLike } from "../src/audio/engine-webspeech";

// jsdom has no speechSynthesis — stub the utterance class the engine builds.
class FakeUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onboundary: ((ev: { charIndex: number; charLength: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;

class FakeSynth implements SpeechSynthesisLike {
  utterances: FakeUtterance[] = [];
  cancelCount = 0;
  voices: SpeechSynthesisVoice[] = [];
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
  speak(u: SpeechSynthesisUtterance): void {
    this.utterances.push(u as unknown as FakeUtterance);
  }
  cancel(): void {
    this.cancelCount += 1;
  }
}

const V = { name: "Zira", lang: "en-US", localService: true } as SpeechSynthesisVoice;

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("WebSpeechEngine", () => {
  let synth: FakeSynth;
  let engine: WebSpeechEngine;

  beforeEach(() => {
    synth = new FakeSynth();
    synth.voices = [V];
    engine = new WebSpeechEngine(synth);
  });

  it("applies rate and voice to the utterance and yields start → end", async () => {
    const events = collect(engine.speak("Hello world.", 7, { voiceName: "Zira", rate: 2 }));
    await tick();

    const u = synth.utterances[0];
    expect(u.rate).toBe(2);
    expect(u.voice).toBe(V);

    u.onstart!(new Event("start"));
    u.onend!(new Event("end"));
    // "Hello world." is 2 words → word 0 fires immediately on start ("Hello",
    // chunk offsets 0–5); word 1's timer is cleared by end.
    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("falls back to the default voice when the name is unknown", async () => {
    const events = collect(engine.speak("Hi.", 1, { voiceName: "nope", rate: 1 }));
    await tick();
    expect(synth.utterances[0].voice).toBeNull();
    synth.utterances[0].onend!(new Event("end"));
    await events;
  });

  it("cancel closes the stream with cancelled and cancels the synth", async () => {
    const events = collect(engine.speak("Hello.", 3, { voiceName: null, rate: 1 }));
    await tick();
    engine.cancel();
    expect(synth.cancelCount).toBe(1);
    expect(await events).toEqual([{ type: "cancelled", speakId: 3 }]);
  });

  it("maps a canceled/interrupted synth error to cancelled", async () => {
    const events = collect(engine.speak("Hello.", 4, { voiceName: null, rate: 1 }));
    await tick();
    synth.utterances[0].onerror!({ error: "interrupted" });
    expect(await events).toEqual([{ type: "cancelled", speakId: 4 }]);
  });

  it("maps other synth errors to error events", async () => {
    const events = collect(engine.speak("Hello.", 5, { voiceName: null, rate: 1 }));
    await tick();
    synth.utterances[0].onerror!({ error: "synthesis-failed" });
    expect(await events).toEqual([{ type: "error", speakId: 5, message: "synthesis-failed" }]);
  });

  it("a new speak preempts the previous one", async () => {
    const first = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await tick();
    const second = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await tick();

    expect(synth.cancelCount).toBe(1); // old utterance stopped
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    synth.utterances[1].onstart!(new Event("start"));
    synth.utterances[1].onend!(new Event("end"));
    expect(await second).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("getVoices resolves from the synth with the family tag", async () => {
    expect(await engine.getVoices()).toEqual([
      { name: "Zira", lang: "en-US", localService: true, family: "web-speech" },
    ]);
  });

  it("caches the voices promise: one shared population wait per engine instance", async () => {
    vi.useFakeTimers();
    synth.voices = []; // voices not populated yet
    const a = engine.getVoices();
    const b = engine.getVoices();
    expect(b).toBe(a); // second caller shares the first wait — no second poll chain
    synth.voices = [V]; // voices arrive mid-wait
    await vi.advanceTimersByTimeAsync(100); // first poll tick sees them
    expect(await a).toEqual([{ name: "Zira", lang: "en-US", localService: true, family: "web-speech" }]);
    expect(await b).toEqual(await a);
    vi.useRealTimers();
  });

  it("a voiceless synth fails loudly instead of queueing a silent utterance", async () => {
    vi.useFakeTimers();
    synth.voices = []; // no system TTS (speech-dispatcher missing, sandboxed…)
    const events = collect(engine.speak("Hello.", 9, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(2000); // past the voices wait
    expect(await events).toEqual([
      {
        type: "error",
        speakId: 9,
        message: "no speech voices available — system text-to-speech is unavailable (speech-dispatcher on Linux?)",
      },
    ]);
    expect(synth.utterances).toHaveLength(0); // the doomed utterance was never queued

    // The cached empty result also makes the next chunk fail fast.
    const next = collect(engine.speak("More.", 10, { voiceName: null, rate: 1 }));
    expect(await next).toEqual([
      {
        type: "error",
        speakId: 10,
        message: "no speech voices available — system text-to-speech is unavailable (speech-dispatcher on Linux?)",
      },
    ]);
    vi.useRealTimers();
  });

  it("onend without onstart is an error, not a fake success", async () => {
    const events = collect(engine.speak("Hello.", 11, { voiceName: null, rate: 1 }));
    await tick();
    synth.utterances[0].onend!(new Event("end"));
    expect(await events).toEqual([
      { type: "error", speakId: 11, message: "speech synthesis ended without starting — no audio produced" },
    ]);
  });

  it("an implausibly fast start→end on chunk-length text is an error (silent completion)", async () => {
    const events = collect(engine.speak("word ".repeat(30), 12, { voiceName: null, rate: 1 })); // 150 chars
    await tick();
    const u = synth.utterances[0];
    u.onstart!(new Event("start"));
    u.onend!(new Event("end")); // fires immediately — far under 150ms
    const evs = await events;
    expect(evs[0]).toEqual({ type: "start", speakId: 12 });
    expect(evs.at(-1)).toMatchObject({
      type: "error",
      speakId: 12,
      message: expect.stringContaining("no audio produced"),
    });
    expect(evs.at(-1)).not.toEqual({ type: "end", speakId: 12 });
  });

  it("advertises word-granularity local/free capabilities", () => {
    expect(engine.capabilities).toEqual({
      wordTiming: true,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    });
  });

  // Boundary re-anchor: utterance.onboundary re-anchors the estimated word
  // march at the engine's real charIndex; timers orphaned by the re-anchor
  // (or by cancel) are dropped via the `i !== next` / dead guards.
  describe("boundary re-anchor (word march)", () => {
    const TEXT = "one two three four five."; // words at 0–3, 4–7, 8–13, 14–18, 19–24
    // Estimated march at rate 1 (75ms/char clamped 60–800ms): 225, 225, 375,
    // 300, 375 → cumulative fire times [225, 450, 825, 1125] for words 1–4.
    const expectTimers = (timers: Array<{ ms: number }>): void => {
      expect(timers.map((t) => t.ms)).toEqual([225, 450, 825, 1125]);
    };

    let captured: Array<{ ms: number; fn: () => void }> = [];
    let spy: { mockRestore: () => void } | null = null;
    /** Capture the engine's scheduled timer callbacks while leaving them live. */
    const captureTimers = (): Array<{ ms: number; fn: () => void }> => {
      captured = [];
      const fakeST = globalThis.setTimeout;
      const s = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        captured.push({ ms: ms ?? 0, fn });
        return fakeST(fn, ms);
      }) as unknown as typeof setTimeout);
      spy = s;
      return captured;
    };

    afterEach(() => {
      spy?.mockRestore();
      spy = null;
      vi.useRealTimers();
    });

    const queued = async (): Promise<FakeUtterance> => {
      await vi.advanceTimersByTimeAsync(0); // flush the voices gate → synth.speak
      const u = synth.utterances[0];
      expect(u).toBeDefined();
      return u;
    };

    it("a boundary event mid-speak re-anchors the march to the reported charIndex", async () => {
      vi.useFakeTimers();
      const events = collect(engine.speak(TEXT, 21, { voiceName: null, rate: 1 }));
      const u = await queued();

      u.onstart!(new Event("start")); // word 0 emitted; timers at 225/450/825/1125
      await vi.advanceTimersByTimeAsync(300); // estimate fires "two" at 225
      // The engine is really at "four" (14–18) while the estimate still says
      // "three" — the boundary snaps the cursor forward, dropping "three".
      u.onboundary!({ charIndex: 14, charLength: 4 });
      await vi.advanceTimersByTimeAsync(300); // "five." re-timed: 300ms after the new anchor, not at 1125
      u.onend!(new Event("end"));

      const evs = await events;
      expect(evs).toEqual([
        { type: "start", speakId: 21 },
        { type: "word", speakId: 21, begin: 0, end: 3 },
        { type: "word", speakId: 21, begin: 4, end: 7 },
        { type: "word", speakId: 21, begin: 14, end: 18 }, // "four" (boundary snap)
        { type: "word", speakId: 21, begin: 19, end: 24 }, // "five." from the re-anchored schedule
        { type: "end", speakId: 21 },
      ]);
      expect(evs).not.toContainEqual({ type: "word", speakId: 21, begin: 8, end: 13 }); // "three" dropped
    });

    it("a stale timer (index mismatch after re-anchor) is dropped — no duplicate word", async () => {
      vi.useFakeTimers();
      const timers = captureTimers();
      const events = collect(engine.speak(TEXT, 22, { voiceName: null, rate: 1 }));
      const u = await queued();

      u.onstart!(new Event("start"));
      expectTimers(timers);
      const staleOne = timers[0].fn; // fireWord(1) "two"
      const staleTwo = timers[1].fn; // fireWord(2) "three"

      await vi.advanceTimersByTimeAsync(300); // "two" fires normally → next=2
      u.onboundary!({ charIndex: 14, charLength: 4 }); // snap to "four" → next=4, old timers cleared
      staleOne(); // orphaned callback: 1 !== next(4) → dropped
      staleTwo(); // orphaned callback: 2 !== next(4) → "three" never double-counts
      await vi.advanceTimersByTimeAsync(300); // "five." fires from the re-anchored schedule only
      u.onend!(new Event("end"));

      const evs = await events;
      expect(evs.filter((e) => (e as { type: string }).type === "word")).toEqual([
        { type: "word", speakId: 22, begin: 0, end: 3 },
        { type: "word", speakId: 22, begin: 4, end: 7 },
        { type: "word", speakId: 22, begin: 14, end: 18 },
        { type: "word", speakId: 22, begin: 19, end: 24 },
      ]);
      expect(evs.at(-1)).toEqual({ type: "end", speakId: 22 });
      expect(evs).not.toContainEqual({ type: "word", speakId: 22, begin: 8, end: 13 });
    });

    it("boundary and orphaned timers after cancel are ignored (dead march)", async () => {
      vi.useFakeTimers();
      const timers = captureTimers();
      const events = collect(engine.speak(TEXT, 23, { voiceName: null, rate: 1 }));
      const u = await queued();

      u.onstart!(new Event("start"));
      expectTimers(timers);
      await vi.advanceTimersByTimeAsync(300); // "two" fired
      engine.cancel(); // dead: timers cleared, stream closed cancelled
      const staleTwo = timers[1].fn; // fireWord(2) — orphaned by stopMarch
      expect(() => staleTwo()).not.toThrow(); // dead guard → dropped, nothing pushed
      expect(() => u.onboundary!({ charIndex: 14, charLength: 4 })).not.toThrow(); // dead guard
      expect(await events).toEqual([
        { type: "start", speakId: 23 },
        { type: "word", speakId: 23, begin: 0, end: 3 }, // emitted before cancel
        { type: "word", speakId: 23, begin: 4, end: 7 },
        { type: "cancelled", speakId: 23 },
      ]);
      expect(synth.cancelCount).toBe(1);
    });
  });
});