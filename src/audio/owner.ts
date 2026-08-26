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
import type { EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { WebSpeechEngine } from "./engine-webspeech";

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

  async getVoices(): Promise<VoiceInfo[]> {
    await ensureOffscreen();
    return (await browser.runtime.sendMessage({ type: "leia:audio:voices" })) as VoiceInfo[];
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
    if (ev.type !== "start") {
      this.current = null;
      stream.close();
    }
  }
}

const proxy = new ProxyEngine();

/** Resolve the platform's engine. Chrome uses the offscreen proxy; Firefox speaks directly. */
export function resolveAudioEngine(): TextEngine {
  if (isChrome()) return proxy;
  if (typeof speechSynthesis === "undefined") {
    throw new Error("speechSynthesis unavailable — Firefox background page only");
  }
  return new WebSpeechEngine(speechSynthesis);
}

/** Singleton — every context wiring (background router) uses the same proxy. */
export function chromeAudioEngine(): ProxyEngine {
  return proxy;
}