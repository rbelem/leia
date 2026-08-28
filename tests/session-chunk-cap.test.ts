// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { EventStream } from "../src/reader/event-stream";
import type { EngineEvent, TextEngine, VoiceInfo } from "../src/reader/contract";
import { ReaderSession, type SessionEvent, type SessionStorage } from "../src/reader/session";

/** Minimal engine double: voices with a selectable lang; speak never ends on its own. */
class LangEngine implements TextEngine {
  readonly family = "web-speech";
  readonly capabilities = { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" } as const;
  readonly voices: VoiceInfo[];
  constructor(voices: VoiceInfo[]) {
    this.voices = voices;
  }
  getVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(this.voices);
  }
  speak(): AsyncIterable<EngineEvent> {
    return new EventStream<EngineEvent>();
  }
  cancel(): void {
    /* no-op */
  }
}

class MemoryStorage implements SessionStorage {
  private map = new Map<string, unknown>();
  async get(key: string): Promise<Record<string, unknown>> {
    return this.map.has(key) ? { [key]: this.map.get(key) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.map.set(k, v);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ReaderSession locale-aware chunk cap", () => {
  it("a CJK voice caps chunks at CJK_TOKEN_CHARS; a non-CJK voice keeps the Latin cap", async () => {
    // One 144-char unbroken CJK sentence plus short ones: under the Latin cap
    // the whole run fits ONE chunk (208 ≤ 250 chars); under the CJK cap the
    // 144-char token stands alone (144 + 8 > 100).
    const longCjk = "这是一个没有标点符号的超级长句子".repeat(9); // 144 chars
    const short = Array.from({ length: 8 }, (_, i) => ({ text: `这是第${i}个句子。` })); // 8 chars each
    const cjkTokens = [{ text: longCjk }, ...short];

    for (const [name, lang, expected] of [
      ["Leia-zh", "zh-CN", { from: 0, to: 0 }],
      ["Leia-en", "en-US", { from: 0, to: 8 }],
    ] as const) {
      const engine = new LangEngine([{ name, lang, localService: true, family: "web-speech" }]);
      const events: SessionEvent[] = [];
      const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));
      await s.start(cjkTokens, { voiceName: name });
      await tick();
      const highlight = events.find((ev) => ev.type === "highlight");
      expect(highlight).toMatchObject({ type: "highlight", ...expected });
      await s.stop();
    }
  });

  it("an engine-declared maxUtteranceChars overrides the 250-char WebSpeech cap", async () => {
    // A paragraph of short sentences totalling ~700 chars: under the default
    // Latin cap this splits into 3 utterances (one request boundary every
    // sentence or two — the audible per-sentence pause); a HTTP MP3 engine
    // declares 2000 and reads the whole paragraph as ONE seamless chunk.
    const sentences = Array.from({ length: 25 }, (_, i) => ({
      text: `Sentence number ${i} says a little something. `,
    }));
    const engine = new LangEngine([{ name: "MiniMax", lang: "en-US", localService: false, family: "minimax" }]);
    (engine.capabilities as { maxUtteranceChars?: number }).maxUtteranceChars = 2000;
    const events: SessionEvent[] = [];
    const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));
    await s.start(sentences, { voiceName: "MiniMax" });
    await tick();
    const highlight = events.find((ev) => ev.type === "highlight");
    expect(highlight).toMatchObject({ type: "highlight", from: 0, to: 24 });
    await s.stop();
  });
});