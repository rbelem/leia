import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSpeechEngine, type SpeechSynthesisLike } from "../src/audio/engine-webspeech";
import type { EngineEvent } from "../src/reader/contract";
import { wordSpans } from "../src/reader/sentences";

// jsdom has no speechSynthesis — stub the utterance class the engine builds,
// with onboundary support for the drift-correction tests.
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
  voices: SpeechSynthesisVoice[] = [];
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
  speak(u: SpeechSynthesisUtterance): void {
    this.utterances.push(u as unknown as FakeUtterance);
  }
  cancel(): void {}
}

const V = { name: "Zira", lang: "en-US", localService: true } as SpeechSynthesisVoice;
const ZH = { name: "Ting-Ting", lang: "zh-CN", localService: true } as SpeechSynthesisVoice;

// Four 4-char words → dur = 4 * MS_PER_CHAR / rate = 300ms each at rate 1,
// so words fire at t = 0 / 300 / 600 / 900 from the utterance start.
const TEXT = "aaaa bbbb cccc dddd";
const spans = wordSpans(TEXT, "en-US");

const mk = (): { synth: FakeSynth; engine: WebSpeechEngine } => {
  const synth = new FakeSynth();
  return { synth, engine: new WebSpeechEngine(synth) };
};

interface Harness {
  seen: EngineEvent[];
  done: Promise<void>;
  utterance: FakeUtterance;
}

/** Start a speak on `engine`/`synth` and fire onstart; returns the live drain. */
const drain = (
  engine: WebSpeechEngine,
  synth: FakeSynth,
  text: string,
  opts: { voiceName?: string | null; rate?: number } = {},
): Harness => {
  const seen: EngineEvent[] = [];
  const done = (async (): Promise<void> => {
    for await (const ev of engine.speak(text, 1, { voiceName: opts.voiceName ?? null, rate: opts.rate ?? 1 })) {
      seen.push(ev);
    }
  })();
  const utterance = synth.utterances.at(-1)!;
  utterance.onstart!(new Event("start"));
  return { seen, done, utterance };
};

/** Flush microtasks (the async iterator drains pushes one hop at a time). */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

describe("WebSpeechEngine word timing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("marches word events on estimated cumulative offsets, in span order", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();

    // Word 0 fires immediately on start; word 1 is not due until t = 300.
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
    ]);
    await vi.advanceTimersByTimeAsync(299);
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[2]).toEqual({ type: "word", speakId: 1, begin: 5, end: 9 });

    await vi.advanceTimersByTimeAsync(600);
    expect(seen.slice(2)).toEqual([
      { type: "word", speakId: 1, begin: 5, end: 9 },
      { type: "word", speakId: 1, begin: 10, end: 14 },
      { type: "word", speakId: 1, begin: 15, end: 19 },
    ]);
    // Offsets advance monotonically and equal wordSpans offsets on the chunk text.
    const wordSpansSeen = seen.filter((e) => e.type === "word").map((e) => [e.begin, e.end]);
    expect(wordSpansSeen).toEqual(spans.map((s) => [s.start, s.end]));

    utterance.onend!(new Event("end"));
    await done;
    expect(seen.at(-1)).toEqual({ type: "end", speakId: 1 });
  });

  it("segments by the selected voice's lang; single-word chunks emit no word events", async () => {
    const { synth, engine } = mk();
    synth.voices = [ZH, V];
    const zhText = "今天天气真好";
    const zhSpans = wordSpans(zhText, "zh-CN");
    expect(zhSpans.length).toBeGreaterThanOrEqual(2); // zh word segmentation sanity

    const zh = drain(engine, synth, zhText, { voiceName: "Ting-Ting" });
    await flush();
    expect(zh.seen[0]).toEqual({ type: "start", speakId: 1 });
    expect(zh.seen[1]).toEqual({ type: "word", speakId: 1, begin: zhSpans[0].start, end: zhSpans[0].end });
    await vi.advanceTimersByTimeAsync(10_000); // all words march to completion
    expect(zh.seen.filter((e) => e.type === "word").map((e) => [e.begin, e.end])).toEqual(
      zhSpans.map((s) => [s.start, s.end]),
    );

    // One-word chunk: sentence marching, silently — no word events ever.
    const { synth: synth2, engine: engine2 } = mk();
    const hi = drain(engine2, synth2, "Hi.", {});
    await flush();
    expect(hi.seen).toEqual([{ type: "start", speakId: 1 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hi.seen).toEqual([{ type: "start", speakId: 1 }]);
    hi.utterance.onend!(new Event("end"));
    await hi.done;
    expect(hi.seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);

    zh.utterance.onend!(new Event("end"));
    await zh.done;
  });

  it("snaps to the boundary word when a boundary jumps ≥ 2 words ahead", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();

    // Engine runs fast: at t = 0 it already reports charIndex 15 ("dddd").
    utterance.onboundary!({ charIndex: 15, charLength: 4 });
    await flush();

    // Snap: w0 → w3 directly — w1/w2 (and their timers) are dropped.
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "word", speakId: 1, begin: 15, end: 19 },
    ]);
    await vi.advanceTimersByTimeAsync(5000); // no stragglers from the old schedule
    expect(seen).toHaveLength(3);

    utterance.onend!(new Event("end"));
    await done;
  });

  it("re-times remaining words from the boundary position (1-word drift)", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();

    // Boundary at charIndex 10 ("cccc") arrives at t = 100 — one word ahead.
    await vi.advanceTimersByTimeAsync(100);
    utterance.onboundary!({ charIndex: 10, charLength: 4 });
    await flush();

    // Snap to the boundary word now; w3 is re-anchored to fire at 100 + 300ms.
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "word", speakId: 1, begin: 10, end: 14 },
    ]);
    await vi.advanceTimersByTimeAsync(299);
    expect(seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[3]).toEqual({ type: "word", speakId: 1, begin: 15, end: 19 });

    utterance.onend!(new Event("end"));
    await done;
  });

  it("re-times remaining words without marching backward when a boundary lags", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();
    await vi.advanceTimersByTimeAsync(300); // w1 fired at t = 300
    expect(seen).toHaveLength(3);

    // Engine is slow: at t = 350 it reports charIndex 6 (inside "bbbb").
    await vi.advanceTimersByTimeAsync(50);
    utterance.onboundary!({ charIndex: 6, charLength: 4 });
    await flush();
    expect(seen).toHaveLength(3); // highlight never moves backward

    // Re-anchored: w2 now due at 350 + 300 = 650, not the original 600.
    await vi.advanceTimersByTimeAsync(249); // t = 599
    expect(seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); // t = 600 — old w2 timer was cleared
    expect(seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(50); // t = 650 — re-anchored w2 fires
    expect(seen[3]).toEqual({ type: "word", speakId: 1, begin: 10, end: 14 });

    utterance.onend!(new Event("end"));
    await done;
  });

  it("keeps marching on pure estimation when no boundary events arrive", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "word", speakId: 1, begin: 5, end: 9 },
      { type: "word", speakId: 1, begin: 10, end: 14 },
      { type: "word", speakId: 1, begin: 15, end: 19 },
    ]);

    utterance.onend!(new Event("end"));
    await done;
    expect(seen.at(-1)).toEqual({ type: "end", speakId: 1 });
  });

  it("clears pending word timers on cancel", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();

    engine.cancel();
    await flush();
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "cancelled", speakId: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(10_000); // no stray word events
    expect(seen).toHaveLength(3);
    await done;
  });

  it("clears pending word timers on error", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const { seen, done, utterance } = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();
    await vi.advanceTimersByTimeAsync(100);

    utterance.onerror!({ error: "synthesis-failed" });
    await flush();
    expect(seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "error", speakId: 1, message: "synthesis-failed" },
    ]);
    await vi.advanceTimersByTimeAsync(10_000); // word 1 was due at 300 — cleared
    expect(seen).toHaveLength(3);
    await done;
  });

  it("a new speak clears the preempted march's timers", async () => {
    const { synth, engine } = mk();
    synth.voices = [V];
    const first = drain(engine, synth, TEXT, { voiceName: "Zira" });
    await flush();
    await vi.advanceTimersByTimeAsync(100);

    const second = drain(engine, synth, "Hi.", {}); // preempts the first march
    await flush();
    expect(first.seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "word", speakId: 1, begin: 0, end: 4 },
      { type: "cancelled", speakId: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(10_000); // old w1@300 timer was cleared
    expect(first.seen).toHaveLength(3);
    await first.done;

    second.utterance.onend!(new Event("end"));
    await second.done;
    expect(second.seen).toEqual([
      { type: "start", speakId: 1 },
      { type: "end", speakId: 1 },
    ]);
  });
});