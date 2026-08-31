// SPDX-License-Identifier: MPL-2.0
/**
 * Azure Speech engine (T9, #10). Provider TTS via the
 * microsoft-cognitiveservices-speech-sdk (websocket, live streaming): text is
 * synthesized through a PushAudioOutputStreamCallback sink whose MP3 bytes
 * land in a buffer; native WordBoundary events (char offsets into the input
 * text + audio offset in 100ns ticks) are scheduled against the audio start
 * when synthesis completes (sibling-engine anchoring — a slow synthesis
 * doesn't delay the march).
 *
 * The SDK surface the engine touches is declared structurally (AzureSdkLike)
 * so tests can inject stubs; the module default is the real SDK, which
 * bundles cleanly with esbuild (day-one verified).
 */
import * as azureSdk from "microsoft-cognitiveservices-speech-sdk";
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const AZURE_VOICES_URL = (region: string): string =>
  `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
export const AZURE_OUTPUT_FORMAT = "Audio24Khz48KBitRateMonoMp3";

/**
 * Azure Speech regions for the settings dropdown (service availability per
 * Microsoft's speech-services regions table). `eastus` first — it is the
 * de-facto default in Azure docs/samples — and the fallback used when no
 * region is stored.
 */
export const AZURE_DEFAULT_REGION = "eastus";
export const AZURE_REGIONS = [
  AZURE_DEFAULT_REGION,
  "eastus2",
  "centralus",
  "westus",
  "westus2",
  "westus3",
  "canadacentral",
  "brazilsouth",
  "northeurope",
  "westeurope",
  "uksouth",
  "ukwest",
  "francecentral",
  "germanywestcentral",
  "switzerlandnorth",
  "swedencentral",
  "norwayeast",
  "uaenorth",
  "centralindia",
  "southindia",
  "japaneast",
  "japanwest",
  "koreacentral",
  "southeastasia",
  "eastasia",
  "australiaeast",
  "australiasoutheast",
] as const;

export const AZURE_CAPABILITIES: EngineCapabilities = {
  wordTiming: true,
  streaming: true, // SDK is a live streaming client (websocket)
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/** Minimal structural surface of the SDK the engine uses (stubbed in tests). */
export interface AzureWordBoundaryEventArgs {
  textOffset: number;
  wordLength: number;
  audioOffset: number;
}

export interface AzureSynthesizerLike {
  wordBoundary: ((sender: unknown, e: AzureWordBoundaryEventArgs) => void) | null;
  /** Note: the JS SDK's event is capitalized (`SynthesisCanceled`), unlike .NET's `synthesizeCanceled`. */
  SynthesisCanceled: ((sender: unknown, e: { result?: unknown }) => void) | null;
  speakTextAsync(
    text: string,
    cb: (result: unknown) => void,
    err?: (error: string) => void,
  ): void;
  close(): void;
}

export interface AzureSdkLike {
  SpeechConfig: {
    fromSubscription(key: string, region: string): {
      speechSynthesisOutputFormat: unknown;
      speechSynthesisVoiceName?: unknown;
    };
  };
  SpeechSynthesizer: new (config: unknown, audioConfig?: unknown) => AzureSynthesizerLike;
  AudioConfig: {
    fromStreamOutput(stream: { write(data: ArrayBuffer): void; close(): void }): unknown;
  };
  /** The engine subclasses this so the real SDK's `instanceof` check in fromStreamOutput passes. */
  PushAudioOutputStreamCallback: new () => { write(data: ArrayBuffer): void; close(): void };
  SpeechSynthesisOutputFormat: Record<string, unknown>;
  CancellationDetails: { fromResult(result: unknown): { errorDetails: string } };
  ResultReason: { Canceled: unknown };
}

export interface AzureEngineOptions {
  getKey: () => Promise<string | null>;
  getRegion: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
  /** Injectable SDK surface (real SDK by default; structural stubs in tests). */
  sdk?: AzureSdkLike;
}

export class AzureEngine implements TextEngine {
  readonly family = "azure";
  readonly capabilities = AZURE_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly getRegion: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private readonly sdk: AzureSdkLike;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private wordTimers: ReturnType<typeof setTimeout>[] = [];
  /** The in-flight synthesizer; cancel() closes it mid-synthesis. */
  private synthesizer: AzureSynthesizerLike | null = null;

  constructor(opts: AzureEngineOptions) {
    this.getKey = opts.getKey;
    this.getRegion = opts.getRegion;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
    this.sdk = opts.sdk ?? (azureSdk as unknown as AzureSdkLike);
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const [storedKey, storedRegion] = await Promise.all([this.getKey(), this.getRegion()]);
    if (!storedKey) return [];
    // Unset region falls back to the service's most common one — key-only
    // setups get voices without touching settings.
    const region = storedRegion || AZURE_DEFAULT_REGION;
    try {
      const resp = await this.fetchImpl(AZURE_VOICES_URL(region), {
        headers: { "Ocp-Apim-Subscription-Key": storedKey },
      });
      if (!resp.ok) return [];
      return parseAzureVoicesXml(await resp.text());
    } catch {
      return [];
    }
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like the sibling engines: close the old stream + stop its audio.
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      wasActive.playback?.stop();
    }
    this.closeSynthesizer(); // any in-flight synthesis belongs to the preempted speak
    void this.run(text, speakId, options, stream);
    return stream;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
    this.clearWordTimers();
    this.closeSynthesizer();
  }

  // --- internals ---

  private async run(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
  ): Promise<void> {
    // Both failure surfaces can fire for one turn (SynthesisCanceled event,
    // then the resolve callback with reason Canceled) — report once.
    let finished = false;
    const fail = (message: string): void => {
      if (finished) return;
      finished = true;
      stream.push({ type: "error", speakId, message });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };

    const [key, regionRaw] = await Promise.all([this.getKey(), this.getRegion()]);
    if (!this.isCurrent(speakId)) return;
    // Unset region falls back to the service's most common one.
    const region = regionRaw || AZURE_DEFAULT_REGION;
    if (!key) {
      fail("Azure Speech key/region not set — providers settings");
      return;
    }

    const chunks: Uint8Array[] = [];
    const words: Array<{ begin: number; end: number; time: number }> = [];

    const Base = this.sdk.PushAudioOutputStreamCallback;
    const sink = new (class extends Base {
      write(data: ArrayBuffer): void {
        chunks.push(new Uint8Array(data));
      }
      close(): void {
        // Completion is signalled by the speakTextAsync resolve callback
        // (fires on turn.end, after the last audio chunk is written).
      }
    })();

    const config = this.sdk.SpeechConfig.fromSubscription(key, region);
    config.speechSynthesisOutputFormat = this.sdk.SpeechSynthesisOutputFormat[AZURE_OUTPUT_FORMAT];
    if (options.voiceName) config.speechSynthesisVoiceName = options.voiceName;
    const syn = new this.sdk.SpeechSynthesizer(config, this.sdk.AudioConfig.fromStreamOutput(sink));
    this.synthesizer = syn;

    syn.wordBoundary = (_s, e) => {
      if (!this.isCurrent(speakId)) return;
      const { textOffset, wordLength, audioOffset } = e;
      if (typeof textOffset !== "number" || typeof wordLength !== "number" || typeof audioOffset !== "number") return;
      words.push({ begin: textOffset, end: textOffset + wordLength, time: audioOffset / 10_000 });
    };
    syn.SynthesisCanceled = (_s, e) => {
      if (!this.isCurrent(speakId)) return;
      fail(cancelMessage(this.sdk, e.result));
    };

    syn.speakTextAsync(
      text,
      (result) => {
        if ((result as { reason?: unknown }).reason === this.sdk.ResultReason.Canceled) {
          // Auth failure, quota, or a user close — surfaced by the
          // SynthesisCanceled handler when it fires; idempotent via `finished`.
          fail(cancelMessage(this.sdk, result));
          return;
        }
        if (!this.isCurrent(speakId)) return;
        if (chunks.length === 0) {
          fail("Azure Speech returned no audio payload");
          return;
        }
        finished = true; // success: a late SynthesisCanceled (e.g. from close()) must not error this stream
        this.closeSynthesizer(); // release the websocket — the audio is already captured
        const playback = this.audioHost.play(joinBytes(chunks), "audio/mpeg");
        if (!this.isCurrent(speakId)) {
          playback.stop();
          return;
        }
        this.active = { speakId, stream, playback };
        const playResolvedAt = Date.now();
        stream.push({ type: "start", speakId });
        this.scheduleWords(words, speakId, stream, playResolvedAt);

        void playback.done.then(() => {
          if (this.active?.speakId === speakId) this.active = null;
          stream.push({ type: "end", speakId });
          stream.close();
        });
      },
      (err) => fail(`Azure Speech synthesis failed: ${String(err)}`),
    );
  }

  /** Schedule word events anchored at the first word (elapsed synthesis time subtracted, sibling-style). */
  private scheduleWords(
    words: Array<{ begin: number; end: number; time: number }>,
    speakId: number,
    stream: EventStream<EngineEvent>,
    playResolvedAt: number,
  ): void {
    const firstTime = words[0]?.time;
    if (typeof firstTime !== "number") return;
    const elapsed = Date.now() - playResolvedAt;
    for (const w of words) {
      if (w.end <= w.begin) continue;
      const delay = Math.max(0, Math.round(w.time - firstTime) - elapsed);
      this.wordTimers.push(
        setTimeout(() => {
          stream.push({ type: "word", speakId, begin: w.begin, end: w.end });
        }, delay),
      );
    }
  }

  private clearWordTimers(): void {
    for (const t of this.wordTimers) clearTimeout(t);
    this.wordTimers = [];
  }

  /** Close + release the in-flight synthesizer (cancel/preempt/completion paths). */
  private closeSynthesizer(): void {
    const synth = this.synthesizer;
    this.synthesizer = null;
    if (synth) {
      try {
        synth.close();
      } catch {
        // already closed — nothing to release
      }
    }
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

/** Best error string for a canceled synthesis result (CancellationDetails carries it). */
function cancelMessage(sdk: AzureSdkLike, result: unknown): string {
  try {
    const details = sdk.CancellationDetails.fromResult(result).errorDetails;
    if (typeof details === "string" && details.length > 0) return `Azure Speech synthesis canceled: ${details}`;
  } catch {
    // fall through to the generic message
  }
  return "Azure Speech synthesis canceled";
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Parse the voices/list XML (Voice elements with ShortName/Locale/Gender/
 * LocalName) into VoiceInfo. DOMParser when available (both extension
 * contexts have it); tiny regex fallback otherwise (e.g. Node tests).
 */
export function parseAzureVoicesXml(xml: string): VoiceInfo[] {
  const out: VoiceInfo[] = [];
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const els = doc.getElementsByTagName("Voice");
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i];
      const name = el.getAttribute("ShortName") ?? childText(el, "ShortName");
      if (!name) continue;
      out.push({
        name,
        lang: el.getAttribute("Locale") ?? childText(el, "Locale") ?? "und",
        localService: false,
        family: "azure",
      });
    }
    return out;
  }
  // Regex fallback: <Voice> blocks, child elements or attributes.
  const blockRe = /<Voice\b(?:[^>]*\/>|[\s\S]*?<\/Voice>)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[0];
    const name = tagAttr(block, "ShortName") ?? tagChild(block, "ShortName");
    if (!name) continue;
    out.push({
      name,
      lang: tagAttr(block, "Locale") ?? tagChild(block, "Locale") ?? "und",
      localService: false,
      family: "azure",
    });
  }
  return out;
}

function childText(el: Element, tag: string): string | null {
  const c = el.getElementsByTagName(tag)[0];
  const t = c?.textContent;
  return typeof t === "string" && t.trim().length > 0 ? t.trim() : null;
}

function tagAttr(block: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(block);
  return m && m[1].length > 0 ? m[1] : null;
}

function tagChild(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(block);
  return m && m[1].trim().length > 0 ? m[1].trim() : null;
}