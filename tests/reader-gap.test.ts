// SPDX-License-Identifier: MPL-2.0
/**
 * Gap-closing tests for the reader lane (2026-09 coverage sweep):
 *
 * - ReaderSession: start/pause/resume/seek state guards, the superseded-
 *   drive generation check, non-Error throw parking, voiceLang failure,
 *   prefs live-apply paths, and the legacy stored-session merge.
 * - token-index: heading-echo walk branches (multi-part headings, empty
 *   headings, same-block continuation), piece merging across text nodes in
 *   one block, blank cut remainders, and the selection helpers.
 * - highlight: registry-routed word layer, headless-document style fallback.
 *
 * Untestable lines (defensive, commented here as the record):
 * - src/reader/sentences.ts:75 `if (end <= start) return;` — Intl.Segmenter
 *   never emits zero-length segments, so push() can never see end <= start.
 * - src/reader/session.ts:537 persist()'s `sessionId === null` early return —
 *   every persist() caller runs only while a session id exists.
 * - src/reader/session.ts:566 newId()'s Date.now fallback — Node ≥ 19 always
 *   has crypto.randomUUID (the branch guards exotic runtimes only).
 * - src/reader/token-index.ts:312-313/322-323/339 clamp fallbacks — the text
 *   parts tile [0, full.length] exactly, so a piece offset can never fall
 *   past the last part.
 * - src/reader/token-index.ts:394/405 ownerDocOf-null guards — non-Document
 *   nodes always carry an ownerDocument per spec.
 * - src/reader/token-index.ts:243 `continue` (not the block start) — every
 *   part inside a heading element is itself heading-tagged, so a heading
 *   part can never be followed by a same-block non-heading part.
 * - src/reader/session.ts:457/471 `if (id)` false sides — an error park only
 *   happens while playing, which implies a live session id.
 */
import { describe, expect, it, vi } from "vitest";
import { EventStream } from "../src/reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../src/reader/contract";
import { ReaderSession, SESSION_KEY, type SessionEvent, type SessionStorage } from "../src/reader/session";
import { sentenceSpans, wordSpans } from "../src/reader/sentences";
import { tokenIndexFromRange, tokenIndexFromSelection, wordIndexFromRange, wordIndexFromSelection } from "../src/reader/token-index";
import { clearHighlight, ensureHighlightStyle, setHighlight, setWordHighlight } from "../src/content/highlight";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- harness ------------------------------------------------------------------

class GapEngine implements TextEngine {
  readonly family = "gap";
  capabilities: EngineCapabilities = { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" };
  voices: VoiceInfo[] = [];
  voicesError: Error | null = null;
  familyCalls: string[] = [];
  cancels = 0;
  /** When set, speak() returns this instead of the default instant stream. */
  speakImpl: ((text: string, speakId: number) => AsyncIterable<EngineEvent>) | null = null;
  /** Throw this (as-is) from speak(). */
  speakThrow: unknown = null;

  selectFamily(family: string): void {
    this.familyCalls.push(family);
  }
  getVoices(): Promise<VoiceInfo[]> {
    if (this.voicesError) return Promise.reject(this.voicesError);
    return Promise.resolve(this.voices);
  }
  speak(text: string, speakId: number, _options: SpeakOptions): AsyncIterable<EngineEvent> {
    if (this.speakThrow !== null) {
      const thrown = this.speakThrow;
      // An async generator that throws on iteration — the drive loop's
      // for-await surfaces it as a thrown value (not a stream error event).
      return (async function* () {
        throw thrown;
      })() as AsyncIterable<EngineEvent>;
    }
    if (this.speakImpl) return this.speakImpl(text, speakId);
    // Default: instant start/end, like a voiceless engine that finishes at once.
    const stream = new EventStream<EngineEvent>();
    queueMicrotask(() => {
      stream.push({ type: "start", speakId });
      stream.push({ type: "end", speakId });
      stream.close();
    });
    return stream;
  }
  cancel(): void {
    this.cancels += 1;
  }
}

interface MemStorage extends SessionStorage {
  sets: Array<Record<string, unknown>>;
  /** When true, every set() parks on the gate until release() (drive/persist interleaving tests). */
  gated: boolean;
  gate: Array<(v: undefined) => void>;
  release(): void;
}
function memStorage(): MemStorage {
  const map: Record<string, unknown> = {};
  const storage: MemStorage = {
    sets: [],
    gated: false,
    gate: [],
    async get(key: string) {
      return key in map ? { [key]: map[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      storage.sets.push(items);
      Object.assign(map, items);
      if (storage.gated) await new Promise<undefined>((r) => storage.gate.push(r));
    },
    async remove(key: string) {
      delete map[key];
    },
    release() {
      const g = storage.gate;
      storage.gate = [];
      for (const r of g) r(undefined);
    },
  };
  return storage;
}

async function makeSession(engine: GapEngine, storage = memStorage()) {
  const events: SessionEvent[] = [];
  const session = await ReaderSession.load(engine, storage, (ev) => events.push(ev));
  return { session, events, storage };
}
const tokens = (...texts: string[]): Array<{ text: string; blockStart?: boolean }> =>
  texts.map((text) => ({ text, blockStart: true })); // one block each → one chunk per token

// --- session guards --------------------------------------------------------------

describe("ReaderSession gaps", () => {
  it("start() rejects an empty scope", async () => {
    const { session } = await makeSession(new GapEngine());
    await expect(session.start([])).rejects.toThrow("empty read scope");
  });

  it("pause()/resume()/seek() are no-ops outside their live states", async () => {
    const { session, storage } = await makeSession(new GapEngine());
    const before = session.status();
    expect(await session.pause()).toEqual(before); // paused→? no: stopped → early return
    expect(await session.resume()).toEqual(before); // stopped → early return
    expect(await session.seek(3)).toEqual(before); // stopped → early return
    expect(storage.sets).toHaveLength(0);
  });

  it("resume() while playing is a no-op", async () => {
    const engine = new GapEngine();
    engine.speakImpl = () => new EventStream<EngineEvent>() as AsyncIterable<EngineEvent>; // never ends
    const { session } = await makeSession(engine);
    await session.start(tokens("a.", "b."));
    const playing = session.status();
    expect(await session.resume()).toEqual(playing); // playing → early return
    await session.pause();
  });

  it("seek() ignores non-finite targets", async () => {
    const engine = new GapEngine();
    engine.speakImpl = () => new EventStream<EngineEvent>() as AsyncIterable<EngineEvent>;
    const { session, storage } = await makeSession(engine);
    await session.start(tokens("a.", "b."));
    const sets = storage.sets.length;
    expect(await session.seek(Number.NaN)).toEqual(session.status()); // non-finite → early return
    expect(storage.sets).toHaveLength(sets);
    await session.pause();
  });

  it("voiceLang() resolves the selected voice's lang and null on failure", async () => {
    const engine = new GapEngine();
    engine.voices = [{ name: "V", lang: "fr-FR", localService: false, family: "gap" }];
    const { session } = await makeSession(engine);
    await session.start(tokens("a."), { voiceName: "V" });
    expect(await session.voiceLang()).toBe("fr-FR");

    engine.voicesError = new Error("voices down");
    expect(await session.voiceLang()).toBeNull(); // catch → null
    engine.voicesError = null;
    await session.pause();
  });

  it("setPrefs persists into the live session and re-routes engine/voice families", async () => {
    const engine = new GapEngine();
    engine.speakImpl = () => new EventStream<EngineEvent>() as AsyncIterable<EngineEvent>;
    engine.voices = [{ name: "v3", lang: "en", localService: false, family: "fam3" }];
    const { session } = await makeSession(engine);
    await session.start(tokens("a.", "b.")); // state = playing → live-apply persists

    await session.setPrefs({ rate: 1.5 }); // live-apply → session persisted
    expect(await session.voiceLang()).toBeNull(); // voice not selected → null

    await session.setPrefs({ engine: "minimax" });
    expect(engine.familyCalls).toContain("minimax");

    await session.setPrefs({ voiceName: "v3" }); // voice → derived family
    expect(engine.familyCalls).toContain("fam3");

    const status = session.status();
    expect(status.settings.rate).toBe(1.5);
    expect(status.settings.engine).toBe("fam3");
    await session.pause();
  });

  it("a superseded drive generation exits the loop instead of double-speaking", async () => {
    const engine = new GapEngine();
    const storage = memStorage();
    storage.gated = true; // every persist parks — lets the test interleave two drives
    const { session } = await makeSession(engine, storage);
    // start#1: its persist gates; the drive loop then parks on the gated persist.
    const p1 = session.start(tokens("a.", "b."));
    await tick();
    storage.release();
    await p1;
    await tick(); // drive#1 reached chunk 1's persist (gated)
    const p2 = session.start(tokens("c.", "d.")); // supersedes drive#1 (gen bump, still playing)
    await tick();
    storage.release(); // drive#1's persist resolves → loop wakes → gen mismatch → return
    await p2;
    // Let drive#2 finish (its persists gate too).
    for (let i = 0; i < 6 && session.status().state === "playing"; i += 1) {
      storage.release();
      await tick();
    }
    expect(session.status().state).toBe("stopped");
    expect(session.status().sessionId).toBeNull();
  });

  it("parks paused with a non-Error throw surfaced as lastError", async () => {
    const engine = new GapEngine();
    engine.speakThrow = "transport string failure"; // not an Error → String(err) branch
    const { session, events } = await makeSession(engine);
    await session.start(tokens("a."));
    await tick();
    const status = session.status();
    expect(status.state).toBe("paused");
    expect(status.lastError).toBe("transport string failure");
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", message: "transport string failure" });
  });

  it("load() merges a legacy stored session without settings and cancels stale playback", async () => {
    const engine = new GapEngine();
    const storage = memStorage();
    await storage.set({
      [SESSION_KEY]: {
        sessionId: "legacy-1",
        state: "playing", // owner died mid-play → load cancels the platform audio
        tokenPos: 2,
        tokens: tokens("a.", "b.", "c."),
        url: "https://example.test/article",
        updatedAt: 1,
        // no `settings` — the legacy shape under test
      },
    });
    const events: SessionEvent[] = [];
    const session = await ReaderSession.load(engine, storage, (ev) => events.push(ev));
    expect(engine.cancels).toBe(1);
    const status = session.status();
    expect(status.state).toBe("paused");
    expect(status.sessionId).toBe("legacy-1");
    expect(status.tokenPos).toBe(2);
    // Legacy sessions predate settings fields — defaults merged in.
    expect(status.settings).toEqual({ voiceName: null, rate: 1, engine: null });
    expect(events.some((e) => e.type === "state")).toBe(true);
  });

  it("pause() with no in-flight chunk anchors on tokenPos (?? branch)", async () => {
    const engine = new GapEngine();
    const storage = memStorage();
    storage.gated = true;
    const { session } = await makeSession(engine, storage);
    const p = session.start(tokens("a.", "b."));
    await tick();
    storage.release();
    await p;
    await tick(); // drive#1: chunk 1 done (start+end consumed), persist gated, currentChunk nulled
    const pausedPromise = session.pause(); // ?? branch evaluated synchronously before pause's own gated persist
    storage.release();
    const paused = await pausedPromise;
    expect(paused.state).toBe("paused");
    expect(paused.tokenPos).toBe(1); // anchor stayed at the completed chunk's start
  });
});

// --- token-index gaps --------------------------------------------------------------

describe("token-index gaps", () => {
  it("heading echo walk: multi-part headings, same-block continuation, empty headings", () => {
    document.body.innerHTML =
      "<h1>Intro <em>bit</em></h1>" + // two parts in one heading block
      "<p>Intro bit and more body text. Second sentence here.</p>" +
      "<h2>\u00a0</h2>" + // whitespace-only heading → empty echo text → skipped
      "<p>Tail sentence with fresh words.</p>";
    const doc = document;
    const body = doc.body;
    const range = doc.createRange();
    range.setStart(body, 0);
    range.setEnd(body, body.childNodes.length);

    const toks = tokenIndexFromRange(range);
    const texts = toks.map((t) => t.text);
    // The heading survives as its own token; its echo is CUT from the paragraph text.
    expect(texts[0]).toBe("Intro bit");
    expect(texts[1]).toBe(" and more body text. ");
    // The whitespace-only heading contributes nothing readable.
    expect(texts.some((t) => t.includes("\u00a0"))).toBe(false);
    expect(texts).toContain("Tail sentence with fresh words.");
  });

  it("merges pieces across text nodes within one block (single token)", () => {
    document.body.innerHTML = "<p id='m'>a <em>b</em> c.</p>";
    const p = document.getElementById("m")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const toks = tokenIndexFromRange(range);
    // "a b c." spans three text nodes but one block → one merged piece.
    expect(toks.map((t) => t.text)).toEqual(["a b c."]);
    for (const t of toks) expect(t.range.toString()).toBe(t.text);
  });

  it("drops whitespace-only cut remainders at block boundaries", () => {
    document.body.innerHTML = "<p>hi</p> <p>there</p>";
    const body = document.body;
    const range = document.createRange();
    range.setStart(body, 0);
    range.setEnd(body, body.childNodes.length);
    const toks = tokenIndexFromRange(range);
    // The body-text-node space between the paragraphs is its own piece → blank → dropped.
    expect(toks.map((t) => t.text)).toEqual(["hi", "there"]);
  });

  it("wordIndexFromRange returns null over whitespace-only ranges", () => {
    document.body.innerHTML = "<p>   </p>";
    const p = document.body.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(p.firstChild!);
    expect(wordIndexFromRange(range, "en")).toBeNull();
  });

  it("selection helpers: null for collapsed/empty selections, word index otherwise", () => {
    document.body.innerHTML = "<p id='s'>Leia reads aloud.</p>";
    const p = document.getElementById("s")!;
    const range = document.createRange();
    range.selectNodeContents(p);

    const win = (sel: unknown): Window => ({ getSelection: () => sel }) as unknown as Window;

    // Early-return guards for BOTH selection helpers (no selection / collapsed).
    expect(wordIndexFromSelection(win({ rangeCount: 0 }), "en")).toBeNull();
    expect(wordIndexFromSelection(win({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range }), "en")).toBeNull();
    expect(tokenIndexFromSelection(win({ rangeCount: 0 }))).toBeNull();
    expect(tokenIndexFromSelection(win({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range }))).toBeNull();
    // A range over whitespace-only text yields no tokens → null (detached tree).
    const blankWrap = document.createElement("div");
    blankWrap.innerHTML = "<span>   </span>";
    const blank = document.createRange();
    blank.selectNodeContents(blankWrap.firstChild!);
    expect(tokenIndexFromSelection(win({ rangeCount: 1, isCollapsed: false, getRangeAt: () => blank }))).toBeNull();

    const words = wordIndexFromSelection(win({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }), "en");
    expect(words!.locale).toBe("en");
    expect(words!.words.map((w) => w.text)).toEqual(["Leia", "reads", "aloud."]);
  });

  it("pure spans sanity for the word granularity used above", () => {
    expect(wordSpans("hi there", "en").map((s) => s.text)).toEqual(["hi", "there"]);
    expect(sentenceSpans("A. B.", "en").map((s) => s.text)).toEqual(["A. ", "B."]);
  });
});

// --- sentences gaps -----------------------------------------------------------------
// (sentences.ts:75 `if (end <= start) return;` is defensive — Intl.Segmenter never
// emits zero-length segments — and stays uncovered on purpose.)

describe("sentenceSpans long-sentence splitting", () => {
  it("splits a sentence longer than the cap at the last space within the cap", () => {
    const text = "word ".repeat(60).trim(); // 60 * 5 - 1 = 299 chars, no sentence punctuation
    const spans = sentenceSpans(text, "en", 250);
    expect(spans.length).toBeGreaterThan(1);
    // Every span respects the cap (whitespace split, never mid-word). The cut
    // space attaches to the FOLLOWING span (slice excludes the cut index).
    for (const s of spans) {
      expect(s.end - s.start).toBeLessThanOrEqual(250);
    }
    // Round trip: spans tile the original text exactly.
    expect(spans.map((s) => s.text).join("")).toBe(text);
  });

  it("hard-cuts an unbroken run longer than the cap (CJK-style, no spaces)", () => {
    const text = "字".repeat(300);
    const spans = sentenceSpans(text, "en", 100);
    expect(spans.map((s) => s.text).join("")).toBe(text);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(100);
    expect(spans.length).toBe(3);
  });

  it("drops whitespace-only split remainders (trailing whitespace after a cut)", () => {
    const text = `${"word ".repeat(60)} `; // trailing space → final remainder whitespace-only
    const spans = sentenceSpans(text, "en", 250);
    expect(spans.every((s) => s.text.trim().length > 0)).toBe(true);
    expect(spans.map((s) => s.text).join("")).toBe(text);
  });
});

// --- highlight gaps -----------------------------------------------------------------

describe("highlight gaps", () => {
  it("setWordHighlight is a no-op without a CSS.highlights registry (jsdom)", () => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(() => setWordHighlight(range)).not.toThrow();
    expect(() => setWordHighlight(null)).not.toThrow();
  });

  it("routes the word layer through the registry when CSS.highlights exists", () => {
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      ranges: unknown[];
      constructor(...ranges: unknown[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", FakeHighlight);
    try {
      const range = document.createRange();
      range.selectNodeContents(document.body);
      setWordHighlight(range);
      expect(registry.has("leia-word")).toBe(true);
      setWordHighlight(null);
      expect(registry.has("leia-word")).toBe(false);
      setHighlight([range]);
      expect(registry.has("leia-sentence")).toBe(true);
      clearHighlight();
      expect(registry.has("leia-sentence")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("styles land on documentElement for headless documents (no head/body)", () => {
    const xml = new DOMParser().parseFromString("<root/>", "text/xml");
    expect(() => ensureHighlightStyle(xml)).not.toThrow();
    const style = xml.documentElement.querySelector("style");
    expect(style).not.toBeNull();
  });

  it("sampleBackground walks up from a text-node ancestor of the highlighted range", () => {
    ensureHighlightStyle(document);
    const p = document.createElement("p");
    p.textContent = "background probe text";
    document.body.appendChild(p);
    const textNode = p.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 7); // commonAncestorContainer IS the text node
    expect(() => setHighlight([range])).not.toThrow();
    const style = document.getElementById("leia-highlight-style");
    expect(style?.textContent).toContain("::highlight(");
  });
});
