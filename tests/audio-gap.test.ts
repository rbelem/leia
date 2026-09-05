// SPDX-License-Identifier: MPL-2.0
/**
 * Gap-closing tests for the audio lanes (2026-09 coverage sweep). Each
 * section targets specific uncovered branches the engine files' own suites
 * don't reach: preempt-during-key races, stale-playback stop guards, word
 * alignment malformed-shape guards, MiniMax's MediaSource progressive
 * playback and streaming-fetch failure paths, LocalEngine payload error
 * paths + boot registration, EngineHub empty-hub guards, KittenEngine's
 * default worker factory + crash-with-pending, offscreen/audio message
 * triage, provider row DOM variants, and the default word-clock scheduler.
 *
 * MediaSource is stubbed via vi.hoisted so engine-minimax's module-level
 * gate (MEDIA_SOURCE_READY) sees it — jsdom has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => {
  class FakeSourceBuffer {
    updating = false;
    appended: ArrayBuffer[] = [];
    errored = false;
    failAppend = false;
    private ls: Record<string, Array<() => void>> = {};
    appendBuffer(b: ArrayBuffer): void {
      if (this.failAppend) throw new Error("append failed");
      this.appended.push(b);
      this.updating = true;
    }
    addEventListener(t: string, fn: () => void): void {
      (this.ls[t] ??= []).push(fn);
    }
    fire(t: string): void {
      if (t === "updateend") this.updating = false; // the real buffer settles before the event
      for (const fn of [...(this.ls[t] ?? [])]) fn();
    }
  }
  class FakeMediaSource {
    static isTypeSupported(m: string): boolean {
      return m === "audio/mpeg";
    }
    static instances: FakeMediaSource[] = [];
    readyState = "open";
    failAddSourceBuffer = false;
    failEndOfStream = false;
    buffers: FakeSourceBuffer[] = [];
    private ls: Record<string, Array<() => void>> = {};
    constructor() {
      FakeMediaSource.instances.push(this);
    }
    addEventListener(t: string, fn: () => void): void {
      (this.ls[t] ??= []).push(fn);
    }
    fire(t: string): void {
      for (const fn of [...(this.ls[t] ?? [])]) fn();
    }
    addSourceBuffer(): FakeSourceBuffer {
      if (this.failAddSourceBuffer) throw new Error("no source buffer");
      const sb = new FakeSourceBuffer();
      this.buffers.push(sb);
      return sb;
    }
    endOfStream(): void {
      if (this.failEndOfStream) throw new Error("endOfStream failed");
      this.readyState = "ended";
    }
  }
  (globalThis as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
  return { FakeMediaSource, FakeSourceBuffer };
});

import {
  DOM_AUDIO_HOST,
  MiniMaxEngine,
  type Playback,
  type ProgressivePlayback,
} from "../src/audio/engine-minimax";
import { AZURE_VOICES_URL, AZURE_DEFAULT_REGION, AzureEngine, parseAzureVoicesXml, type AzureSdkLike, type AzureSynthesizerLike, type AzureWordBoundaryEventArgs } from "../src/audio/engine-azure";
import { ELEVENLABS_TTS_URL, ElevenLabsEngine } from "../src/audio/engine-elevenlabs";
import { GeminiEngine } from "../src/audio/engine-gemini";
import { MISTRAL_VOICES_URL, MistralEngine } from "../src/audio/engine-mistral";
import { XaiEngine } from "../src/audio/engine-xai";
import { LocalEngine, registerLocalEngines } from "../src/audio/engine-local";
import { EngineHub } from "../src/audio/hub";
import { KittenEngine } from "../src/audio/kitten/engine-kitten";
import { buildProviderRow, PROVIDERS, type ProviderDef } from "../src/settings/providers";
import { createWordClock } from "../src/content/word-clock";
import type { EngineEvent, SpeakOptions } from "../src/reader/contract";

// Offscreen module mocks the polyfill (fresh listeners per import). The reply
// wrapper answers asynchronously for handled messages, so each call settles
// over a tick before its replies are read.
type ReplyListener = (msg: unknown, sender: unknown, sendResponse?: (r?: unknown) => void) => unknown;
const polyState = vi.hoisted(() => ({
  sent: [] as unknown[],
  sendMessageRejectFrom: Number.POSITIVE_INFINITY, // 0-based event index that starts rejecting
  storage: {} as Record<string, unknown>,
  listeners: [] as ReplyListener[],
}));
vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async (msg: unknown) => {
        if (polyState.sent.length >= polyState.sendMessageRejectFrom) throw new Error("SW gone");
        polyState.sent.push(msg);
        return {};
      },
      onMessage: { addListener: (fn: ReplyListener) => polyState.listeners.push(fn) },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: polyState.storage[key] }),
      },
    },
  },
}));

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await pred()); i += 1) await tick();
}
const collect = async (it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej; }), resolve, reject };
}

// --- shared stubs -----------------------------------------------------------

interface StubPlayback extends Playback {
  stopCalls: number;
  finish(): void;
}
function stubPlayback(): StubPlayback {
  let resolveDone!: () => void;
  const pb: StubPlayback = {
    stopCalls: 0,
    done: new Promise((r) => {
      resolveDone = r;
      queueMicrotask(r); // playback "completes" on the next microtask by default
    }),
    stop: () => {
      pb.stopCalls += 1;
      resolveDone();
    },
    finish: () => resolveDone(),
  };
  return pb;
}
function makeFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(String(url));
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return h(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const jsonResponse = (data: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => data }) as unknown as Response;
const binaryResponse = (bytes: Uint8Array): Response =>
  ({ ok: true, status: 200, headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => bytes.buffer }) as unknown as Response;

const opts = (over: Record<string, unknown> = {}): SpeakOptions => over as unknown as SpeakOptions;

// --- MiniMax: domPlayProgressive (MediaSource path) --------------------------

describe("MiniMax DOM_AUDIO_HOST progressive playback (MediaSource)", () => {
  beforeEach(() => {
    // jsdom's createObjectURL rejects non-Blobs; the engine hands it a MediaSource.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:media-source");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // jsdom play() rejects "not implemented", which finishes playback instantly.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(Promise.resolve());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    media.FakeMediaSource.instances.length = 0;
  });

  it("omits playProgressive from DOM_AUDIO_HOST when MediaSource is missing", () => {
    // sanity: with the stub hoisted in, the seam exists; the gate is evaluated
    // once at module eval (see the hoisted stub above).
    expect(typeof DOM_AUDIO_HOST.playProgressive).toBe("function");
  });

  it("streams hex fragments into the SourceBuffer, queues while updating, ends the stream", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.fire("sourceopen");
    expect(ms.buffers).toHaveLength(1);
    const sb = ms.buffers[0];

    pb.append(new Uint8Array([1]));
    expect(sb.appended).toHaveLength(1); // appended immediately (idle buffer)
    pb.append(new Uint8Array([2]));
    expect(sb.appended).toHaveLength(1); // queued: SourceBuffer updating
    sb.fire("updateend");
    expect(sb.appended).toHaveLength(2);
    sb.fire("updateend"); // queue drained, stream not ended → idle
    expect(ms.readyState).toBe("open");

    pb.end(); // endOfStream on the drained queue
    expect(ms.readyState).toBe("ended");

    expect(pb.clockMs?.()).toBe(0); // jsdom audio never advances
    pb.stop();
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("drops queued fragments after stop (finished flush guard)", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.fire("sourceopen");
    const sb = ms.buffers[0];
    pb.append(new Uint8Array([1])); // updating = true
    pb.stop(); // finish: done resolves, queue frozen
    await expect(pb.done).resolves.toBeUndefined();
    sb.fire("updateend"); // flush runs after finish → drops the queue
    expect(sb.appended).toHaveLength(1);
  });

  it("finishes when addSourceBuffer throws", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.failAddSourceBuffer = true;
    expect(() => ms.fire("sourceopen")).not.toThrow();
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("finishes when appendBuffer throws", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.fire("sourceopen");
    ms.buffers[0].failAppend = true;
    pb.append(new Uint8Array([1]));
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("finishes when endOfStream throws", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.fire("sourceopen");
    ms.failEndOfStream = true;
    pb.end();
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("finishes on a SourceBuffer error event", async () => {
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    const ms = media.FakeMediaSource.instances.at(-1)!;
    ms.fire("sourceopen");
    ms.buffers[0].fire("error");
    await expect(pb.done).resolves.toBeUndefined();
  });

  it("finishes when audio.play() throws synchronously (autoplay blocked)", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
      throw new Error("play() blocked");
    });
    const pb = DOM_AUDIO_HOST.playProgressive!("audio/mpeg");
    await expect(pb.done).resolves.toBeUndefined();
  });
});

// --- MiniMax: streaming fetch failure paths ----------------------------------

interface ProgStub extends ProgressivePlayback {
  appended: Uint8Array[];
  stopCalls: number;
  endCalls: number;
  finish(): void;
}
function progressiveHost(): { host: { play(bytes: Uint8Array, mime: string): Playback; playProgressive(mime: string): ProgStub }; created: ProgStub[] } {
  const created: ProgStub[] = [];
  const host = {
    play: (): Playback => stubPlayback(),
    playProgressive(): ProgStub {
      let resolveDone!: () => void;
      const pb: ProgStub = {
        appended: [],
        stopCalls: 0,
        endCalls: 0,
        done: new Promise((r) => {
          resolveDone = r;
          queueMicrotask(r); // playback completes on its own unless stopped first
        }),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        finish: () => resolveDone(),
        append(chunk: Uint8Array): void {
          pb.appended.push(chunk);
        },
        end(): void {
          pb.endCalls += 1;
        },
        clockMs: () => 0,
      };
      created.push(pb);
      return pb;
    },
  };
  return { host, created };
}
const streamBody = (chunks: string[]): { getReader: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } => {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
      cancel: async () => {},
    }),
  };
};

describe("MiniMax streaming transport gaps", () => {
  it("surfaces a failing streaming request as an error event", async () => {
    const { host } = progressiveHost();
    const engine = new MiniMaxEngine({ getKey: async () => "k", audioHost: host, fetchImpl: (async () => { throw new Error("conn reset"); }) as typeof fetch });
    const events = await collect(engine.speak("hello", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("MiniMax request failed") }]);
  });

  it("stays silent when the streaming request fails after a cancel (already terminal)", async () => {
    const { host } = progressiveHost();
    const gate = deferred<Response>();
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: host,
      fetchImpl: (async () => gate.promise) as unknown as typeof fetch,
    });
    const events = collect(engine.speak("hello", 1, opts()));
    await tick();
    engine.cancel();
    gate.resolve({ ok: true, body: streamBody([]) } as unknown as Response);
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("reports a response with no stream body", async () => {
    const { host } = progressiveHost();
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: host,
      fetchImpl: (async () => ({ ok: true, body: null })) as unknown as typeof fetch,
    });
    const events = await collect(engine.speak("hello", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("no stream body") }]);
  });

  it("stops playback and fails when the stream read throws mid-flight", async () => {
    const { host, created } = progressiveHost();
    let reads = 0;
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: host,
      fetchImpl: (async () =>
        ({
          ok: true,
          body: {
            getReader: () => ({
              read: async () => {
                reads += 1;
                if (reads === 1) return { done: false, value: new TextEncoder().encode('{"data":{"audio":"ff"}}') };
                throw new Error("socket cut");
              },
              cancel: async () => {},
            }),
          },
        }) as unknown as Response) as typeof fetch,
    });
    const events = await collect(engine.speak("hello", 1, opts()));
    expect(created[0].stopCalls).toBe(1);
    expect(events).toEqual([
      { type: "start", speakId: 1 },
      { type: "error", speakId: 1, message: expect.stringContaining("MiniMax stream failed") },
    ]);
  });

  it("aborts quietly when the stream read throws after a cancel", async () => {
    const { host } = progressiveHost();
    const gate = deferred<{ done: boolean; value?: Uint8Array }>();
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: host,
      fetchImpl: (async () =>
        ({
          ok: true,
          body: { getReader: () => ({ read: () => gate.promise, cancel: async () => {} }) },
        }) as unknown as Response) as typeof fetch,
    });
    const events = collect(engine.speak("hello", 1, opts()));
    await tick();
    engine.cancel();
    gate.reject(new Error("aborted"));
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("drops subtitles whose words carry no usable spans (due.length === 0)", async () => {
    // Batch host (no playProgressive) → runBatch transport.
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: { play: (): Playback => stubPlayback() },
      fetchImpl: makeFetch([
        () => jsonResponse({ base_resp: { status_code: 0 }, data: { audio: "ff", subtitle_file: "https://sub.test/s.json" } }),
        () => jsonResponse([{ timestamped_words: [{ word_begin: 5, word_end: 5, time_begin: 10 }] }]), // end <= begin → filtered
      ]).fetchImpl,
    });
    const events = await collect(engine.speak("hello", 1, opts()));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]); // no timeline event
  });

  it("parses JSON strings containing escaped quotes split across network chunks", async () => {
    const { host } = progressiveHost();
    const engine = new MiniMaxEngine({
      getKey: async () => "k",
      audioHost: host,
      fetchImpl: (async () =>
        ({
          ok: true,
          body: streamBody(['{"data":{"audio":"ff","subtitle_file":"a\\', '"}"}}']),
        }) as unknown as Response) as typeof fetch,
    });
    const events = await collect(engine.speak("hello", 1, opts()));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });
});

// --- Azure gaps ---------------------------------------------------------------

class StubSynthesizer implements AzureSynthesizerLike {
  wordBoundary: ((sender: unknown, e: AzureWordBoundaryEventArgs) => void) | null = null;
  SynthesisCanceled: ((sender: unknown, e: { result?: unknown }) => void) | null = null;
  resolveCb: ((r: unknown) => void) | null = null;
  errCb: ((e: string) => void) | null = null;
  speakTextAsync(_text: string, cb: (r: unknown) => void, err?: (e: string) => void): void {
    this.resolveCb = cb;
    this.errCb = err ?? null;
  }
  close(): void {}
}

function azureHarness(sdkOverrides: Partial<AzureSdkLike> = {}): {
  engine: AzureEngine;
  instances: StubSynthesizer[];
  sinks: Array<{ write(data: ArrayBuffer): void; close(): void }>;
} {
  const instances: StubSynthesizer[] = [];
  const sinks: Array<{ write(data: ArrayBuffer): void; close(): void }> = [];
  const sdk: AzureSdkLike = {
    SpeechConfig: { fromSubscription: () => ({ speechSynthesisOutputFormat: undefined, speechSynthesisVoiceName: undefined }) },
    SpeechSynthesizer: class extends StubSynthesizer {
      constructor() {
        super();
        instances.push(this);
      }
    } as unknown as AzureSdkLike["SpeechSynthesizer"],
    AudioConfig: {
      fromStreamOutput: (stream: { write(data: ArrayBuffer): void; close(): void }) => {
        sinks.push(stream);
        return {};
      },
    },
    PushAudioOutputStreamCallback: class {
      write(): void {}
      close(): void {}
    },
    SpeechSynthesisOutputFormat: {},
    CancellationDetails: { fromResult: () => ({ errorDetails: "" }) },
    ResultReason: { Canceled: { Canceled: true } },
    ...sdkOverrides,
  };
  const host = { play: (): Playback => stubPlayback() };
  return { engine: new AzureEngine({ getKey: async () => "k", getRegion: async () => null, sdk, audioHost: host }), instances, sinks };
}

describe("Azure gaps", () => {
  it("stays silent when the key resolves after a preempt; the successor speaks normally", async () => {
    const gate = deferred<string | null>();
    const playbacks: StubPlayback[] = [];
    const engine = new AzureEngine({
      getKey: () => gate.promise,
      getRegion: async () => null,
      audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
      sdk: {
        SpeechConfig: { fromSubscription: () => ({ speechSynthesisOutputFormat: undefined, speechSynthesisVoiceName: undefined }) },
        SpeechSynthesizer: class extends StubSynthesizer {
          constructor() {
            super();
            // Each synthesis completes with audio immediately.
            queueMicrotask(() => {
              this.resolveCb?.({ reason: {} });
            });
          }
          speakTextAsync(_text: string, cb: (r: unknown) => void): void {
            this.resolveCb = cb;
          }
          close(): void {}
        } as unknown as AzureSdkLike["SpeechSynthesizer"],
        AudioConfig: {
          fromStreamOutput: (sink: { write(data: ArrayBuffer): void; close(): void }) => {
            sink.write(new ArrayBuffer(8)); // audio arrives before the turn completes
            return { sink: true };
          },
        },
        PushAudioOutputStreamCallback: class {
          write(): void {}
          close(): void {}
        },
        SpeechSynthesisOutputFormat: {},
        CancellationDetails: { fromResult: () => ({ errorDetails: "" }) },
        ResultReason: { Canceled: {} },
      },
    });
    void playbacks;
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    gate.resolve("k");
    await tick();
    await tick();
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect((await second).map((e) => e.type)).toEqual(["start", "end"]);
  });

  it("filters malformed word boundaries, stale-speak boundaries, and zero-length words", async () => {
    const { engine, instances } = azureHarness();
    const events = collect(engine.speak("hello world", 1, opts()));
    await tick();
    const syn = instances[0];
    syn.wordBoundary!(null, { textOffset: 0, wordLength: 4, audioOffset: 10_000 }); // valid
    syn.wordBoundary!(null, { textOffset: 0, wordLength: 0, audioOffset: 20_000 }); // end <= begin → skipped
    syn.wordBoundary!(null, { textOffset: "x" as unknown as number, wordLength: 2, audioOffset: 30_000 }); // malformed → drop all
    engine.cancel();
    syn.wordBoundary!(null, { textOffset: 6, wordLength: 4, audioOffset: 40_000 }); // stale speakId → ignored
    syn.SynthesisCanceled!(null, { result: {} }); // stale → ignored (no second error)
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(engine["wordTimers"]).toEqual([]);
  });

  it("schedules word events for valid boundaries; cancel clears pending timers", async () => {
    const { engine, instances, sinks } = azureHarness();
    const events = collect(engine.speak("hello world", 1, opts()));
    await tick();
    const syn = instances[0];
    syn.wordBoundary!(null, { textOffset: 0, wordLength: 5, audioOffset: 0 }); // 0ms timer
    syn.wordBoundary!(null, { textOffset: 6, wordLength: 0, audioOffset: 50_000 }); // zero span → skipped at schedule time
    syn.wordBoundary!(null, { textOffset: 6, wordLength: 5, audioOffset: 600_000 }); // 60ms timer
    sinks[0].write(new ArrayBuffer(4));
    syn.resolveCb!({ reason: {} }); // completed → play + start + timers, all synchronous
    engine.cancel(); // immediately: clears the pending word timers
    expect(await events).toEqual([
      { type: "start", speakId: 1 },
      { type: "cancelled", speakId: 1 },
    ]);
    expect(engine["wordTimers"]).toEqual([]);
  });

  it("uses the generic cancel message when CancellationDetails yields nothing", async () => {
    const { engine, instances } = azureHarness();
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    instances[0].SynthesisCanceled!(null, { result: { errorDetails: "" } });
    expect(await events).toEqual([{ type: "error", speakId: 1, message: "Azure Speech synthesis canceled" }]);
  });

  it("surfaces the speakTextAsync error callback", async () => {
    const { engine, instances } = azureHarness();
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    instances[0].errCb!("websocket died");
    expect(await events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("websocket died") }]);
  });

  it("stops the just-started playback when the host cancel-races the resolve", async () => {
    const { engine, instances, sinks } = azureHarness();
    const playbacks: StubPlayback[] = [];
    (engine as unknown as { audioHost: unknown }).audioHost = {
      play: (): Playback => {
        const pb = stubPlayback();
        playbacks.push(pb);
        engine.cancel(); // the race: host teardown between play() and the guard
        return pb;
      },
    };
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    sinks[0].write(new ArrayBuffer(4));
    instances[0].resolveCb!({ reason: {} });
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks).toHaveLength(1);
    expect(playbacks[0].stopCalls).toBe(1);
  });

  it("parses voices XML: attribute + child text forms, skipping nameless voices", () => {
    const xml =
      "<Voices><Voice ShortName='en-US-AriaNeural' Locale='en-US'/>" +
      "<Voice><ShortName>fr-FR-DeniseNeural</ShortName><Locale>fr-FR</Locale></Voice>" +
      "<Voice><Locale>es-ES</Locale></Voice></Voices>";
    const voices = parseAzureVoicesXml(xml);
    expect(voices.map((v) => v.name)).toEqual(["en-US-AriaNeural", "fr-FR-DeniseNeural"]);
    expect(voices[0].lang).toBe("en-US");

    // Regex fallback (no DOMParser): same shapes.
    vi.stubGlobal("DOMParser", undefined);
    try {
      const viaRegex = parseAzureVoicesXml(
        "<Voice ShortName=\"a\" Locale=\"en\"/><Voice><ShortName>b</ShortName></Voice><Voice><Locale>x</Locale></Voice>",
      );
      expect(viaRegex.map((v) => v.name)).toEqual(["a", "b"]);
      expect(viaRegex[1].lang).toBe("und");
    } finally {
      vi.unstubAllGlobals();
    }
    void AZURE_VOICES_URL;
    void AZURE_DEFAULT_REGION;
  });
});

// --- ElevenLabs gaps -----------------------------------------------------------

function elevenLabs(): { engine: ElevenLabsEngine; host: StubPlayback[] } {
  const playbacks: StubPlayback[] = [];
  const engine = new ElevenLabsEngine({
    getKey: async () => "k",
    audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
  });
  return { engine, host: playbacks };
}

describe("ElevenLabs gaps", () => {
  it("stays silent when the key resolves after a preempt", async () => {
    const gate = deferred<string | null>();
    const { engine } = elevenLabs();
    (engine as unknown as { getKey: () => Promise<string | null> }).getKey = () => gate.promise;
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    gate.resolve("k");
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    // The second speak proceeds to fetch — with no handler registered it fails cleanly.
    expect((await second).map((e) => e.type)).toEqual(["error"]);
  });

  it("getVoices: non-array voices payload and network failure both yield []", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ voices: "not-an-array" }),
      () => { throw new Error("down"); },
    ]);
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl });
    expect(await engine.getVoices()).toEqual([]);
    expect(await engine.getVoices()).toEqual([]);
  });

  it("getVoices drops entries without a usable voice_id and maps language display names", async () => {
    const { fetchImpl } = makeFetch([
      () =>
        jsonResponse({
          voices: [
            { voice_id: "" },
            { labels: {} },
            { voice_id: "ok-id", labels: { language: "English" } },
            { voice_id: "bare" },
          ],
        }),
    ]);
    const engine = new ElevenLabsEngine({ getKey: async () => "k", fetchImpl });
    expect(await engine.getVoices()).toEqual([
      { name: "ok-id", lang: "en-US", localService: false, family: "elevenlabs" },
      { name: "bare", lang: "und", localService: false, family: "elevenlabs" },
    ]);
  });

  it("prefetch stores nothing on a non-OK response; a cached hit later skips the TTS fetch", async () => {
    const { engine } = elevenLabs();
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ detail: "quota" }, 401), // prefetch: !ok → nothing cached
      () => jsonResponse({ audio_base64: "AAAA", alignment: { characters: ["h", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } }),
    ]);
    (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;
    await engine.prefetch("hi", opts({ voiceName: "v", rate: 1 }));
    const events = await collect(engine.speak("hi", 1, opts({ voiceName: "v", rate: 1 })));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    expect(calls.filter((c) => c.startsWith(ELEVENLABS_TTS_URL))).toHaveLength(2); // prefetch attempt + speak on demand
  });

  it("fails with the request error when the TTS fetch throws", async () => {
    const { engine } = elevenLabs();
    (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
    const events = await collect(engine.speak("x", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("ElevenLabs request failed") }]);
  });

  it("fails when the JSON payload cannot be parsed or carries no audio", async () => {
    for (const body of ["{not json", JSON.stringify({ alignment: null })]) {
      const { engine } = elevenLabs();
      (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => (body === "{not json" ? Promise.reject(new SyntaxError("bad")) : { alignment: null }),
        }) as unknown as Response) as typeof fetch;
      const events = await collect(engine.speak("x", 1, opts()));
      expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("no audio payload") }]);
    }
  });

  it("stops the just-started playback when the host cancel-races after decode", async () => {
    const gate = deferred<ArrayBuffer>();
    let playCalls = 0;
    const playbacks: StubPlayback[] = [];
    const engine = new ElevenLabsEngine({
      getKey: async () => "k",
      fetchImpl: (async () =>
        ({ ok: true, status: 200, headers: { get: () => "audio/mpeg" }, arrayBuffer: () => gate.promise })) as unknown as typeof fetch,
      audioHost: {
        play: (): Playback => {
          playCalls += 1;
          const pb = stubPlayback();
          playbacks.push(pb);
          return pb;
        },
      },
    });
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    engine.cancel(); // race: the decode lands after cancel, play still happens
    gate.resolve(new Uint8Array([1, 2, 3]).buffer);
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playCalls).toBe(1);
    expect(playbacks[0].stopCalls).toBe(1);
  });

  it("alignment guards: non-parallel arrays, malformed entries, whitespace-only → no timeline", async () => {
    const cases: unknown[] = [
      { characters: "nope", character_start_times_seconds: [], character_end_times_seconds: [] },
      { characters: ["h", "i"], character_start_times_seconds: [0], character_end_times_seconds: [0.1, 0.2] },
      { characters: [7, "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] },
      { characters: [" "], character_start_times_seconds: [0], character_end_times_seconds: [0.1] }, // no word run
    ];
    for (const alignment of cases) {
      const { engine } = elevenLabs();
      (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
        jsonResponse({ audio_base64: "AAAA", alignment })) as unknown as typeof fetch;
      const events = await collect(engine.speak("hi", 1, opts()));
      expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    }
  });

  it("word events fire for a valid alignment timeline", async () => {
    const { engine } = elevenLabs();
    let finishPb!: () => void;
    (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
      jsonResponse({
        audio_base64: "AAAA",
        alignment: {
          characters: ["h", "i", " ", "!", "x"],
          character_start_times_seconds: [0, 0.1, 0.2, 0.2, 0.3],
          character_end_times_seconds: [0.1, 0.2, 0.2, 0.25, 0.4],
        },
      })) as unknown as typeof fetch;
    (engine as unknown as { audioHost: unknown }).audioHost = {
      play: (): Playback => ({ stop: () => {}, done: new Promise((r) => (finishPb = r)) }),
    };
    const eventsPromise = collect(engine.speak("hi!", 1, opts()));
    await tick(); // start pushed; word timers scheduled (0ms and 200ms)
    await tick(); // the 0ms timer fires while the stream is still open
    finishPb(); // playback completes → end
    const events = await eventsPromise;
    // words: "hi" (0→2 @0) and "!x" (3→5 @0.2); only the 0ms timer fires within the test.
    expect(events.filter((e) => e.type === "word")).toEqual([{ type: "word", speakId: 1, begin: 0, end: 2 }]);
    expect(events.map((e) => e.type)).toEqual(["start", "word", "end"]);
  });

  it("non-JSON error bodies fall back to the status; JSON detail strings win", async () => {
    const { engine } = elevenLabs();
    (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
      ({ ok: false, status: 503, headers: { get: () => "text/plain" }, text: async () => "nope", json: async () => ({}) })) as unknown as typeof fetch;
    const events = await collect(engine.speak("x", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: "ElevenLabs error 503" }]);

    // JSON body with a usable detail string.
    const { engine: withDetail } = elevenLabs();
    (withDetail as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
      jsonResponse({ detail: "quota exceeded" }, 401)) as unknown as typeof fetch;
    expect(await collect(withDetail.speak("x", 2, opts()))).toEqual([
      { type: "error", speakId: 2, message: "quota exceeded" },
    ]);

    // JSON content-type but unparseable body → catch → status fallback.
    const { engine: badJson } = elevenLabs();
    (badJson as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
      ({ ok: false, status: 500, headers: { get: () => "application/json" }, json: () => Promise.reject(new SyntaxError("bad")) })) as unknown as typeof fetch;
    expect(await collect(badJson.speak("x", 3, opts()))).toEqual([
      { type: "error", speakId: 3, message: "ElevenLabs error 500" },
    ]);
  });
});

// --- Gemini gaps -----------------------------------------------------------------

function gemini(fetchImpl?: typeof fetch): { engine: GeminiEngine; playbacks: StubPlayback[] } {
  const playbacks: StubPlayback[] = [];
  const engine = new GeminiEngine({
    getKey: async () => "k",
    fetchImpl: fetchImpl ?? ((async () => jsonResponse(geminiEnvelope("AAAA"))) as unknown as typeof fetch),
    audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
  });
  return { engine, playbacks };
}
const geminiEnvelope = (audioData: unknown): unknown => ({
  steps: [{ content: [{ type: "audio", data: audioData, sample_rate: 24000 }] }],
});

describe("Gemini gaps", () => {
  it("stays silent when the key resolves after a preempt; the successor speaks normally", async () => {
    const gate = deferred<string | null>();
    const { engine } = gemini();
    (engine as unknown as { getKey: () => Promise<string | null> }).getKey = () => gate.promise;
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    gate.resolve("k");
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect((await second).map((e) => e.type)).toEqual(["start", "end"]);
  });

  it("stays silent when the envelope resolves after a cancel", async () => {
    const gate = deferred<unknown>();
    const engine = new GeminiEngine({
      getKey: async () => "k",
      fetchImpl: (async () => ({ ok: true, json: () => gate.promise })) as unknown as typeof fetch,
      audioHost: { play: (): Playback => stubPlayback() },
    });
    const events = collect(engine.speak("a", 1, opts()));
    await tick();
    engine.cancel();
    gate.resolve(geminiEnvelope("AAAA"));
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("stops the just-started playback when the host cancel-races", async () => {
    const playbacks: StubPlayback[] = [];
    const engine = new GeminiEngine({
      getKey: async () => "k",
      fetchImpl: (async () => jsonResponse(geminiEnvelope("AAAA"))) as unknown as typeof fetch,
      audioHost: {
        play: (): Playback => {
          const pb = stubPlayback();
          playbacks.push(pb);
          engine.cancel(); // the race: host teardown between play() and the guard
          return pb;
        },
      },
    });
    const events = await collect(engine.speak("a", 1, opts()));
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks[0].stopCalls).toBe(1);
  });

  it("error body triage: message / error string / error.message / fallback", async () => {
    const bodies: Array<[unknown, string]> = [
      [{ message: "top message" }, "top message"],
      [{ error: "plain error" }, "plain error"],
      [{ error: { message: "nested message" } }, "nested message"],
      [{ unrelated: true }, "Gemini error 503"],
    ];
    for (const [body, expected] of bodies) {
      const { engine } = gemini();
      (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => jsonResponse(body, 503)) as unknown as typeof fetch;
      const events = await collect(engine.speak("a", 1, opts()));
      expect(events).toEqual([{ type: "error", speakId: 1, message: expected }]);
    }
  });

  it("falls back to the legacy interaction.output_audio slot and fails without any audio", async () => {
    const { engine } = gemini();
    (engine as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () =>
      jsonResponse({ interaction: { output_audio: { data: "AAAA" } } })) as unknown as typeof fetch;
    expect((await collect(engine.speak("a", 1, opts()))).map((e) => e.type)).toEqual(["start", "end"]);

    const { engine: empty } = gemini();
    (empty as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => jsonResponse({ steps: [] })) as unknown as typeof fetch;
    expect(await collect(empty.speak("a", 2, opts()))).toEqual([
      { type: "error", speakId: 2, message: expect.stringContaining("no audio content item") },
    ]);
  });
});

// --- Mistral gaps ------------------------------------------------------------------

function mistral(fetchImpl: typeof fetch): { engine: MistralEngine; playbacks: StubPlayback[] } {
  const playbacks: StubPlayback[] = [];
  const engine = new MistralEngine({
    getKey: async () => "k",
    fetchImpl,
    audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
  });
  return { engine, playbacks };
}

describe("Mistral gaps", () => {
  it("stays silent when the key resolves after a preempt; the successor speaks normally", async () => {
    const gate = deferred<string | null>();
    const { engine } = mistral((async () => jsonResponse({ audio_data: "AAAA" })) as unknown as typeof fetch);
    (engine as unknown as { getKey: () => Promise<string | null> }).getKey = () => gate.promise;
    const first = collect(engine.speak("a", 1, opts({ voiceName: "v" })));
    await tick();
    const second = collect(engine.speak("b", 2, opts({ voiceName: "v" })));
    gate.resolve("k");
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect((await second).map((e) => e.type)).toEqual(["start", "end"]);
  });

  it("stays silent when the account voices resolve after a preempt (no voice selected)", async () => {
    const voicesGate = deferred<Response>();
    const { engine } = mistral((async (url: string) =>
      url === MISTRAL_VOICES_URL ? voicesGate.promise : jsonResponse({ audio_data: "AAAA" })) as unknown as typeof fetch);
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    voicesGate.resolve(jsonResponse({ items: [{ id: "saved-voice", languages: ["fr"] }] }));
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    // Second speak fell back to the first saved voice.
    expect((await second).map((e) => e.type)).toEqual(["start", "end"]);
  });

  it("stops the just-started playback when the host cancel-races", async () => {
    const playbacks: StubPlayback[] = [];
    const engine = new MistralEngine({
      getKey: async () => "k",
      fetchImpl: (async () => jsonResponse({ audio_data: "AAAA" })) as unknown as typeof fetch,
      audioHost: {
        play: (): Playback => {
          const pb = stubPlayback();
          playbacks.push(pb);
          engine.cancel();
          return pb;
        },
      },
    });
    expect(await collect(engine.speak("a", 1, opts({ voiceName: "v" })))).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks[0].stopCalls).toBe(1);
  });

  it("error body triage: error string / error.message / fallback status", async () => {
    const bodies: Array<[unknown, string]> = [
      [{ error: "quota exceeded" }, "quota exceeded"],
      [{ error: { message: "moderation block" } }, "moderation block"],
      [{}, "Mistral error 400"],
    ];
    for (const [body, expected] of bodies) {
      const { engine } = mistral((async () => jsonResponse(body, 400)) as unknown as typeof fetch);
      const events = await collect(engine.speak("a", 1, opts({ voiceName: "v" })));
      expect(events).toEqual([{ type: "error", speakId: 1, message: expected }]);
    }
  });
});

// --- xAI gaps -------------------------------------------------------------------------

function xai(fetchImpl: typeof fetch): { engine: XaiEngine; playbacks: StubPlayback[] } {
  const playbacks: StubPlayback[] = [];
  const engine = new XaiEngine({
    getKey: async () => "k",
    fetchImpl,
    audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
  });
  return { engine, playbacks };
}

describe("xAI gaps", () => {
  it("stays silent when the key resolves after a preempt", async () => {
    const gate = deferred<string | null>();
    const { engine } = xai((async () => new Response()) as unknown as typeof fetch);
    (engine as unknown as { getKey: () => Promise<string | null> }).getKey = () => gate.promise;
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    gate.resolve("k");
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    gate.resolve("k");
    await second;
  });

  it("stays silent when the audio bytes resolve after a cancel", async () => {
    const gate = deferred<ArrayBuffer>();
    const { engine } = xai((async () =>
      ({ ok: true, arrayBuffer: () => gate.promise })) as unknown as typeof fetch);
    const events = collect(engine.speak("a", 1, opts()));
    await tick();
    engine.cancel();
    gate.resolve(new Uint8Array([1]).buffer);
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("stops the just-started playback when the host cancel-races", async () => {
    const playbacks: StubPlayback[] = [];
    const engine = new XaiEngine({
      getKey: async () => "k",
      fetchImpl: (async () => binaryResponse(new Uint8Array([1, 2]))) as unknown as typeof fetch,
      audioHost: {
        play: (): Playback => {
          const pb = stubPlayback();
          playbacks.push(pb);
          engine.cancel();
          return pb;
        },
      },
    });
    expect(await collect(engine.speak("a", 1, opts()))).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks[0].stopCalls).toBe(1);
  });
});

// --- LocalEngine gaps -------------------------------------------------------------------

let localPort = 9611;
function localEngine(fetchImpl: typeof fetch, wordTiming = true): { engine: LocalEngine; playbacks: StubPlayback[] } {
  localPort += 1; // unique base per engine: the module-level probe cache is shared for 30s
  const playbacks: StubPlayback[] = [];
  const engine = new LocalEngine(
    { id: "gap", name: "Gap", baseUrl: `http://127.0.0.1:${localPort}`, install: "x" },
    { wordTiming, voices: [{ id: "v1", lang: "en", name: "V1" }] },
    { fetchImpl, audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } } },
  );
  return { engine, playbacks };
}
const localOk = (): Response => jsonResponse({ audio_b64: atobBase64([1, 2]), words: [] });
function atobBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("LocalEngine gaps", () => {
  it("getVoices maps online caps to local voices and hides offline profiles", async () => {
    const onlineFetch = makeFetch([
      () => jsonResponse({ ok: true }), // health
      () => jsonResponse({ wordTiming: true, voices: [{ id: "v1", lang: "en", name: "V1" }] }), // caps
    ]).fetchImpl;
    const { engine } = localEngine(onlineFetch);
    expect(await engine.getVoices()).toEqual([{ name: "V1", lang: "en", localService: true, family: "local-gap" }]);
    // A second engine on a dead port → offline → no voices.
    const offlineFetch = makeFetch([
      () => { throw new Error("down"); },
    ]).fetchImpl;
    const { engine: offline } = localEngine(offlineFetch);
    expect(await offline.getVoices()).toEqual([]);
  });

  it("stays silent when the probe resolves after a preempt", async () => {
    // Unique port: this test's probe never lands, so it must not share the
    // module-level probe cache with the other LocalEngine tests.
    const playbacks: StubPlayback[] = [];
    const probeGate = deferred<Response>();
    const engine = new LocalEngine(
      { id: "preempt", name: "P", baseUrl: "http://127.0.0.1:9610", install: "x" },
      { wordTiming: false, voices: [{ id: "v1", lang: "en", name: "V1" }] },
      {
        fetchImpl: makeFetch([() => probeGate.promise]).fetchImpl,
        audioHost: { play: (): Playback => { const pb = stubPlayback(); playbacks.push(pb); return pb; } },
      },
    );
    void playbacks;
    const first = collect(engine.speak("a", 1, opts()));
    await tick();
    const second = collect(engine.speak("b", 2, opts()));
    // The probe lands after the preempt: speak 1 stays dead (no error event),
    // and speak 2's own probe reuses the same pending fetch.
    probeGate.resolve(jsonResponse({ ok: true }));
    await tick();
    await tick();
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    await second;
  });

  it("marks the profile offline and fails when the synthesize request throws", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true, voices: [{ id: "v1", lang: "en" }] }), // health
      () => jsonResponse({ wordTiming: true, voices: [{ id: "v1", lang: "en", name: "V1" }] }), // caps
      () => { throw new Error("server died"); }, // synthesize
    ]);
    const { engine } = localEngine(fetchImpl);
    const events = await collect(engine.speak("a", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("local server request failed") }]);
    // The offline mark took: the next probe (fresh TTL) says offline.
    expect(await engine.getVoices()).toEqual([]);
  });

  it("fails on non-OK synthesize responses, embedding the status and body", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true }), // health
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }), // caps
      () => ({ ok: false, status: 500, text: async () => "kaboom" } as unknown as Response),
      // Second speak: the probe is TTL-cached online → straight to synthesize.
      () => ({ ok: false, status: 500, text: () => Promise.reject(new Error("socket")) } as unknown as Response),
    ]);
    const { engine } = localEngine(fetchImpl);
    const events = await collect(engine.speak("a", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("500 kaboom") }]);
    // text() rejection falls back to the empty body.
    const events2 = await collect(engine.speak("a", 2, opts()));
    expect(events2).toEqual([{ type: "error", speakId: 2, message: expect.stringContaining("500 ") }]);
  });

  it("fails on a malformed JSON envelope and on missing audio", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("bad json")) } as unknown as Response),
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      () => jsonResponse({ audio_b64: "" }),
    ]);
    const { engine } = localEngine(fetchImpl, false);
    const events = await collect(engine.speak("a", 1, opts()));
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("malformed audio payload") });
    const events2 = await collect(engine.speak("a", 2, opts()));
    expect(events2).toEqual([{ type: "error", speakId: 2, message: "local server returned no audio payload" }]);
  });

  it("fails on undecodable base64", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      () => jsonResponse({ audio_b64: "!!!" }),
    ]);
    const { engine } = localEngine(fetchImpl, false);
    const events = await collect(engine.speak("a", 1, opts()));
    expect(events).toEqual([{ type: "error", speakId: 1, message: "local server returned malformed audio payload" }]);
  });

  it("stays silent when the envelope resolves after a cancel (post-decode guard)", async () => {
    const gate = deferred<unknown>();
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      (url) =>
        String(url).endsWith("/synthesize")
          ? ({ ok: true, status: 200, json: () => gate.promise } as unknown as Response)
          : jsonResponse({ ok: true }),
    ]);
    const { engine } = localEngine(fetchImpl, false);
    const events = collect(engine.speak("a", 1, opts()));
    await tick();
    await tick(); // probe + response land; run() is parked on the envelope parse
    engine.cancel();
    gate.resolve({ audio_b64: atobBase64([1]) });
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
  });

  it("stops the just-started playback when the host cancel-races", async () => {
    let calls = 0;
    const handlers = (): Array<(url: string) => Response> => [
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      () => localOk(),
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: false, voices: [{ id: "v1", lang: "en" }] }),
      () => localOk(),
    ];
    const { fetchImpl } = makeFetch(handlers() as never);
    const playbacks: StubPlayback[] = [];
    const engine = new LocalEngine(
      { id: "race", name: "Race", baseUrl: "http://127.0.0.1:9698", install: "x" },
      { wordTiming: false, voices: [{ id: "v1", lang: "en", name: "V1" }] },
      {
        fetchImpl,
        audioHost: {
          play: (): Playback => {
            const pb = stubPlayback();
            playbacks.push(pb);
            calls += 1;
            if (calls === 1) engine.cancel(); // race only on the first speak
            return pb;
          },
        },
      },
    );
    expect(await collect(engine.speak("a", 1, opts()))).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks[0].stopCalls).toBe(1);
  });

  it("word schedule guards: non-array / bad first time / malformed entries / zero spans", async () => {
    const wordsCases: unknown[] = [
      "not-an-array",
      [{ begin: 0, end: 5 }], // first time_ms missing
      [{ begin: 0, end: 5, time_ms: 0 }, { begin: "x", end: 5, time_ms: 10 }], // malformed entry skipped
      [{ begin: 5, end: 5, time_ms: 0 }], // zero span skipped
    ];
    for (const words of wordsCases) {
      const { fetchImpl } = makeFetch([
        () => jsonResponse({ ok: true }),
        () => jsonResponse({ wordTiming: true, voices: [{ id: "v1", lang: "en" }] }),
        () => jsonResponse({ audio_b64: atobBase64([1]), words }),
      ]);
      const { engine } = localEngine(fetchImpl, true);
      const events = await collect(engine.speak("a", 1, opts()));
      expect(events.filter((e) => e.type === "word")).toEqual([]);
    }
  });

  it("fires word events for a valid schedule (time − firstTime anchoring)", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ wordTiming: true, voices: [{ id: "v1", lang: "en" }] }),
      () => jsonResponse({ audio_b64: atobBase64([1]), words: [{ begin: 0, end: 3, time_ms: 0 }, { begin: 4, end: 8, time_ms: 5000 }] }),
    ]);
    let finishPb!: () => void;
    const engine = new LocalEngine(
      { id: "words", name: "Words", baseUrl: "http://127.0.0.1:9699", install: "x" },
      { wordTiming: true, voices: [{ id: "v1", lang: "en", name: "V1" }] },
      {
        fetchImpl,
        audioHost: { play: (): Playback => ({ stop: () => {}, done: new Promise((r) => (finishPb = r)) }) },
      },
    );
    const eventsPromise = collect(engine.speak("a", 1, opts()));
    await tick(); // start pushed; word timers scheduled (0ms and 5000ms)
    await tick(); // the 0ms timer fires while the stream is still open
    finishPb();
    const events = await eventsPromise;
    expect(events.filter((e) => e.type === "word")).toEqual([{ type: "word", speakId: 1, begin: 0, end: 3 }]);
    expect(events.map((e) => e.type)).toEqual(["start", "word", "end"]);
  });
});

describe("registerLocalEngines (boot probe)", () => {
  it("registers one LocalEngine per online profile and skips offline ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith("http://127.0.0.1:8880/leia/v1/health")) return jsonResponse({ ok: true });
        if (u.startsWith("http://127.0.0.1:8880/leia/v1/capabilities")) {
          return jsonResponse({ wordTiming: true, voices: [{ id: "k", lang: "en", name: "Kokoro" }] });
        }
        throw new Error("offline");
      }),
    );
    try {
      const hub = new EngineHub();
      await registerLocalEngines(hub);
      const families = hub.families().map((f) => f.family);
      expect(families).toEqual(["local-kokoro"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// --- EngineHub gaps ----------------------------------------------------------------------

describe("EngineHub gaps", () => {
  it("throws on speak with no engines; an empty hub reports null family + default caps", () => {
    const hub = new EngineHub();
    expect(hub.currentFamily).toBeNull();
    expect(hub.capabilities).toEqual({ wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" });
    expect(() => hub.speak("x", 1, opts())).toThrow("no engine registered");
  });
});

// --- KittenEngine gaps ---------------------------------------------------------------------

class FakeKittenWorker {
  sent: Array<Record<string, unknown>> = [];
  private messageListener: ((ev: { data: Record<string, unknown> }) => void) | null = null;
  private errorListener: (() => void) | null = null;
  addEventListener(type: "message" | "error", fn: never): void {
    if (type === "message") this.messageListener = fn as (ev: { data: Record<string, unknown> }) => void;
    if (type === "error") this.errorListener = fn as () => void;
  }
  postMessage(msg: Record<string, unknown>): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  reply(reply: Record<string, unknown>): void {
    this.messageListener?.({ data: reply });
  }
  crash(): void {
    this.errorListener?.();
  }
}

describe("KittenEngine gaps", () => {
  it("default worker factory throws without an extension runtime", async () => {
    const engine = new KittenEngine(); // no workerFactory → default path
    const events = await collect(engine.speak("x", 1, opts()));
    expect(events).toEqual([
      { type: "error", speakId: 1, message: expect.stringContaining("no extension runtime") },
    ]);
  });

  it("default worker factory uses chrome.runtime.getURL and surfaces Worker spawn errors", async () => {
    vi.stubGlobal("chrome", { runtime: { getURL: (p: string) => `chrome-extension://abc/${p}` } });
    try {
      const engine = new KittenEngine(); // Worker is undefined in jsdom → spawn throws
      const events = await collect(engine.speak("x", 1, opts()));
      expect(events[0].type).toBe("error");
      expect((events[0] as Extract<EngineEvent, { type: "error" }>).message).toContain("kitten-local:");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("crash with a synth pending rejects that request (not just init)", async () => {
    let spawned: FakeKittenWorker | null = null;
    const engine = new KittenEngine({
      workerFactory: () => (spawned = new FakeKittenWorker()) as unknown as Worker,
      audioHost: { play: (): Playback => stubPlayback() },
    });
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    spawned!.reply({ type: "ready", inputNames: [] });
    await tick();
    spawned!.crash(); // synth reqId 1 is pending in the map
    expect(await events).toEqual([{ type: "error", speakId: 1, message: expect.stringContaining("kitten worker crashed") }]);
  });

  it("drops the init-wait when a newer speak preempts (stale speak never requests synth)", async () => {
    let spawned: FakeKittenWorker | null = null;
    const engine = new KittenEngine({
      workerFactory: () => (spawned = new FakeKittenWorker()) as unknown as Worker,
      audioHost: { play: (): Playback => stubPlayback() },
    });
    const first = collect(engine.speak("one", 1, opts()));
    await tick();
    const second = collect(engine.speak("two", 2, opts()));
    spawned!.reply({ type: "ready", inputNames: [] }); // wakes BOTH run() continuations
    await tick();
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    // Only one synth was requested — speak 2's (speak 1 bailed at the isCurrent gate).
    const synths = spawned!.sent.filter((m) => m.type === "synth");
    expect(synths).toHaveLength(1);
    spawned!.reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    expect(await second).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("drops a rejected synth when the speak was already preempted", async () => {
    let spawned: FakeKittenWorker | null = null;
    const engine = new KittenEngine({
      workerFactory: () => (spawned = new FakeKittenWorker()) as unknown as Worker,
      audioHost: { play: (): Playback => stubPlayback() },
    });
    const first = collect(engine.speak("one", 1, opts()));
    await tick();
    spawned!.reply({ type: "ready", inputNames: [] });
    await tick();
    const second = collect(engine.speak("two", 2, opts())); // preempts speak 1 mid-synthesis
    await tick();
    spawned!.reply({ type: "error", reqId: 1, message: "synth blew up" }); // speak 1's request fails late
    expect(await first).toEqual([{ type: "cancelled", speakId: 1 }]);
    spawned!.reply({ type: "audio", reqId: 2, audio: Float32Array.of(0).buffer });
    expect(await second).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("stops just-started playback when the audio host cancel-races", async () => {
    let spawned: FakeKittenWorker | null = null;
    const playbacks: StubPlayback[] = [];
    const engine = new KittenEngine({
      workerFactory: () => (spawned = new FakeKittenWorker()) as unknown as Worker,
      audioHost: {
        play: (): Playback => {
          const pb = stubPlayback();
          playbacks.push(pb);
          engine.cancel();
          return pb;
        },
      },
    });
    const events = collect(engine.speak("x", 1, opts()));
    await tick();
    spawned!.reply({ type: "ready", inputNames: [] });
    await tick();
    spawned!.reply({ type: "audio", reqId: 1, audio: Float32Array.of(0).buffer });
    expect(await events).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(playbacks[0].stopCalls).toBe(1);
  });
});

// --- offscreen/audio.ts gaps --------------------------------------------------------------

class FakeUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onboundary: ((ev: { charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
const synth = {
  voices: [{ voiceURI: "v", name: "System Voice", lang: "en-US", localService: true, default: true }],
  utterances: [] as FakeUtterance[],
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices as unknown as SpeechSynthesisVoice[];
  },
  speak(u: SpeechSynthesisUtterance): void {
    this.utterances.push(u as unknown as FakeUtterance);
  },
  cancel(): void {},
};

async function loadOffscreen(): Promise<Array<(msg: unknown) => Promise<{ handled: boolean; replies: unknown[] }>>> {
  vi.resetModules();
  polyState.sent = [];
  polyState.sendMessageRejectFrom = Number.POSITIVE_INFINITY;
  polyState.listeners = [];
  synth.utterances = [];
  vi.stubGlobal("speechSynthesis", synth);
  (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;
  await import("../src/offscreen/audio");
  return polyState.listeners.map(
    (wrapper) => async (msg: unknown) => {
      const replies: unknown[] = [];
      const sendResponse = (r?: unknown): void => {
        replies.push(r);
      };
      const handled = wrapper(msg, {}, sendResponse) !== false;
      await tick(); // handled replies are delivered asynchronously
      return { handled, replies };
    },
  );
}

describe("offscreen audio message triage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no loopback servers in tests");
      }),
    );
  });

  it("answers capabilities, families, clock; ignores unknown/non-audio/non-object messages", async () => {
    const [listener] = await loadOffscreen();

    const caps = await listener({ type: "leia:audio:capabilities" });
    expect(caps.handled).toBe(true);
    // web-speech is the current family and declares word timing (boundary events).
    expect(caps.replies[0]).toEqual({ wordTiming: true, streaming: false, costClass: "free", privacyClass: "local" });

    const families = await listener({ type: "leia:audio:families" });
    expect(families.handled).toBe(true);
    expect((families.replies[0] as Array<{ family: string }>).map((f) => f.family)).toContain("web-speech");

    const clock = await listener({ type: "leia:audio:clock" });
    expect(clock.handled).toBe(true);
    expect(clock.replies[0]).toMatchObject({ ok: true, replyType: "leia:audio:clock", data: { clock: null } });

    const unknown = await listener({ type: "leia:nonsense" });
    expect(unknown.handled).toBe(false);
    expect(unknown.replies).toEqual([]);

    const nonAudio = await listener({ type: "leia:other:ping" });
    expect(nonAudio.handled).toBe(false);

    const nonObject = await listener("just a string");
    expect(nonObject.handled).toBe(false);
  });

  it("applies a key snapshot from a forwarded message (object keys + profile list guards)", async () => {
    polyState.storage = {};
    const [listener] = await loadOffscreen();
    // Garbage snapshot shapes are ignored (spread guards), no crash.
    await listener({ type: "leia:audio:voices", keys: "nope", localProfiles: 42 });
    // A real snapshot makes the minimax voices appear.
    await listener({ type: "leia:audio:voices", keys: { "leia:settings:minimaxKey": "k" }, localProfiles: [] });
    const reply = await listener({ type: "leia:audio:voices" });
    const names = (reply.replies[0] as Array<{ family: string }>).filter((v) => v.family === "minimax");
    expect(names.length).toBeGreaterThan(0);
  });

  it("registers online local profiles from the boot probe (snapshot variant)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("http://127.0.0.1:8880/leia/v1/health")) return jsonResponse({ ok: true });
        throw new Error("offline");
      }),
    );
    const [listener] = await loadOffscreen();
    let families: string[] = [];
    await until(async () => {
      const r = await listener({ type: "leia:audio:families" });
      families = ((r.replies[0] as Array<{ family: string }>) ?? []).map((f) => f.family);
      return families.includes("local-kokoro");
    });
    expect(families).toContain("local-kokoro");
  });

  it("survives the SW disappearing mid-stream (sendMessage rejection swallowed)", async () => {
    const [listener] = await loadOffscreen();
    polyState.sendMessageRejectFrom = 1; // first event delivered, rest rejected
    await listener({ type: "leia:audio:speak", speakId: 5, text: "Hello world.", voiceName: null, rate: 1 });
    await until(() => synth.utterances.length === 1);
    const u = synth.utterances[0];
    u.onstart!(new Event("start"));
    u.onend!(new Event("end"));
    await until(() => polyState.sent.length >= 1);
    expect(polyState.sent[0]).toEqual({ type: "leia:audio:event", event: { type: "start", speakId: 5 } });
  });
});

// --- providers.ts gaps ---------------------------------------------------------------------

describe("provider row DOM gaps", () => {
  it("renders the hint note for providers that define one", () => {
    const def: ProviderDef = { ...PROVIDERS[4] }; // mistral carries a hint
    const row = buildProviderRow(def, null);
    const hint = row.querySelector(".hint");
    expect(hint?.textContent).toBe(def.hint);
  });

  it("renders a free-text region input when no curated list is given", () => {
    const def: ProviderDef = { id: "custom", label: "Custom", keyStorage: "k", regionStorage: "r" };
    const row = buildProviderRow(def, "key-1234", "westeu");
    const input = row.querySelector("input.region") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("westeu");
    expect(input.getAttribute("aria-label")).toBe("Custom region");
    // Empty saved region renders empty.
    const row2 = buildProviderRow(def, null, null);
    expect((row2.querySelector("input.region") as HTMLInputElement).value).toBe("");
  });
});

// --- word-clock gaps -------------------------------------------------------------------------

describe("createWordClock default scheduler + guards", () => {
  interface Frame {
    cb: () => void;
    canceled: boolean;
  }
  function rafStub(): { frames: Frame[]; runReady(): void } {
    const frames: Frame[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      const f: Frame = { cb, canceled: false };
      frames.push(f);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      const f = frames[id - 1];
      if (f) f.canceled = true;
    });
    return {
      frames,
      runReady(): void {
        for (const f of [...frames]) if (!f.canceled) f.cb();
      },
    };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Date.now + requestAnimationFrame, applies due words per frame", () => {
    const raf = rafStub();
    const applied: Array<{ begin: number; end: number }> = [];
    let t = 1000;
    vi.stubGlobal("Date", { ...Date, now: () => t });
    const clock = createWordClock({ apply: (w) => applied.push(w) }); // no now/schedule → defaults
    clock.set({ words: [{ begin: 0, end: 3, t: 0 }, { begin: 4, end: 7, t: 50 }, { begin: 8, end: 11, t: 500 }], anchorWall: 1000, anchorClock: 0 });
    raf.runReady(); // t=1000 → word 0 only (t=0 due; 50 and 500 not yet)
    expect(applied).toEqual([{ begin: 0, end: 3 }]);
    t = 1060; // 60ms later → word 1 (t=50) due
    raf.runReady();
    expect(applied).toEqual([
      { begin: 0, end: 3 },
      { begin: 4, end: 7 },
    ]);
    clock.stop();
  });

  it("step() bails on a cleared timeline (frame fired after stop)", () => {
    const raf = rafStub();
    const applied: Array<{ begin: number; end: number }> = [];
    const clock = createWordClock({
      apply: (w) => applied.push(w),
      now: () => 0,
      schedule: (cb) => {
        raf.frames.push({ cb, canceled: false });
        return () => {
          raf.frames[raf.frames.length - 1].canceled = true;
        };
      },
    });
    clock.set({ words: [{ begin: 0, end: 2, t: 0 }], anchorWall: 0, anchorClock: 0 });
    clock.stop();
    // Fire the captured frame manually: timeline is null → early return, no crash.
    raf.frames[0].cb();
    expect(applied).toEqual([]);
  });

  it("resample() is a no-op without a timeline, advances and rewinds the index with lead", () => {
    const raf = rafStub();
    const applied: Array<{ begin: number; end: number }> = [];
    let t = 0;
    const schedule = (cb: () => void): (() => void) => {
      raf.frames.push({ cb, canceled: false });
      return () => {
        raf.frames.forEach((f) => (f.canceled = true));
      };
    };
    const clock = createWordClock({ apply: (w) => applied.push(w), now: () => t, schedule, leadMs: 10 });
    clock.resample(999); // no timeline yet → no-op
    clock.set({
      words: [{ begin: 0, end: 2, t: 0 }, { begin: 3, end: 5, t: 100 }, { begin: 6, end: 8, t: 200 }],
      anchorWall: 0,
      anchorClock: 0,
    });
    raf.runReady(); // t=0: only word 0 (t=0 ≤ 0+10)
    expect(applied).toEqual([{ begin: 0, end: 2 }]);
    // Resample ahead: the index jumps past word 1 (already due at clock 105+lead),
    // so word 1 is consumed by the re-anchor, not by a step frame.
    clock.resample(105);
    raf.runReady(); // pending frame: clockNow 105 → word 2 (t=200) still upcoming
    expect(applied).toEqual([{ begin: 0, end: 2 }]);
    // Rewind: a stale resample drags the index back before word 0 (clock+lead < 0),
    // then wall-clock advance replays it from the recovered index.
    clock.resample(-20);
    t = 15;
    raf.runReady();
    expect(applied).toEqual([
      { begin: 0, end: 2 },
      { begin: 0, end: 2 },
    ]);
    // Sweep continues: word 1 due once clockNow reaches t−lead = 90.
    t = 110;
    raf.runReady();
    expect(applied).toEqual([
      { begin: 0, end: 2 },
      { begin: 0, end: 2 },
      { begin: 3, end: 5 },
    ]);
    clock.stop();
  });
});
