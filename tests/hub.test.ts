import { describe, expect, it } from "vitest";
import { EngineHub } from "../src/audio/hub";
import { EventStream } from "../src/reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../src/reader/contract";

const FREE_CAPS: EngineCapabilities = { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" };
const PAID_CAPS: EngineCapabilities = { wordTiming: true, streaming: false, costClass: "paid", privacyClass: "provider" };

class StubEngine implements TextEngine {
  readonly family: string;
  readonly capabilities: EngineCapabilities;
  readonly voices: VoiceInfo[];
  speakCalls = 0;
  cancelCount = 0;
  failGetVoices = false;

  constructor(family: string, voices: VoiceInfo[], capabilities: EngineCapabilities = FREE_CAPS) {
    this.family = family;
    this.voices = voices;
    this.capabilities = capabilities;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    if (this.failGetVoices) throw new Error("engine unavailable");
    return this.voices;
  }

  speak(_text: string, _speakId: number, _options: SpeakOptions): AsyncIterable<EngineEvent> {
    this.speakCalls += 1;
    return new EventStream<EngineEvent>();
  }

  cancel(): void {
    this.cancelCount += 1;
  }
}

const voice = (name: string, family: string): VoiceInfo => ({ name, lang: "en-US", localService: true, family });

describe("EngineHub", () => {
  it("merged getVoices: default family first, stable order, rejected engines skipped", async () => {
    const ws = new StubEngine("web-speech", [voice("Local A", "web-speech")]);
    const mx = new StubEngine("minimax", [voice("Provider B", "minimax")]);
    const ex = new StubEngine("extra", [voice("Extra C", "extra")]);
    ex.failGetVoices = true;

    const hub = new EngineHub();
    hub.register("minimax", mx); // registered first — must NOT lead
    hub.register("web-speech", ws, { default: true });
    hub.register("extra", ex);

    expect(await hub.getVoices()).toEqual([voice("Local A", "web-speech"), voice("Provider B", "minimax")]);
  });

  it("speak/cancel route to the current family; currentFamily tracks selection", async () => {
    const ws = new StubEngine("web-speech", []);
    const mx = new StubEngine("minimax", []);
    const hub = new EngineHub();
    hub.register("web-speech", ws, { default: true });
    hub.register("minimax", mx);

    expect(hub.currentFamily).toBe("web-speech");
    hub.speak("Hello.", 1, { voiceName: null, rate: 1 });
    hub.cancel();
    expect(ws.speakCalls).toBe(1);
    expect(ws.cancelCount).toBe(1);

    hub.select("minimax");
    expect(hub.currentFamily).toBe("minimax");
    hub.speak("World.", 2, { voiceName: null, rate: 1 });
    hub.cancel();
    expect(mx.speakCalls).toBe(1);
    expect(mx.cancelCount).toBe(1);
    expect(ws.speakCalls).toBe(1); // unchanged
  });

  it("selectFamily selects the family (session engine-switch hook)", async () => {
    const ws = new StubEngine("web-speech", []);
    const mx = new StubEngine("minimax", []);
    const hub = new EngineHub();
    hub.register("web-speech", ws, { default: true });
    hub.register("minimax", mx);

    hub.selectFamily("minimax");
    expect(hub.currentFamily).toBe("minimax");
  });

  it("select with an unknown family is a no-op", async () => {
    const ws = new StubEngine("web-speech", []);
    const hub = new EngineHub();
    hub.register("web-speech", ws, { default: true });

    hub.select("nope");
    expect(hub.currentFamily).toBe("web-speech");
  });

  it("capabilities follow the selected family", async () => {
    const ws = new StubEngine("web-speech", [], FREE_CAPS);
    const mx = new StubEngine("minimax", [], PAID_CAPS);
    const hub = new EngineHub();
    hub.register("web-speech", ws, { default: true });
    hub.register("minimax", mx);

    expect(hub.capabilities.wordTiming).toBe(false);
    hub.select("minimax");
    expect(hub.capabilities).toEqual(PAID_CAPS);
    expect(hub.capabilities.wordTiming).toBe(true);
  });

  it("cancel after an engine switch still stops the engine that was speaking", async () => {
    const ws = new StubEngine("web-speech", []);
    const mx = new StubEngine("minimax", []);
    const hub = new EngineHub();
    hub.register("web-speech", ws, { default: true });
    hub.register("minimax", mx);

    hub.speak("Alpha.", 1, { voiceName: null, rate: 1 }); // routes to web-speech
    hub.select("minimax"); // switch mid-speech
    hub.cancel();
    expect(ws.cancelCount).toBe(1); // the speaking engine, not the new current
    expect(mx.cancelCount).toBe(0);
  });

  it("registering without a default picks the first engine", async () => {
    const ws = new StubEngine("web-speech", []);
    const hub = new EngineHub();
    hub.register("web-speech", ws);
    expect(hub.currentFamily).toBe("web-speech");
  });
});