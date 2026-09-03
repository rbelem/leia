// SPDX-License-Identifier: MPL-2.0
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
import { FakeEngine as ScriptedEngine } from "./fakes";

/** Test double for the TextEngine contract. */
class FakeEngine implements TextEngine {
  readonly family = "web-speech";
  readonly capabilities: EngineCapabilities;
  speaks: Array<{ text: string; speakId: number; options: SpeakOptions }> = [];
  cancels = 0;
  prefetches: Array<{ text: string; options: SpeakOptions }> = [];
  /** Ordering of engine entry points ("speak" / "prefetch") as the session drove them. */
  callOrder: string[] = [];
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
    this.prefetch = (text, options) => {
      this.prefetches.push({ text, options });
      this.callOrder.push("prefetch");
      return Promise.resolve();
    };
  }

  selectFamily(family: string): void {
    this.familyCalls.push(family);
  }

  /** Voices getVoices() reports; set per-test for family-resolution cases. */
  voices: VoiceInfo[] = [];

  getVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(this.voices);
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    if (this.current) {
      this.current.stream.closeCancelled({ type: "cancelled", speakId: this.current.speakId });
    }
    this.current = { speakId, stream };
    this.speaks.push({ text, speakId, options });
    this.callOrder.push("speak");
    // Real engines emit `start` when audio begins; the fake speaks instantly.
    stream.push({ type: "start", speakId });
    return stream;
  }

  cancel(): void {
    this.cancels += 1;
    const c = this.current;
    this.current = null;
    if (c) c.stream.closeCancelled({ type: "cancelled", speakId: c.speakId });
  }

  /** Optional per contract; tests may set to undefined to simulate absence. */
  prefetch: ((text: string, options: SpeakOptions) => Promise<void>) | undefined;

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

  /** Test helper: push a whole-chunk timeline event for the current speak. */
  pushTimeline(
    speakId: number,
    timeline: { words: Array<{ begin: number; end: number; t: number }>; anchorWall: number; anchorClock: number },
  ): void {
    const c = this.current;
    if (!c || c.speakId !== speakId) return;
    c.stream.push({ type: "timeline", speakId, ...timeline });
  }

  /** Test helper: the current speak fails with the given message. */
  failCurrent(message: string): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.stream.push({ type: "error", speakId: c.speakId, message });
    c.stream.close();
  }

  selectFamilyCalls(): string[] {
    return [...this.familyCalls];
  }

  clearFamilyCalls(): void {
    this.familyCalls.length = 0;
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

/** 4 sentences in one paragraph + a second paragraph ⇒ chunks [0..2] and
 * [3..3]: block-less sentences merge to the char cap; a blockStart splits. */
const TOKENS: Array<{ text: string }> = [
  "First sentence.",
  "Second sentence.",
  "Third sentence.",
  { text: "Fourth sentence.", blockStart: true },
].map((t) => (typeof t === "string" ? { text: t } : t));

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

  it("emits the chunk highlight only once the engine started speaking (audio began)", async () => {
    const engine = new ScriptedEngine("web-speech"); // no script: events driven manually
    const events: SessionEvent[] = [];
    const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));

    await s.start(TOKENS);
    await tick();
    // The chunk was handed to the engine, but audio has not started: no
    // highlight yet (it used to fire before speak — a fake-started read).
    expect(engine.speakCalls).toHaveLength(1);
    expect(events.filter((e) => e.type === "highlight")).toEqual([]);

    engine.push(1, { type: "start", speakId: 1 });
    await tick();
    expect(events.filter((e) => e.type === "highlight")).toEqual([
      { type: "highlight", sessionId: s.status().sessionId, from: 0, to: 2 },
    ]);

    engine.push(1, { type: "end", speakId: 1 });
    await tick();
    engine.push(2, { type: "start", speakId: 2 });
    engine.push(2, { type: "end", speakId: 2 });
    await tick();
    expect(s.status().state).toBe("stopped");
  });

  it("an engine error before start parks paused with no highlight and no fake stop", async () => {
    const engine = new ScriptedEngine("web-speech");
    const events: SessionEvent[] = [];
    const s = await ReaderSession.load(engine, new MemoryStorage(), (ev) => events.push(ev));
    await s.start(TOKENS);
    await tick();

    // Voiceless-engine shape: the speak fails before any start/word event.
    engine.push(1, { type: "error", speakId: 1, message: "no speech voices available" });
    await tick();

    expect(events.filter((e) => e.type === "highlight")).toEqual([]);
    expect(s.status()).toMatchObject({ state: "paused", lastError: "no speech voices available" });
    expect(events).toContainEqual({
      type: "error",
      sessionId: expect.any(String),
      message: "no speech voices available",
    });
  });

  it("prefetches the next chunk while the current one plays (pipelining)", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    // chunk [0..2] is speaking; the engine should synthesize chunk [3..3] ahead.
    expect(engine.prefetches).toEqual([{ text: "Fourth sentence.", options: { voiceName: null, rate: 1 } }]);

    engine.finishCurrent();
    await tick();
    // Last chunk: nothing further to prefetch.
    expect(engine.prefetches).toHaveLength(1);
    expect(engine.speaks[1].text).toBe("Fourth sentence.");

    engine.finishCurrent();
    await tick();
    expect(s.status().state).toBe("stopped");
  });

  it("skips prefetch when the engine has no prefetch method", async () => {
    const { engine, emit } = makeSession();
    engine.prefetch = undefined;
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    expect(engine.prefetches).toHaveLength(0);

    engine.finishCurrent();
    await tick();
    engine.finishCurrent();
    await tick();
    expect(s.status().state).toBe("stopped");
  });

  it("fires prefetch only after the engine's start event (audio actually began)", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    // speak() handed chunk N to the engine first; chunk N+1 was prefetched
    // on the start event — never before the current chunk was spoken.
    expect(engine.callOrder).toEqual(["speak", "prefetch"]);
    expect(engine.prefetches).toEqual([{ text: "Fourth sentence.", options: { voiceName: null, rate: 1 } }]);
  });

  it("survives a prefetch rejection (fire-and-forget; speak() stays the fallback)", async () => {
    const { engine, emit } = makeSession();
    engine.prefetch = () => Promise.reject(new Error("synth exploded"));
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    expect(s.status()).toMatchObject({ state: "playing", lastError: null }); // rejection swallowed
    expect(engine.speaks).toHaveLength(1);

    engine.finishCurrent();
    await tick();
    expect(engine.speaks).toHaveLength(2); // next chunk still speaks normally
    engine.finishCurrent();
    await tick();
    expect(s.status().state).toBe("stopped");
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

  it("relays a chunk timeline for the visible page's local march (wordTiming engines only)", async () => {
    const timeline = {
      words: [
        { begin: 0, end: 3, t: 0 },
        { begin: 4, end: 9, t: 320 },
      ],
      anchorWall: 1_234,
      anchorClock: 0,
    };
    const { engine, events, emit } = makeSession(new FakeEngine({ wordTiming: true }));
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS);
    await tick();
    const id = s.status().sessionId;

    engine.pushTimeline(1, timeline);
    engine.finishCurrent();
    await tick();
    expect(events).toContainEqual({
      type: "highlight",
      sessionId: id,
      from: 0,
      to: 2,
      timeline,
    });

    // Engines without wordTiming: timeline is dropped like word events.
    const { engine: plain, events: plainEvents, emit: plainEmit } = makeSession(); // wordTiming false
    const s2 = await ReaderSession.load(plain, new MemoryStorage(), plainEmit);
    await s2.start(TOKENS);
    await tick();
    plain.pushTimeline(1, timeline);
    plain.finishCurrent();
    await tick();
    expect(plainEvents.filter((e) => e.type === "highlight" && "timeline" in e)).toEqual([]);
  });

  it("seek while playing cancels the current chunk and continues from the target", async () => {
    const { engine, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);
    await s.start(TOKENS); // speaking chunk [0..2]
    await tick();
    const id = s.status().sessionId;

    const status = await s.seek(3);
    await tick();
    expect(status).toMatchObject({ state: "playing", tokenPos: 3 });
    expect(engine.cancels).toBe(1);
    // The drive loop saw `cancelled`, left tokenPos alone, and re-spoke.
    expect(engine.speaks).toHaveLength(2);
    expect(engine.speaks[1].text).toBe("Fourth sentence.");
    expect(events).toContainEqual({ type: "highlight", sessionId: id, from: 3, to: 3 });

    engine.finishCurrent(); // drain the drive loop
    await tick();
    expect(s.status().state).toBe("stopped");
  });

  it("seek while paused moves the anchor and jumps the highlight without playback", async () => {
    const { engine, storage, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);
    await s.start(TOKENS);
    await tick();
    engine.finishCurrent();
    await tick();
    await s.pause();
    await tick();

    const status = await s.seek(0);
    await tick();
    expect(status).toMatchObject({ state: "paused", tokenPos: 0 });
    expect(engine.speaks).toHaveLength(2); // no new speak started
    expect(engine.cancels).toBe(1); // only pause's cancel
    expect(events).toContainEqual({ type: "highlight", sessionId: expect.any(String), from: 0, to: 2 });
    expect(events).toContainEqual({
      type: "state",
      status: expect.objectContaining({ state: "paused", tokenPos: 0 }),
    });
    const stored = storage.read(SESSION_KEY) as { state: string; tokenPos: number };
    expect(stored).toMatchObject({ state: "paused", tokenPos: 0 });
  });

  it("seek while stopped is a no-op", async () => {
    const { engine, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    const status = await s.seek(2);
    expect(status).toMatchObject({ state: "stopped", tokenPos: 0 });
    expect(engine.cancels).toBe(0);
    expect(engine.speaks).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("seek clamps out-of-range tokens into the scope", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);
    await s.start(TOKENS);
    await tick();

    await s.seek(999);
    await tick();
    expect(s.status().tokenPos).toBe(3);
    expect(engine.speaks.at(-1)?.text).toBe("Fourth sentence.");

    await s.seek(-10);
    await tick();
    expect(s.status().tokenPos).toBe(0);
    expect(engine.speaks.at(-1)?.text).toBe("First sentence.Second sentence.Third sentence.");

    engine.finishCurrent(); // drain the drive loop
    await tick();
    engine.finishCurrent();
    await tick();
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

  it("a voice-only prefs message re-derives the family from getVoices and pins it", async () => {
    const { engine, storage, emit } = makeSession();
    engine.voices = [
      { name: "browser-default", lang: "en-US", localService: true, family: "web-speech" },
      { name: "male-qn-qingse", lang: "zh-CN", localService: false, family: "minimax" },
    ];
    // Hub restarted on web-speech while stored prefs still say minimax —
    // exactly the post-restart drift the popup's omission used to preserve.
    await storage.set({ [PREFS_KEY]: { voiceName: null, rate: 1, engine: "minimax" } });
    const s = await ReaderSession.load(engine, storage, emit);
    engine.clearFamilyCalls(); // ignore load-time pinning

    await s.setPrefs({ voiceName: "male-qn-qingse" });
    expect(engine.selectFamilyCalls()).toEqual(["minimax"]);
    expect(s.status().settings.engine).toBe("minimax");
    const prefs = storage.read(PREFS_KEY) as { engine: string | null };
    expect(prefs.engine).toBe("minimax");
  });

  it("voice-only prefs with an unknown voice leave routing untouched (no key case)", async () => {
    const { engine, storage, emit } = makeSession();
    engine.voices = []; // e.g. minimax key absent → its voices list is empty
    const s = await ReaderSession.load(engine, storage, emit);

    await s.setPrefs({ voiceName: "some-minimax-id" });
    expect(engine.selectFamilyCalls()).toEqual([]);
  });

  it("start() re-pins the stored engine family after a background restart", async () => {
    const { engine, storage, emit } = makeSession();
    await storage.set({ [PREFS_KEY]: { voiceName: "male-qn-qingse", rate: 1, engine: "minimax" } });
    const s = await ReaderSession.load(engine, storage, emit);
    engine.clearFamilyCalls(); // load-time pin verified separately

    // First read of a freshly-hydrated background: speak must not race the
    // pin — selectFamily precedes the drive loop.
    await s.start(TOKENS);
    await tick();
    expect(engine.selectFamilyCalls()).toEqual(["minimax"]);
    expect(engine.speaks[0]?.options.voiceName).toBe("male-qn-qingse");

    engine.finishCurrent(); // drain both chunks
    await tick();
    engine.finishCurrent();
    await tick();
  });

  it("prefs live in the durable store when one is provided (survives restarts)", async () => {
    const { engine, emit } = makeSession();
    const sessionStore = new MemoryStorage();
    const prefsStore = new MemoryStorage();
    const s = await ReaderSession.load(engine, sessionStore, emit, prefsStore);

    await s.setPrefs({ voiceName: "male-qn-qingse", engine: "minimax" });
    expect((prefsStore.read(PREFS_KEY) as { voiceName: string }).voiceName).toBe("male-qn-qingse");
    expect(sessionStore.read(PREFS_KEY)).toBeUndefined(); // nothing leaked into session scope

    // Simulated browser restart: a new session hydrates the choice and pins
    // the family on load.
    const engine2 = new FakeEngine();
    engine2.voices = [
      { name: "male-qn-qingse", lang: "zh-CN", localService: false, family: "minimax" },
    ];
    const s2 = await ReaderSession.load(engine2, new MemoryStorage(), emit, prefsStore);
    expect(s2.status().settings.voiceName).toBe("male-qn-qingse");
    expect(engine2.selectFamilyCalls()).toEqual(["minimax"]);
  });

  // --- T16: per-URL resume (start anchors, snapshot, url persistence) ---

  it("start with resumeAt begins playback at the saved token", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    const status = await s.start(TOKENS, { resumeAt: 3 });
    await tick();
    expect(status).toMatchObject({ state: "playing", tokenPos: 3 });
    expect(engine.speaks[0].text).toBe("Fourth sentence."); // speaks from the anchor

    engine.finishCurrent(); // drain the drive loop
    await tick();
    expect(s.status().state).toBe("stopped");
  });

  it("start defaults resumeAt to 0 and clamps out-of-range anchors", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);

    await s.start(TOKENS, { resumeAt: 999 });
    await tick();
    expect(s.status().tokenPos).toBe(3);
    expect(engine.speaks[0].text).toBe("Fourth sentence.");

    await s.stop();
    await tick();
    await s.start(TOKENS, {});
    await tick();
    expect(s.status().tokenPos).toBe(0);

    engine.finishCurrent(); // drain
    await tick();
  });

  it("snapshot exposes tokens/position/settings/url and is null when stopped", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);
    expect(s.snapshot()).toBeNull(); // stopped

    await s.start(TOKENS, { url: "https://example.com/a?q=1", resumeAt: 1 });
    await tick();
    const snap = s.snapshot();
    expect(snap).toMatchObject({ tokens: TOKENS, tokenPos: 1, url: "https://example.com/a?q=1" });
    expect(snap!.settings).toEqual({ voiceName: null, rate: 1, engine: null });

    await s.pause();
    const paused = s.snapshot();
    // Pause rewinds to the chunk anchor (chunk [0..2] was speaking).
    expect(paused).toMatchObject({ tokenPos: 0, url: "https://example.com/a?q=1" });

    await s.stop();
    await tick();
    expect(s.snapshot()).toBeNull();
  });

  it("persists the session url through storage.session and hydrates it", async () => {
    const { engine, storage } = makeSession();
    const s1 = await ReaderSession.load(engine, storage, () => {});
    await s1.start(TOKENS, { url: "https://example.com/a?q=1" });
    expect((storage.read(SESSION_KEY) as { url: string | null }).url).toBe("https://example.com/a?q=1");

    // Owner-vanished hydrate: the url rides along with the stored session.
    const s2 = await ReaderSession.load(engine, storage, () => {});
    expect(s2.status()).toMatchObject({ state: "paused", url: "https://example.com/a?q=1" });
    await s1.pause(); // silence the old instance's drive loop (shared engine)
  });

  // --- T17: actionable engine errors ---

  it("parks paused with lastError + a session error event on engine failure", async () => {
    const { engine, storage, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, storage, emit);
    await s.start(TOKENS);
    await tick();
    const id = s.status().sessionId;

    engine.failCurrent("voice quota exhausted");
    await tick();

    const status = s.status();
    expect(status).toMatchObject({ state: "paused", tokenPos: 0, lastError: "voice quota exhausted" });
    // The persisted record keeps the failed chunk as the safe resume anchor.
    expect(storage.read(SESSION_KEY)).toMatchObject({ state: "paused", tokenPos: 0 });
    expect(events).toContainEqual({ type: "error", sessionId: id, message: "voice quota exhausted" });

    // resume clears the transient error and retries from the anchor.
    await s.resume();
    await tick();
    expect(s.status()).toMatchObject({ state: "playing", lastError: null });
    expect(engine.speaks.at(-1)?.text).toBe("First sentence.Second sentence.Third sentence.");

    engine.finishCurrent(); // drain
    await tick();
    await s.stop();
  });

  it("start clears lastError from a previous failure", async () => {
    const { engine, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);
    await s.start(TOKENS);
    await tick();
    engine.failCurrent("boom");
    await tick();
    expect(s.status().lastError).toBe("boom");

    await s.start(TOKENS); // new session, fresh error state
    await tick();
    expect(s.status().lastError).toBeNull();
    engine.finishCurrent(); // drain
    await tick();
    await s.stop();
  });

  it("catches a throwing engine and surfaces lastError + error event", async () => {
    const { engine, events, emit } = makeSession();
    const s = await ReaderSession.load(engine, new MemoryStorage(), emit);
    const originalSpeak = engine.speak;
    engine.speak = () => {
      throw new Error("transport down");
    };

    await s.start(TOKENS);
    await tick();
    expect(s.status()).toMatchObject({ state: "paused", lastError: "transport down" });
    expect(events).toContainEqual({ type: "error", sessionId: expect.any(String), message: "transport down" });

    engine.speak = originalSpeak; // restore so the next start runs normally
    await s.start(TOKENS);
    await tick();
    expect(s.status()).toMatchObject({ state: "playing", lastError: null });
    engine.finishCurrent(); // drain
    await tick();
    await s.stop();
  });
});
describe("start() override hygiene (live Firefox NaN-rate bug)", () => {
  it("explicit undefined overrides do not erase prefs", async () => {
    const { engine, storage, emit } = makeSession();
    await storage.set({ [PREFS_KEY]: { voiceName: "v", rate: 0.9, engine: null } });
    const s = await ReaderSession.load(engine, storage, emit);
    // Mirrors handleReaderStart passing {voiceName: undefined, rate: undefined}.
    const st = await s.start(TOKENS, { url: "https://x.test/a" });
    expect(st.settings.rate).toBe(0.9);
    expect(st.settings.voiceName).toBe("v");
    // Real overrides still win.
    const st2 = await s.start(TOKENS, { rate: 1.5 });
    expect(st2.settings.rate).toBe(1.5);
  });
});
