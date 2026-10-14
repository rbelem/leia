// SPDX-License-Identifier: MPL-2.0
/**
 * Fish Audio engine (fish.audio). Provider TTS via the v1 REST API: one POST
 * per chunk to /v1/tts, raw binary MP3 response → audioHost playback. The
 * model rides a `model` request HEADER (not a body field); the free
 * s2.1-pro-free tier is the wallet-safe default.
 *
 * Voices are Fish marketplace model ids: `VoiceInfo.name` carries the model's
 * `_id` (unique — it flows into `reference_id` and survives duplicate titles)
 * and `VoiceInfo.title` carries the marketplace display name for the picker.
 * No voice (null) = Fish's own default voice.
 *
 * No timestamps in the response — sentence-granularity marching highlight
 * only (ADR-0003), so `wordTiming: false` and NO word events ever.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
export const FISH_MODELS_URL = "https://api.fish.audio/model";
export const FISH_TTS_MODEL = "s2.1-pro-free";
export const FISH_MAX_CHARS = 2000;
/** Marketplace list drifts slowly; refetching it on every popup open cost
 * ~3 s per open (measured TTFB), so voices are cached per key for 5 min. */
export const FISH_VOICES_TTL_MS = 5 * 60_000;
/** A hung marketplace request must fail the list (uncached, retried next
 * open) instead of blanking the popup picker indefinitely. */
const FISH_VOICES_TIMEOUT_MS = 5_000;

export const FISH_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/** Fish marketplace voices list base language codes ("en", "pt-BR"); map the
 * common prefixes onto BCP-47 tags for the picker's grouping, else "und". */
const LANGUAGE_TAGS: Record<string, string> = {
  en: "en-US",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  pt: "pt-BR",
  it: "it-IT",
  ru: "ru-RU",
  ar: "ar-SA",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
};

interface FishModelDef {
  _id?: unknown;
  title?: unknown;
  state?: unknown;
  languages?: unknown;
  dmca_taken_down?: unknown;
}

export interface FishAudioEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class FishAudioEngine implements TextEngine {
  readonly family = "fishaudio";
  readonly capabilities = FISH_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private voicesCache: { key: string; at: number; voices: VoiceInfo[] } | null = null;

  constructor(opts: FishAudioEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    const cached = this.voicesCache;
    if (cached && cached.key === key && Date.now() - cached.at < FISH_VOICES_TTL_MS) return cached.voices;
    try {
      const url = `${FISH_MODELS_URL}?page_size=100&sort_by=task_count&page_number=1`;
      const resp = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FISH_VOICES_TIMEOUT_MS),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { items?: FishModelDef[] };
      if (!Array.isArray(data.items)) return [];
      const voices = data.items
        .filter((m): m is FishModelDef & { _id: string } => typeof m?._id === "string" && m._id.length > 0)
        .filter((m) => m.state === "trained" && m.dmca_taken_down !== true)
        .map((m) => ({
          name: m._id,
          title: typeof m.title === "string" && m.title.length > 0 ? m.title : undefined,
          lang: langTag(Array.isArray(m.languages) ? m.languages[0] : undefined),
          localService: false,
          family: "fishaudio",
        }));
      this.voicesCache = { key, at: Date.now(), voices };
      return voices;
    } catch {
      return []; // failures are not cached — the next open retries
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
  }

  // --- internals ---

  private async run(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
  ): Promise<void> {
    const fail = (message: string): void => {
      stream.push({ type: "error", speakId, message });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };

    const key = await this.getKey();
    if (!this.isCurrent(speakId)) return;
    if (!key) {
      fail("Fish Audio API key not set — providers settings");
      return;
    }
    if (text.length > FISH_MAX_CHARS) {
      fail(`Fish Audio text too long (${text.length} > ${FISH_MAX_CHARS} chars)`);
      return;
    }

    const body: Record<string, unknown> = {
      text,
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
      latency: "balanced",
      chunk_length: 300,
    };
    if (typeof options.voiceName === "string" && options.voiceName.length > 0) {
      body.reference_id = options.voiceName; // omitted → Fish's default voice
    }
    if (options.rate !== 1) body.prosody = { speed: clampRate(options.rate) };

    let resp: Response;
    try {
      resp = await this.fetchImpl(FISH_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", model: FISH_TTS_MODEL },
        body: JSON.stringify(body),
      });
    } catch (err) {
      fail(`Fish Audio request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    const buf = await resp.arrayBuffer();
    if (!this.isCurrent(speakId)) return;
    const playback = this.audioHost.play(new Uint8Array(buf), "audio/mpeg");
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    stream.push({ type: "start", speakId });

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

/** Non-OK responses carry a JSON `{message}` (Fish shape) or
 * `{error:{message}}` (sibling shape); fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { message?: unknown; error?: { message?: unknown } };
      if (typeof body.message === "string" && body.message.length > 0) return body.message;
      if (typeof body.error?.message === "string" && body.error.message.length > 0) return body.error.message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `Fish Audio error ${resp.status}`;
}

/** Fish accepts 0.5–2.0 for prosody.speed. */
function clampRate(rate: number): number {
  const r = Number.isFinite(rate) ? rate : 1;
  return Math.min(2, Math.max(0.5, r));
}

function langTag(code: unknown): string {
  if (typeof code !== "string") return "und";
  return LANGUAGE_TAGS[code.split("-")[0].toLowerCase()] ?? "und";
}
