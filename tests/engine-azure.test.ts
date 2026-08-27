import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AZURE_CAPABILITIES,
  AZURE_DEFAULT_REGION,
  AZURE_OUTPUT_FORMAT,
  AzureEngine,
  parseAzureVoicesXml,
  type AzureSdkLike,
  type AzureSynthesizerLike,
  type AzureWordBoundaryEventArgs,
} from "../src/audio/engine-azure";
import type { Playback } from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

/** Completed (SynthesizingAudioCompleted) vs Canceled (ResultReason.Canceled) stub results. */
const COMPLETED = { reason: 8 };
const CANCELED = { reason: 1, errorDetails: "WebSocket upgrade failed: 401" };

interface StubCfg {
  key: string;
  region: string;
  outputFormat: unknown;
  voiceName: unknown;
}

class StubSynthesizer implements AzureSynthesizerLike {
  wordBoundary: ((sender: unknown, e: AzureWordBoundaryEventArgs) => void) | null = null;
  SynthesisCanceled: ((sender: unknown, e: { result?: unknown }) => void) | null = null;
  text = "";
  resolveCb: ((r: unknown) => void) | null = null;
  errCb: ((e: string) => void) | null = null;
  closeCalls = 0;

  speakTextAsync(text: string, cb: (r: unknown) => void, err?: (e: string) => void): void {
    this.text = text;
    this.resolveCb = cb;
    this.errCb = err ?? null;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

interface SdkHarness {
  sdk: AzureSdkLike;
  configs: StubCfg[];
  instances: StubSynthesizer[];
  sinks: Array<{ write(data: ArrayBuffer): void; close(): void }>;
}

function makeSdk(): SdkHarness {
  const configs: StubCfg[] = [];
  const instances: StubSynthesizer[] = [];
  const sinks: SdkHarness["sinks"] = [];
  const sdk: AzureSdkLike = {
    SpeechConfig: {
      fromSubscription: (key: string, region: string) => {
        const cfg: StubCfg = { key, region, outputFormat: undefined, voiceName: undefined };
        configs.push(cfg);
        return {
          get speechSynthesisOutputFormat() {
            return cfg.outputFormat;
          },
          set speechSynthesisOutputFormat(v: unknown) {
            cfg.outputFormat = v;
          },
          get speechSynthesisVoiceName() {
            return cfg.voiceName;
          },
          set speechSynthesisVoiceName(v: unknown) {
            cfg.voiceName = v;
          },
        };
      },
    },
    SpeechSynthesizer: class extends StubSynthesizer {
      constructor() {
        super();
        instances.push(this);
      }
    } as unknown as AzureSdkLike["SpeechSynthesizer"],
    AudioConfig: {
      fromStreamOutput: (stream) => {
        sinks.push(stream);
        return { marker: "audioConfig" };
      },
    },
    PushAudioOutputStreamCallback: class {
      write(_data: ArrayBuffer): void {}
      close(): void {}
    },
    SpeechSynthesisOutputFormat: { Audio24Khz48KBitRateMonoMp3: "audio-24khz-48kbitrate-mono-mp3" },
    CancellationDetails: {
      fromResult: (r: unknown) => {
        const details = (r as { errorDetails?: unknown }).errorDetails;
        return { errorDetails: typeof details === "string" ? details : "" };
      },
    },
    ResultReason: { Canceled: 1 },
  };
  return { sdk, configs, instances, sinks };
}

interface StubPlayback extends Playback {
  stopCalls: number;
  finish(): void;
}

interface StubHost {
  played: Array<{ bytes: Uint8Array; mime: string }>;
  playbacks: StubPlayback[];
  play(bytes: Uint8Array, mime: string): StubPlayback;
}

function makeHost(): StubHost {
  const played: StubHost["played"] = [];
  const playbacks: StubPlayback[] = [];
  return {
    played,
    playbacks,
    play(bytes: Uint8Array, mime: string): StubPlayback {
      played.push({ bytes, mime });
      let resolveDone!: () => void;
      const pb: StubPlayback = {
        stopCalls: 0,
        done: new Promise((r) => (resolveDone = r)),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        finish: () => resolveDone(),
      };
      playbacks.push(pb);
      return pb;
    },
  };
}

function makeFetch(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return h(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function xmlResponse(xml: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/xml" : null) },
    text: async () => xml,
  } as unknown as Response;
}

const MP3_A = new Uint8Array([0x49, 0x44, 0x33]); // "ID3"
const MP3_B = new Uint8Array([0xaa, 0xbb]);
const MP3_JOINED = new Uint8Array([0x49, 0x44, 0x33, 0xaa, 0xbb]);

// Azure voices/list payloads (child-element style is what the endpoint returns;
// attribute style is also parseable).
const VOICES_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<voices>
  <Voice>
    <Name>Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)</Name>
    <ShortName>en-US-AriaNeural</ShortName>
    <Gender>Female</Gender>
    <Locale>en-US</Locale>
    <LocalName>Aria</LocalName>
  </Voice>
  <Voice>
    <Name>Microsoft Server Speech Text to Speech Voice (pt-BR, ThalitaNeural)</Name>
    <ShortName>pt-BR-ThalitaNeural</ShortName>
    <Gender>Female</Gender>
    <Locale>pt-BR</Locale>
    <LocalName>Thalita</LocalName>
  </Voice>
</voices>`;

const VOICES_XML_ATTR = `<voices>
  <Voice Name="Aria" ShortName="en-US-AriaNeural" Gender="Female" Locale="en-US" LocalName="Aria" />
  <Voice Name="Thalita" ShortName="pt-BR-ThalitaNeural" Gender="Female" Locale="pt-BR" LocalName="Thalita" />
</voices>`;

describe("AzureEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: sink bytes → play, wordBoundary 100ns → ms offsets, start → words → end", async () => {
    const { sdk, configs, instances, sinks } = makeSdk();
    const host = makeHost();
    const engine = new AzureEngine({
      getKey: async () => "k123",
      getRegion: async () => "eastus",
      audioHost: host,
      sdk,
    });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0); // keys → config → synthesizer → speakTextAsync

    expect(configs).toEqual([
      { key: "k123", region: "eastus", outputFormat: "audio-24khz-48kbitrate-mono-mp3", voiceName: undefined },
    ]);
    expect(instances).toHaveLength(1);
    expect(instances[0].text).toBe("Hello world.");

    // Word boundaries arrive DURING synthesis: textOffset/wordLength → char
    // offsets; audioOffset in 100ns ticks → ms (5_300_000 ticks = 530 ms).
    instances[0].wordBoundary?.(null, { textOffset: 0, wordLength: 5, audioOffset: 0 });
    instances[0].wordBoundary?.(null, { textOffset: 6, wordLength: 6, audioOffset: 5_300_000 });
    sinks[0].write(MP3_A.buffer);
    sinks[0].write(MP3_B.buffer);
    instances[0].resolveCb?.(COMPLETED); // synthesis done → bytes complete → play

    expect(host.played).toEqual([{ bytes: MP3_JOINED, mime: "audio/mpeg" }]);
    await vi.advanceTimersByTimeAsync(0); // start + 0ms word (clamped)
    await vi.advanceTimersByTimeAsync(530); // second word at (530 − 0)ms
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "word", speakId: 7, begin: 6, end: 12 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("missing key errors immediately; missing region falls back to AZURE_DEFAULT_REGION", async () => {
    const { sdk, instances, configs, sinks } = makeSdk();
    const host = makeHost();
    const noKey = new AzureEngine({ getKey: async () => null, getRegion: async () => "eastus", sdk });
    const noRegion = new AzureEngine({
      getKey: async () => "k",
      getRegion: async () => null,
      audioHost: host,
      sdk,
    });

    const e1 = collect(noKey.speak("Hi.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await e1).toEqual([
      { type: "error", speakId: 1, message: "Azure Speech key/region not set — providers settings" },
    ]);

    const e2 = collect(noRegion.speak("Hi.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    // Drive the fake synthesis to completion like the happy path.
    instances[0].wordBoundary?.(null, { textOffset: 0, wordLength: 2, audioOffset: 0 });
    sinks[0].write(new Uint8Array([0xff, 0xfb]).buffer);
    instances[0].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await e2).toEqual([
      { type: "start", speakId: 2 },
      { type: "word", speakId: 2, begin: 0, end: 2 },
      { type: "end", speakId: 2 },
    ]);
    // Default region used when none stored (key-only setups work out of the box).
    expect(configs[0]?.region).toBe(AZURE_DEFAULT_REGION);
    expect(instances).toHaveLength(1);
  });

  it("synthesizeCanceled (SynthesisCanceled) → error event with the reason string; late canceled resolve is idempotent", async () => {
    const { sdk, instances } = makeSdk();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", sdk });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    instances[0].SynthesisCanceled?.(null, { result: { errorDetails: "Connection refused (401)" } });
    // The SDK also delivers the canceled result to the resolve callback — must not double-report.
    instances[0].resolveCb?.(CANCELED);
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Azure Speech synthesis canceled: Connection refused (401)" },
    ]);
  });

  it("canceled resolve without the event → error surfaced via CancellationDetails", async () => {
    const { sdk, instances } = makeSdk();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", sdk });

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    instances[0].resolveCb?.(CANCELED);
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "error", speakId: 4, message: "Azure Speech synthesis canceled: WebSocket upgrade failed: 401" },
    ]);
  });

  it("completed resolve with no audio bytes → error", async () => {
    const { sdk, instances } = makeSdk();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", sdk });

    const events = collect(engine.speak("Hi.", 5, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    instances[0].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "error", speakId: 5, message: "Azure Speech returned no audio payload" },
    ]);
  });

  it("custom voiceName → speechSynthesisVoiceName on the config", async () => {
    const { sdk, configs, instances, sinks } = makeSdk();
    const host = makeHost();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", audioHost: host, sdk });

    const events = collect(engine.speak("X.", 6, { voiceName: "pt-BR-ThalitaNeural", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(configs[0].voiceName).toBe("pt-BR-ThalitaNeural");
    sinks[0].write(MP3_A.buffer);
    instances[0].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 6 },
      { type: "end", speakId: 6 },
    ]);
  });

  it("cancel mid-synthesis: synthesizer closed, stream cancelled, late resolve starts nothing", async () => {
    const { sdk, instances, sinks } = makeSdk();
    const host = makeHost();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", audioHost: host, sdk });

    const events = collect(engine.speak("Hi.", 8, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    engine.cancel();
    expect(instances[0].closeCalls).toBe(1);
    expect(await events).toEqual([{ type: "cancelled", speakId: 8 }]);

    // The SDK fires the canceled resolve after close() — must not start audio.
    sinks[0].write(MP3_A.buffer);
    instances[0].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.played).toHaveLength(0);
  });

  it("a new speak preempts: old stream cancelled, old synthesizer closed, no playback for the old chunk", async () => {
    const { sdk, instances, sinks } = makeSdk();
    const host = makeHost();
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", audioHost: host, sdk });

    const eventsA = collect(engine.speak("Alpha.", 1, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const eventsB = collect(engine.speak("Beta.", 2, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);
    expect(instances[0].closeCalls).toBe(1); // A's synthesizer released on preempt

    // A's synthesis resolves late — must not start audio.
    sinks[0].write(MP3_A.buffer);
    instances[0].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.played).toHaveLength(0);

    sinks[1].write(MP3_A.buffer);
    instances[1].resolveCb?.(COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.played).toHaveLength(1); // only B played
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("getVoices: no key → []; key+region → voices/list XML parsed (ShortName + Locale)", async () => {
    const { sdk } = makeSdk();
    const { fetchImpl, calls } = makeFetch([() => xmlResponse(VOICES_XML)]);
    const engine = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", fetchImpl, sdk });

    const voices = await engine.getVoices();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list");
    expect(calls[0].init?.headers).toMatchObject({ "Ocp-Apim-Subscription-Key": "k" });
    expect(voices).toEqual([
      { name: "en-US-AriaNeural", lang: "en-US", localService: false, family: "azure" },
      { name: "pt-BR-ThalitaNeural", lang: "pt-BR", localService: false, family: "azure" },
    ]);

    const noKey = new AzureEngine({ getKey: async () => null, getRegion: async () => "eastus", sdk });
    expect(await noKey.getVoices()).toEqual([]);
  });

  it("getVoices with unset region falls back to AZURE_DEFAULT_REGION", async () => {
    const { sdk } = makeSdk();
    const { fetchImpl, calls } = makeFetch([() => xmlResponse(VOICES_XML)]);
    const engine = new AzureEngine({
      getKey: async () => "k",
      getRegion: async () => null,
      fetchImpl,
      sdk,
    });
    await engine.getVoices();
    expect(calls[0].url).toBe(
      `https://${AZURE_DEFAULT_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    );
  });

  it("voice list failure (401 or throw) → []", async () => {
    const { sdk } = makeSdk();
    const { fetchImpl } = makeFetch([() => xmlResponse("<error/>", 401)]);
    const engine = new AzureEngine({ getKey: async () => "bad", getRegion: async () => "eastus", fetchImpl, sdk });
    expect(await engine.getVoices()).toEqual([]);

    const { fetchImpl: throwing } = makeFetch([() => Promise.reject(new Error("net down"))]);
    const engine2 = new AzureEngine({ getKey: async () => "k", getRegion: async () => "eastus", fetchImpl: throwing, sdk });
    expect(await engine2.getVoices()).toEqual([]);
  });

  it("parseAzureVoicesXml handles attribute-style payloads and the regex fallback", () => {
    expect(parseAzureVoicesXml(VOICES_XML_ATTR).map((v) => v.name)).toEqual([
      "en-US-AriaNeural",
      "pt-BR-ThalitaNeural",
    ]);

    // Regex fallback path (no DOMParser, e.g. bare Node):
    const saved = globalThis.DOMParser;
    (globalThis as { DOMParser?: unknown }).DOMParser = undefined;
    try {
      const voices = parseAzureVoicesXml(VOICES_XML);
      expect(voices).toEqual([
        { name: "en-US-AriaNeural", lang: "en-US", localService: false, family: "azure" },
        { name: "pt-BR-ThalitaNeural", lang: "pt-BR", localService: false, family: "azure" },
      ]);
    } finally {
      (globalThis as { DOMParser?: unknown }).DOMParser = saved;
    }
  });

  it("capabilities claim word timing + streaming (SDK is a live streaming client)", () => {
    expect(AZURE_CAPABILITIES).toEqual({
      wordTiming: true,
      streaming: true,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
    expect(AZURE_OUTPUT_FORMAT).toBe("Audio24Khz48KBitRateMonoMp3");
  });
});