import { describe, expect, it } from "vitest";
import { EventStream } from "../src/reader/event-stream";
import type {
  EngineCapabilities,
  EngineEvent,
  SpeakOptions,
  TextEngine,
  VoiceInfo,
} from "../src/reader/contract";
import { PREFS_KEY, ReaderSession, SESSION_KEY, type SessionEvent, type SessionStorage } from "../src/reader/session";

/** Test double for the TextEngine contract. */
class FakeEngine implements TextEngine {
  readonly family = "web-speech";
  readonly capabilities: EngineCapabilities;
  speaks: Array<{ text: string; speakId: number; options: SpeakOptions }> = [];
  cancels = 0;
  private familyCalls: string[] = [];
  private current: { speakId: number; stream: EventStream<EngineEvent> } | null = null;

  constructor(capabilities: Partial<EngineCapabilities> = {}) {
    this.capabilities = {
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
      ...capabilities,
    };
  }

  selectFamily(family: string): void {
    this.familyCalls.push(family);
  }

  getVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve([]);
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    if (this.current) {
      this.current.stream.closeCancelled({ type: "cancelled", speakId: this.current.speakId });
    }
    this.current = { speakId, stream };
    this.speaks.push({ text, speakId, options });
    return stream;
  }

  cancel(): void {
    this.cancels += 1;
    const c = this.current;
    this.current = null;
    if (c) c.stream.closeCancelled({ type: "cancelled", speakId: c.speakId });
  }

  /** Test helper: current chunk reached its natural end. */
  finishCurrent(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.stream.push({ type: "end", speakId: c.speakId });
    c.stream.close();
  }

  /** Test helper: push a word-timing event for the current speak. */
  pushWord(speakId: number, begin: number, end: number): void {
    const c = this.current;
    if (!c || c.speakId !== speakId) return;
    c.stream.push({ type: "word", speakId, begin, end });
  }

  selectFamilyCalls(): string[] {
    return [...this.familyCalls];
  }
}

/** In-memory SessionStorage double backed by the same semantics as storage.session. */
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
  read(key: string): unknown {
    return this.map.get(key);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 4 sentences ⇒ chunks [0..2] and [3..3]. */
const TOKENS: Array<{ text: string }> = [
  "First sentence.",
  "Second sentence.",
  "Third sentence.",
  "Fourth sentence.",
].map((text) => ({ text }));

function makeSession(engine: FakeEngine = new FakeEngine()) {
  const storage = new MemoryStorage();
  const events: SessionEvent[] = [];
  return { engine, storage, events, emit: (ev: SessionEvent) => events.push(ev) };
}

describe("ReaderSession (fake engine)", () => {
  it("plays chunks in order, advancing the highlight per chunk", async () => {
    const { engine, storage, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);

    await s.start(TOKENS);
    await tick();

    expect(engine.speaks).toHaveLength(1);
    expect(engine.speaks[0].text).toBe("First sentence.Second sentence.Third sentence.");
    expect(events).toContainEqual({ type: "highlight", sessionId: expect.any(String), from: 0, to: 2 });

    engine.finishCurrent();
    await tick();
    expect(engine.speaks).toHaveLength(2);
    expect(engine.speaks[1].text).toBe("Fourth sentence.");
    expect(events).toContainEqual({ type: "highlight", sessionId: expect.any(String), from: 3, to: 3 });

    engine.finishCurrent();
    await tick();
    const final = s.status();
    expect(final.state).toBe("stopped");
    expect(storage.read(SESSION_KEY)).toBeUndefined(); // cleanup
  });

  it("pause records the token position and cancels the engine", async () => {
    const { engine, storage, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);

    await s.start(TOKENS);
    await tick();
    engine.finishCurrent(); // advance to chunk [3..3]
    await tick();

    const status = await s.pause();
    await tick();
    expect(status.state).toBe("paused");
    expect(status.tokenPos).toBe(3); // replay-from-token anchor
    expect(engine.cancels).toBe(1);
    expect(engine.speaks).toHaveLength(2); // drive stopped, no further chunks
    const stored = storage.read(SESSION_KEY) as { state: string; tokenPos: number };
    expect(stored.state).toBe("paused");
    expect(stored.tokenPos).toBe(3);
  });

  it("resume re-speaks from the recorded token", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    engine.finishCurrent();
    await tick();
    await s.pause();
    await tick();

    await s.resume();
    await tick();
    expect(engine.speaks).toHaveLength(3);
    expect(engine.speaks[2].text).toBe("Fourth sentence."); // replayed from token 3
  });

  it("stop cancels, clears storage, emits clear", async () => {
    const { engine, storage, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);

    await s.start(TOKENS);
    await tick();
    const id = s.status().sessionId;

    const status = await s.stop();
    await tick();
    expect(status.state).toBe("stopped");
    expect(engine.cancels).toBe(1);
    expect(storage.read(SESSION_KEY)).toBeUndefined();
    expect(events).toContainEqual({ type: "clear", sessionId: id });
  });

  it("hydrates a vanished owner: paused resume path, playing parks as paused", async () => {
    const { engine, storage } = makeSession();
    const s1 = await ReaderSession.load(engine, storage, () => {});
    await s1.start(TOKENS);
    await tick();
    engine.finishCurrent();
    await tick();
    await s1.pause(); // owner would die here — storage.session holds {paused, tokenPos 3}

    // New owner hydrates from the same storage.
    const s2 = await ReaderSession.load(engine, storage, () => {});
    expect(s2.status().state).toBe("paused");
    expect(s2.status().tokenPos).toBe(3);
    await s2.resume();
    await tick();
    expect(engine.speaks.at(-1)?.text).toBe("Fourth sentence.");
  });

  it("hydrates a session that vanished mid-play by cancelling audio and parking paused", async () => {
    const { engine, storage } = makeSession();
    const s1 = await ReaderSession.load(engine, storage, () => {});
    await s1.start(TOKENS); // stored as playing, no finish — owner dies mid-chunk
    await tick();

    const cancelsBefore = engine.cancels;
    const s2 = await ReaderSession.load(engine, storage, () => {});
    expect(engine.cancels).toBe(cancelsBefore + 1); // orphaned audio cancelled
    expect(s2.status().state).toBe("paused");
    expect(s2.status().tokenPos).toBe(0);
    await s1.pause(); // silence the old instance's drive loop (test-only: shared engine)
  });

  it("persists prefs (voice+speed) across sessions and applies live", async () => {
    const { engine, storage } = makeSession();
    const s = await ReaderSession.load(engine, storage, () => {});

    await s.setPrefs({ voiceName: "Zira", rate: 2 });
    await s.start(TOKENS, {});
    await tick();
    expect(engine.speaks[0].options).toEqual({ voiceName: "Zira", rate: 2 });

    const prefs = storage.read(PREFS_KEY) as { voiceName: string; rate: number; engine: string | null };
    expect(prefs).toEqual({ voiceName: "Zira", rate: 2, engine: null });

    const s2 = await ReaderSession.load(new FakeEngine(), storage, () => {});
    expect(s2.status().settings).toEqual({ voiceName: "Zira", rate: 2, engine: null });
  });

  it("relays word events as word-level highlights when the engine has wordTiming", async () => {
    const { engine, events, emit } = makeSession(new FakeEngine({ wordTiming: true }));
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    const id = s.status().sessionId;

    engine.pushWord(1, 3, 8);
    await tick();
    expect(events).toContainEqual({
      type: "highlight",
      sessionId: id,
      from: 0,
      to: 2,
      word: { begin: 3, end: 8 },
    });

    engine.pushWord(1, 9, 16);
    engine.finishCurrent();
    await tick();
    expect(events.filter((e) => e.type === "highlight" && "word" in e)).toEqual([
      { type: "highlight", sessionId: id, from: 0, to: 2, word: { begin: 3, end: 8 } },
      { type: "highlight", sessionId: id, from: 0, to: 2, word: { begin: 9, end: 16 } },
    ]);
    // The sentence-level chunk highlight still precedes the word march.
    const firstHighlight = events.find((e) => e.type === "highlight");
    expect(firstHighlight).toMatchObject({ type: "highlight", from: 0, to: 2 });
    expect(firstHighlight).not.toHaveProperty("word");
  });

  it("does not relay word events from engines without wordTiming", async () => {
    const { engine, events, emit } = makeSession(); // wordTiming: false
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    engine.pushWord(1, 0, 5);
    await tick();
    engine.finishCurrent();
    await tick();

    expect(events.filter((e) => e.type === "highlight" && "word" in e)).toEqual([]);
  });

  it("setPrefs engine change calls selectFamily and persists the setting", async () => {
    const { engine, storage, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);

    await s.setPrefs({ engine: "minimax" });
    expect(engine.selectFamilyCalls()).toEqual(["minimax"]);

    const prefs = storage.read(PREFS_KEY) as { engine: string | null };
    expect(prefs.engine).toBe("minimax");
    expect(s.status().settings.engine).toBe("minimax");
  });

  it("setPrefs with engine null persists the default without calling selectFamily", async () => {
    const { engine, storage, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);

    await s.setPrefs({ engine: null });
    expect(engine.selectFamilyCalls()).toEqual([]);
    expect(s.status().settings.engine).toBeNull();
  });
});