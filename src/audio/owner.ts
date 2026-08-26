/**
 * Audio-owner seam (ADR-0002, T2 item 4). Resolves the platform voice engine
 * that the ReaderSession consumes:
 *
 *  - Chrome: a ProxyEngine in the service worker that drives the product
 *    offscreen document (`offscreen/audio.html`, reason AUDIO_PLAYBACK —
 *    separate from the spike probes). The offscreen document hosts a real
 *    WebSpeechEngine.
 *  - Firefox: the background event page has a DOM, so it hosts a
 *    WebSpeechEngine directly.
 *
 * Chrome free-engine drop-in point: the pending spike verdict
 * (docs/spike-offscreen-speech.md — offscreen speechSynthesis vs chrome.tts)
 * lands as a LOCAL swap here: replace the `new ProxyEngine(...)` below with
 * a `new TtsEngine(...)` (chrome.tts runs in the SW itself, same contract,
 * no offscreen needed). Audio in both variants reports through the same
 * AsyncIterable<EngineEvent> contract, so nothing else changes.
 */
import browser from "webextension-polyfill";
import { EventStream } from "../reader/event-stream";
import type {
  EngineCapabilities,
  EngineEvent,
  SpeakOptions,
  TextEngine,
  VoiceInfo,
} from "../reader/contract";
import { isEngineEventTerminal } from "../reader/contract";
import { WebSpeechEngine } from "./engine-webspeech";
import { MiniMaxEngine } from "./engine-minimax";
import { ElevenLabsEngine } from "./engine-elevenlabs";
import { AzureEngine } from "./engine-azure";
import { OpenAIEngine } from "./engine-openai";
import { registerLocalEngines } from "./engine-local";
import { EngineHub, type EngineFamilyInfo } from "./hub";

// Minimal typing for chrome.offscreen (polyfill types don't cover it).
interface ChromeOffscreen {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

const OFFSCREEN_URL = "offscreen/audio.html";

/** True when running in Chrome (service worker); Firefox otherwise. */
export function isChrome(): boolean {
  return typeof navigator !== "undefined" && /Chrome\/|Chromium\//.test(navigator.userAgent);
}

function chromeOffscreenApi(): ChromeOffscreen | undefined {
  return (browser as unknown as { offscreen?: ChromeOffscreen }).offscreen;
}

let ensuredOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  ensuredOffscreen ??= (async () => {
    const offscreen = chromeOffscreenApi();
    if (!offscreen) throw new Error("offscreen API unavailable — Chrome 109+ only");
    await offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Leia reads selections aloud via Web Speech (ADR-0002)",
    });
  })().catch((err: unknown) => {
    // Only one offscreen document per extension. Reuse it if it is ours;
    // if a spike probe document holds the slot, the audio messages below
    // will fail cleanly with "receiving end does not exist".
    if (String(err).includes("Only a single offscreen document may be created")) return;
    ensuredOffscreen = null;
    throw err;
  });
  return ensuredOffscreen;
}

/**
 * Chrome-side engine: forwards speak/cancel to the offscreen document over
 * runtime messages and turns the streamed `leia:audio:event` messages back
 * into an AsyncIterable<EngineEvent>.
 */
export class ProxyEngine implements TextEngine {
  readonly family = "web-speech";
  private current: { speakId: number; stream: EventStream<EngineEvent> } | null = null;
  private capsPromise: Promise<EngineCapabilities> | null = null;
  private caps: EngineCapabilities | null = null;
  private famsPromise: Promise<EngineFamilyInfo[]> | null = null;
  private fams: EngineFamilyInfo[] | null = null;

  async getVoices(): Promise<VoiceInfo[]> {
    await ensureOffscreen();
    return (await browser.runtime.sendMessage({ type: "leia:audio:voices" })) as VoiceInfo[];
  }

  /**
   * Offscreen's current-family capabilities. Sync getter: returns the cached
   * value (or a conservative default while the first round trip is in
   * flight); the offscreen reply refreshes the cache.
   */
  get capabilities(): EngineCapabilities {
    if (!this.capsPromise) {
      this.capsPromise = ensureOffscreen()
        .then(
          () => browser.runtime.sendMessage({ type: "leia:audio:capabilities" }) as Promise<EngineCapabilities>,
        )
        .then((c) => {
          this.caps = c;
          return c;
        })
        .catch(() => this.caps ?? DEFAULT_CAPABILITIES);
    }
    return this.caps ?? DEFAULT_CAPABILITIES;
  }

  /** Switch the offscreen engine family; next capabilities/families read re-queries. */
  selectFamily(family: string): void {
    this.caps = null;
    this.capsPromise = null;
    this.fams = null;
    this.famsPromise = null;
    void browser.runtime.sendMessage({ type: "leia:audio:family", family }).catch(() => {});
  }

  /**
   * Offscreen's registered families (sync getter like capabilities: cached,
   * refreshed on the first read after a selectFamily / cache miss).
   */
  families(): EngineFamilyInfo[] {
    if (!this.famsPromise) {
      this.famsPromise = ensureOffscreen()
        .then(
          () => browser.runtime.sendMessage({ type: "leia:audio:families" }) as Promise<EngineFamilyInfo[]>,
        )
        .then((f) => {
          this.fams = f;
          return f;
        })
        .catch(() => this.fams ?? []);
    }
    return this.fams ?? [];
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const current = this.current;
    const stream = new EventStream<EngineEvent>();
    this.current = { speakId, stream };
    if (current) {
      current.stream.closeCancelled({ type: "cancelled", speakId: current.speakId });
      void browser.runtime.sendMessage({ type: "leia:audio:cancel" }).catch(() => {});
    }

    void ensureOffscreen()
      .then(() =>
        browser.runtime.sendMessage({
          type: "leia:audio:speak",
          speakId,
          text,
          voiceName: options.voiceName,
          rate: options.rate,
        }),
      )
      .catch((err: unknown) => {
        if (this.current?.speakId === speakId) {
          stream.push({ type: "error", speakId, message: String(err) });
          stream.close();
        }
      });
    return stream;
  }

  cancel(): void {
    const current = this.current;
    this.current = null;
    if (current) current.stream.closeCancelled({ type: "cancelled", speakId: current.speakId });
    void browser.runtime.sendMessage({ type: "leia:audio:cancel" }).catch(() => {});
  }

  /** Route a `leia:audio:event` message from the offscreen document. */
  pushEvent(ev: EngineEvent): void {
    if (!this.current || ev.speakId !== this.current.speakId) return;
    const stream = this.current.stream;
    stream.push(ev);
    if (isEngineEventTerminal(ev)) {
      this.current = null;
      stream.close();
    }
  }
}

const proxy = new ProxyEngine();

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "free",
  privacyClass: "local",
};

/** Read a provider key from storage.local (T14 providers settings shape). */
async function readProviderKey(storageKey: string): Promise<string | null> {
  try {
    const got = (await browser.storage.local.get(storageKey)) as Record<string, unknown>;
    const v = got[storageKey];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Resolve the platform's engine. Chrome uses the offscreen proxy; Firefox speaks directly. */
export function resolveAudioEngine(): TextEngine {
  if (isChrome()) return proxy;
  if (typeof speechSynthesis === "undefined") {
    throw new Error("speechSynthesis unavailable — Firefox background page only");
  }
  const hub = new EngineHub();
  hub.register("web-speech", new WebSpeechEngine(speechSynthesis), { default: true });
  hub.register("minimax", new MiniMaxEngine({ getKey: () => readProviderKey("leia:settings:minimaxKey") }));
  hub.register("elevenlabs", new ElevenLabsEngine({ getKey: () => readProviderKey("leia:settings:elevenlabsKey") }));
  hub.register("azure", new AzureEngine({
    getKey: () => readProviderKey("leia:settings:azureKey"),
    getRegion: () => readProviderKey("leia:settings:azureRegion"),
  }));
  hub.register("openai", new OpenAIEngine({ getKey: () => readProviderKey("leia:settings:openaiKey") }));
  void registerLocalEngines(hub); // lazy boot probe (ADR-0006) — never blocks web-speech
  return hub;
}

/** Singleton — every context wiring (background router) uses the same proxy. */
export function chromeAudioEngine(): ProxyEngine {
  return proxy;
}