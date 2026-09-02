// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});