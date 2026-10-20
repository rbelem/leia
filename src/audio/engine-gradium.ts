// SPDX-License-Identifier: MPL-2.0
/**
 * Gradium engine (gradium.ai). Provider TTS via the REST TTS endpoint: one
 * POST per chunk to /api/post/speech/tts with the `x-api-key` header, RAW
 * binary WAV response (`only_audio: true`) → audioHost playback. Gradium
 * serves the same models as the open-weight Phonon checkpoints, plus
 * instant voice cloning.
 *
 * Voices come from GET /api/voices/ — the flagship catalog plus your own
 * cloned/designed voices. `uid` is the `voice_id` the TTS endpoint takes,
 * `name` is the picker label.
 *
 * Rate rides `json_config.padding_bonus` (negative = faster, positive =
 * slower) — the same shape as Phonon's duration_delta, mapped onto
 * Gradium's ±4 band.
 *
 * The REST response carries no timestamps — sentence-granularity marching
 * highlight only (ADR-0003), so `wordTiming: false` and NO word events.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, and audio playback are injected.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const GRADIUM_TTS_URL = "https://api.gradium.ai/api/post/speech/tts";
export const GRADIUM_VOICES_URL = "https://api.gradium.ai/api/voices/";
/** The voice list drifts slowly; refetching it on every popup open costs a
 * round trip, so voices are cached per key for 5 min. */
export const GRADIUM_VOICES_TTL_MS = 5 * 60_000;
/** A hung voice request must fail the list (uncached, retried next open)
 * instead of blanking the popup picker indefinitely. */
const GRADIUM_VOICES_TIMEOUT_MS = 5_000;

export const GRADIUM_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/** Gradium's voice `language` is a plain code ("en", "pt-BR"); map the common
 * prefixes onto BCP-47 tags for the picker's grouping, else "und". */
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

interface GradiumVoiceDef {
  uid?: unknown;
  name?: unknown;
  description?: unknown;
  language?: unknown;
  is_catalog?: unknown;
}

/**
 * Gradium's speed control is `json_config.padding_bonus`: negative speaks
 * faster, positive slower, 0 is the model's own pace. The contract's rate
 * is a multiplier, so it is mapped onto the band piecewise through the
 * three points that matter: (0.5, +2), (1.0, 0), (2.0, -2).
 */
export function gradiumPaddingBonus(rate: number): number {
  const r = Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1));
  const bonus = r >= 1 ? -2 * (r - 1) : 2 * (1 - r) / 0.5;
  return bonus === 0 ? 0 : bonus;
}

export interface GradiumEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

export class GradiumEngine implements TextEngine {
  readonly family = "gradium";
  readonly capabilities = GRADIUM_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private voicesCache: { key: string; at: number; voices: VoiceInfo[] } | null = null;
  /** Last voice list seen — the fallback voice when the session picked none
   * (Gradium's `voice_id` is required, it has no "default" voice). */
  private lastVoices: VoiceInfo[] = [];

  constructor(opts: GradiumEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    const cached = this.voicesCache;
    if (cached && cached.key === key && Date.now() - cached.at < GRADIUM_VOICES_TTL_MS) return cached.voices;
    try {
      const resp = await this.fetchImpl(`${GRADIUM_VOICES_URL}?include_catalog=true&limit=100`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(GRADIUM_VOICES_TIMEOUT_MS),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as unknown;
      if (!Array.isArray(data)) return [];
      const voices: VoiceInfo[] = [];
      for (const entry of data as GradiumVoiceDef[]) {
        const uid = entry?.uid;
        if (typeof uid !== "string" || uid.length === 0) continue;
        const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : uid;
        voices.push({
          name: uid,
          title: name,
          lang: langTag(entry.language),
          localService: false,
          family: "gradium",
        });
      }
      this.voicesCache = { key, at: Date.now(), voices };
      this.lastVoices = voices;
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
      fail("Gradium API key not set — providers settings");
      return;
    }
    const voiceId = options.voiceName ?? this.lastVoices[0]?.name ?? null;
    if (!voiceId) {
      fail("Gradium: no voice available — pick a voice in the popup");
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(GRADIUM_TTS_URL, {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(this.requestBody(text, voiceId, options)),
      });
    } catch (err) {
      fail(`Gradium request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    const buf = await resp.arrayBuffer();
    if (!this.isCurrent(speakId)) return;
    const playback = this.audioHost.play(new Uint8Array(buf), "audio/wav");
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

  /** The request body Gradium expects: raw audio out, one voice, and the
   * speed knob only when the session actually changed it. */
  private requestBody(text: string, voiceId: string, options: SpeakOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      text,
      voice_id: voiceId,
      output_format: "wav",
      only_audio: true,
    };
    if (options.rate !== 1) {
      body.json_config = { padding_bonus: gradiumPaddingBonus(options.rate) };
    }
    return body;
  }
}

/** Non-OK responses: Gradium's REST errors are plain text ("error from
 * server <code>: <reason>"), JSON bodies are handled too. */
async function errorDetail(resp: Response): Promise<string> {
  const contentType = resp.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("json")) {
      const body = (await resp.json()) as { detail?: unknown; error?: { message?: unknown } | string };
      if (typeof body.detail === "string" && body.detail.length > 0) return body.detail;
      if (typeof body.error === "string" && body.error.length > 0) return body.error;
      const message = (body.error as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message.length > 0) return message;
    } else {
      const text = (await resp.text()).trim();
      if (text.length > 0) return text.slice(0, 300);
    }
  } catch {
    // fall through to the generic status message
  }
  return `Gradium error ${resp.status}`;
}

function langTag(code: unknown): string {
  if (typeof code !== "string") return "und";
  return LANGUAGE_TAGS[code.split("-")[0].toLowerCase()] ?? "und";
}
