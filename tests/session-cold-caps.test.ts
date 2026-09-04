// SPDX-License-Identifier: MPL-2.0
/**
 * Regression: the session must size its ONE chunking pass from LIVE engine
 * capabilities, not the cold cache. Chrome's ProxyEngine.capabilities
 * answers with the default (no maxUtteranceChars) until the offscreen
 * round-trip lands ms later — chunking with that cold default bakes
 * sentence-per-utterance into the whole session. Also: a wedged
 * awaitCapabilities (never settles) must degrade to the default cap instead
 * of hanging start().
 */
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/reader/contract";
import type { SessionEvent, SessionStorage } from "../src/reader/session";
import { ReaderSession } from "../src/reader/session";
import { FakeEngine } from "./fakes";

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

/** Let the drive loop run the scripted speak sequences to natural completion. */
async function driveToEnd(s: ReaderSession): Promise<void> {
  for (let i = 0; i < 200 && s.status().state !== "stopped"; i++) await tick();
}

const sentences = Array.from({ length: 25 }, (_, i) => ({
  text: `Sentence number ${i} says a little something. `,
}));
// ~1100 chars total: one chunk under a 2000-char cap, ~5 chunks under the
// 250-char WebSpeech default.
const VOICES = [{ name: "MiniMax", lang: "en-US", localService: false, family: "minimax" }];
const speakScript = (speakId: number): EngineEvent[] => [
  { type: "start", speakId },
  { type: "end", speakId },
];

describe("ReaderSession cold-start capabilities race", () => {
  it("chunks with maxUtteranceChars once the async capabilities reply lands", async () => {
    const engine = new FakeEngine("minimax", {
      voices: VOICES,
      script: speakScript,
      asyncCapabilities: { caps: { maxUtteranceChars: 2000 }, delayMs: 50 },
    });
    const events: SessionEvent[] = [];
    const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));
    await s.start(sentences, { voiceName: "MiniMax" });
    await driveToEnd(s);

    // The whole input read as ONE utterance (highlight covers 0..24) — not
    // 250-char slices, which would emit a highlight per fragment.
    const highlights = events.filter((ev) => ev.type === "highlight");
    expect(highlights.length).toBe(1);
    expect(highlights[0]).toMatchObject({ type: "highlight", from: 0, to: 24 });
  });

  it("does not hang when awaitCapabilities never settles (falls back to the default cap)", async () => {
    const engine = new FakeEngine("minimax", {
      voices: VOICES,
      script: speakScript,
      asyncCapabilities: "never",
    });
    const events: SessionEvent[] = [];
    const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));
    // Must resolve (bounded by the session-side guard), never hang.
    await s.start(sentences, { voiceName: "MiniMax" });
    await driveToEnd(s);
    await s.stop();

    // Cold default cap (250) applies: several chunk highlights, the first
    // well short of the full input.
    const highlights = events.filter((ev) => ev.type === "highlight");
    expect(highlights.length).toBeGreaterThan(1);
    expect(highlights[0]).toMatchObject({ type: "highlight", from: 0 });
    expect((highlights[0] as { to: number }).to).toBeLessThan(sentences.length - 1);
  });
});
