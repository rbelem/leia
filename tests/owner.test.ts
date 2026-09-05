// SPDX-License-Identifier: MPL-2.0
/**
 * Direct tests for the audio-owner seam (src/audio/owner.ts) — previously only
 * exercised vi.mock'd (imported for its side effects by offscreen/background
 * tests, never asserted on). Covered here: isChrome UA sniffing, the
 * ProxyEngine offscreen lifecycle (creation, single-doc reuse, error reset),
 * the capabilities/families caches with their bounded awaits, speak/cancel/
 * pushEvent routing, readProviderKey's storage shape, and both
 * resolveAudioEngine() branches (Chrome singleton vs Firefox EngineHub).
 *
 * Module state (ensuredOffscreen, minimaxClock, the proxy singleton) is reset
 * per test via vi.resetModules + a fresh dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, TextEngine, VoiceInfo } from "../src/reader/contract";

type ReplyListener = (msg: unknown) => unknown;

const state = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  /** Overrides the sendMessage reply per test; throws/rejects propagate. */
  reply: null as null | ((msg: Record<string, unknown>) => unknown),
  stored: {} as Record<string, unknown>,
  storageThrows: false,
  createDocumentError: null as Error | null,
  createDocumentCalls: 0,
  listeners: [] as ReplyListener[],
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: (msg: unknown) => {
        const m = msg as Record<string, unknown>;
        state.sent.push(m);
        if (state.reply) return Promise.resolve(state.reply(m)).then((r) => {
          if (r instanceof Error) throw r;
          return r;
        });
        return Promise.resolve({});
      },
      onMessage: { addListener: (fn: ReplyListener) => state.listeners.push(fn) },
    },
    storage: {
      local: {
        get: async (key: string) => {
          if (state.storageThrows) throw new Error("storage down");
          return { [key]: state.stored[key] };
        },
      },
    },
    offscreen: {
      createDocument: async () => {
        state.createDocumentCalls += 1;
        if (state.createDocumentError) throw state.createDocumentError;
      },
    },
  },
}));

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

type Owner = typeof import("../src/audio/owner");
let owner: Owner;

beforeEach(async () => {
  vi.resetModules();
  state.sent = [];
  state.reply = null;
  state.stored = {};
  state.storageThrows = false;
  state.createDocumentError = null;
  state.createDocumentCalls = 0;
  state.listeners = [];
  vi.stubGlobal("navigator", { userAgent: CHROME_UA });
  owner = await import("../src/audio/owner");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const collect = async (it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

describe("isChrome", () => {
  it("sniffs the UA: Chrome/Chromium true, Firefox false", async () => {
    expect(owner.isChrome()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: FIREFOX_UA });
    expect(owner.isChrome()).toBe(false);
  });
});

describe("ProxyEngine (Chrome offscreen proxy)", () => {
  it("resolveAudioEngine returns the shared proxy singleton on Chrome", () => {
    expect(owner.resolveAudioEngine()).toBe(owner.chromeAudioEngine());
  });

  it("getVoices creates the offscreen doc once, then reuses it", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = (msg) => (msg.type === "leia:audio:voices" ? [{ name: "v1", lang: "en-US" }] : {});
    expect(await engine.getVoices()).toEqual([{ name: "v1", lang: "en-US" }]);
    expect(await engine.getVoices()).toEqual([{ name: "v1", lang: "en-US" }]);
    expect(state.createDocumentCalls).toBe(1);
    expect(state.sent.map((m) => m.type)).toEqual(["leia:audio:voices", "leia:audio:voices"]);
    expect(state.sent[0]).toMatchObject({ type: "leia:audio:voices" });
  });

  it("swallows the one-offscreen-document-per-extension error and keeps the cached doc", async () => {
    state.createDocumentError = new Error("Only a single offscreen document may be created per extension.");
    state.reply = (msg) => (msg.type === "leia:audio:voices" ? [] : {});
    const engine = owner.chromeAudioEngine();
    await expect(engine.getVoices()).resolves.toEqual([]);
    // The ensured promise cached the "already exists" outcome — no retry.
    await expect(engine.getVoices()).resolves.toEqual([]);
    expect(state.createDocumentCalls).toBe(1);
    expect(state.sent.map((m) => m.type)).toEqual(["leia:audio:voices", "leia:audio:voices"]);
  });

  it("rethrows other offscreen errors and resets so the next call retries", async () => {
    state.createDocumentError = new Error("offscreen API unavailable");
    const engine = owner.chromeAudioEngine();
    await expect(engine.getVoices()).rejects.toThrow("offscreen API unavailable");
    await expect(engine.getVoices()).rejects.toThrow("offscreen API unavailable");
    expect(state.createDocumentCalls).toBe(2);
  });

  it("throws when the offscreen API namespace itself is missing (Chrome 109+ only)", async () => {
    // Strip browser.offscreen: ensureOffscreen must reject with its guidance error.
    const polyfill = await import("webextension-polyfill");
    const browserMock = (polyfill.default as unknown as Record<string, unknown>) as { offscreen?: unknown };
    const had = "offscreen" in browserMock;
    const saved = browserMock.offscreen;
    delete browserMock.offscreen;
    try {
      await expect(owner.chromeAudioEngine().getVoices()).rejects.toThrow("offscreen API unavailable");
    } finally {
      if (had) browserMock.offscreen = saved;
    }
  });

  it("capabilities: conservative default sync view, cached live reply after the round trip", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = (msg) =>
      msg.type === "leia:audio:capabilities"
        ? { wordTiming: true, streaming: false, costClass: "paid", privacyClass: "provider", maxUtteranceChars: 200 }
        : {};
    // First read: default view while the round trip is in flight (no cap yet).
    expect(engine.capabilities.wordTiming).toBe(false);
    expect("maxUtteranceChars" in engine.capabilities).toBe(false);
    await engine.awaitCapabilities();
    expect(engine.capabilities).toMatchObject({ wordTiming: true, maxUtteranceChars: 200 });
    // Cached: the second await resolves from cache without a new message.
    state.sent = [];
    await expect(engine.awaitCapabilities()).resolves.toMatchObject({ wordTiming: true });
    expect(state.sent).toEqual([]);
  });

  it("awaitCapabilities resolves to the default view when the round trip fails", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = () => new Error("receiving end does not exist");
    await expect(engine.awaitCapabilities()).resolves.toMatchObject({
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    });
  });

  it("awaitCapabilities time-boxes a wedged offscreen document", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = () => new Promise(() => {}); // never settles
    await expect(engine.awaitCapabilities(20)).resolves.toMatchObject({ wordTiming: false });
  });

  it("selectFamily resets the caches and forwards to the offscreen; failures are swallowed", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = (msg) => {
      if (msg.type === "leia:audio:capabilities") return { wordTiming: true, streaming: true, costClass: "paid", privacyClass: "provider" };
      if (msg.type === "leia:audio:families") return [{ family: "minimax", capabilities: { wordTiming: false, streaming: false, costClass: "paid", privacyClass: "provider" } }];
      return {};
    };
    await engine.awaitCapabilities();
    engine.families();
    await tick(); // the families kick is async (ensureOffscreen().then(...))
    expect(state.sent.map((m) => m.type)).toEqual(["leia:audio:capabilities", "leia:audio:families"]);

    state.sent = [];
    engine.selectFamily("minimax");
    await tick();
    expect(state.sent.map((m) => m.type)).toEqual(["leia:audio:family"]);
    // Caches were dropped: the next reads re-query (new messages).
    void engine.capabilities;
    engine.families();
    await tick();
    expect(state.sent.filter((m) => m.type === "leia:audio:capabilities")).toHaveLength(1);
    expect(state.sent.filter((m) => m.type === "leia:audio:families")).toHaveLength(1);

    // A failing family notification must not throw synchronously or reject.
    state.reply = () => new Error("gone");
    expect(() => engine.selectFamily("web-speech")).not.toThrow();
    await tick();
  });

  it("families() caches the offscreen reply across reads; failures resolve to []", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = (msg) => (msg.type === "leia:audio:families" ? [{ family: "web-speech", capabilities: { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" } }] : {});
    const first = engine.families(); // kicks the round trip, sync view is []
    await tick();
    const cached = engine.families();
    expect(cached).toEqual([{ family: "web-speech", capabilities: { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" } }]);
    expect(engine.families()).toBe(cached);
    expect(cached).not.toBe(first);
    expect(state.sent.filter((m) => m.type === "leia:audio:families")).toHaveLength(1);

    // A failing round trip on a fresh engine resolves to the empty fallback.
    vi.resetModules();
    owner = await import("../src/audio/owner");
    state.reply = () => new Error("receiving end does not exist");
    expect(owner.chromeAudioEngine().families()).toEqual([]);
    await tick();
  });

  it("speak forwards to the offscreen; pushEvent routes events by speakId and closes on terminal", async () => {
    const engine = owner.chromeAudioEngine();
    const iter = engine.speak("hello", 7, { voiceName: "V", rate: 1.5 });
    const done = collect(iter);
    await tick();
    expect(state.sent[0]).toMatchObject({
      type: "leia:audio:speak",
      speakId: 7,
      text: "hello",
      voiceName: "V",
      rate: 1.5,
    });

    engine.pushEvent({ type: "start", speakId: 7 });
    engine.pushEvent({ type: "end", speakId: 7 }); // terminal → closes
    engine.pushEvent({ type: "word", speakId: 7, begin: 0, end: 2 }); // after terminal — dropped
    engine.pushEvent({ type: "end", speakId: 99 }); // stale speakId — dropped
    expect(await done).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("surfaces a failing speak message as an error event on the stream", async () => {
    const engine = owner.chromeAudioEngine();
    state.reply = (msg) => (msg.type === "leia:audio:speak" ? new Error("receiving end does not exist") : {});
    const events = await collect(engine.speak("x", 1, { voiceName: null, rate: 1 }));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("receiving end") }]);
  });

  it("a newer speak preempts the older stream and sends the offscreen a cancel", async () => {
    const engine = owner.chromeAudioEngine();
    const first = collect(engine.speak("one", 1, { voiceName: null, rate: 1 }));
    await tick();
    const second = collect(engine.speak("two", 2, { voiceName: null, rate: 1 }));
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    // The cancel message rides along with the second speak message.
    expect(state.sent.map((m) => m.type)).toEqual(["leia:audio:speak", "leia:audio:cancel", "leia:audio:speak"]);
    engine.pushEvent({ type: "start", speakId: 2 });
    engine.pushEvent({ type: "end", speakId: 2 });
    expect(await second).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("cancel() closes the active stream and notifies the offscreen (idempotent when idle)", async () => {
    const engine = owner.chromeAudioEngine();
    engine.cancel(); // idle: no stream, message still sent (offscreen safety)
    const events = collect(engine.speak("x", 3, { voiceName: null, rate: 1 }));
    await tick();
    engine.cancel();
    expect(await events).toEqual([{ type: "cancelled", speakId: 3 }]);
    expect(state.sent.filter((m) => m.type === "leia:audio:cancel")).toHaveLength(2);
  });
});

describe("resolveAudioEngine (Firefox hub)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: FIREFOX_UA });
    // Fail the local-profile boot probes instantly (real loopback fetch would
    // stall on the 500ms abort per profile).
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline in tests");
    });
  });

  it("throws when speechSynthesis is unavailable", () => {
    expect(() => owner.resolveAudioEngine()).toThrow("speechSynthesis unavailable");
  });

  it("registers web-speech as the default family plus every provider family", async () => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [{ voiceURI: "sys", name: "System Voice", lang: "en-US", localService: true, default: true }],
      speak: () => {},
      cancel: () => {},
    });
    state.stored = { "leia:settings:minimaxKey": "mm-key" };
    const hub = owner.resolveAudioEngine() as TextEngine & {
      currentFamily: string | null;
      families: () => Array<{ family: string }>;
      selectFamily: (f: string) => void;
    };
    // audioClockMs: the Firefox branch wires the MiniMax media-clock probe.
    expect(owner.audioClockMs()).toBeNull();

    const voices = await hub.getVoices();
    const names = voices.map((v) => v.name);
    expect(names[0]).toBe("System Voice"); // default family first
    // MiniMax's curated voices appear (key present), kitten's static list too.
    expect(names).toContain("male-qn-qingse");
    expect(names).toContain("expr-voice-2-f");

    const families = hub.families().map((f) => f.family);
    expect(families).toEqual([
      "web-speech", "minimax", "elevenlabs", "azure", "openai", "xai", "mistral", "gemini", "kitten-local",
    ]);

    hub.selectFamily("minimax");
    expect(hub.currentFamily).toBe("minimax");
    const minimaxVoices = (await hub.getVoices()).filter((v) => v.family === "minimax");
    expect(minimaxVoices).toHaveLength(8);
  });

  it("readProviderKey: empty/missing values read as no key; storage failure tolerated", async () => {
    vi.stubGlobal("speechSynthesis", { getVoices: () => [], speak: () => {}, cancel: () => {} });
    const hubOf = (): TextEngine & { getVoices: () => Promise<VoiceInfo[]>; selectFamily: (f: string) => void } =>
      owner.resolveAudioEngine() as never;
    const minimaxVoicesOf = async (hub: ReturnType<typeof hubOf>): Promise<VoiceInfo[]> =>
      (await hub.getVoices()).filter((v) => v.family === "minimax");

    state.stored = { "leia:settings:minimaxKey": "" };
    let hub = hubOf();
    hub.selectFamily("minimax");
    expect(await minimaxVoicesOf(hub)).toEqual([]);

    state.storageThrows = true;
    hub = hubOf();
    hub.selectFamily("minimax");
    expect(await minimaxVoicesOf(hub)).toEqual([]);
  });
});
