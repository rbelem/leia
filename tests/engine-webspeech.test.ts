import { beforeEach, describe, expect, it } from "vitest";
import { WebSpeechEngine, type SpeechSynthesisLike } from "../src/audio/engine-webspeech";

// jsdom has no speechSynthesis — stub the utterance class the engine builds.
class FakeUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
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
    expect(await events).toEqual([
      { type: "start", speakId: 7 },
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

  it("advertises sentence-granularity local/free capabilities", () => {
    expect(engine.capabilities).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    });
  });
});