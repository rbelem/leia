// SPDX-License-Identifier: MPL-2.0
/**
 * LocalEngine (ADR-0006, T11): one engine per local voice-server profile,
 * keyless, loopback-only. Structurally MiniMaxEngine minus the key —
 * injected fetchImpl + audioHost, EventStream bridging, preempt/cancel
 * parity, the MiniMax word-scheduling pattern (time_ms − firstTime −
 * elapsed vs playResolvedAt), and base64 (atob) decode instead of hex.
 *
 * Offline = invisible: engines stay registered; a failed probe makes
 * getVoices() return [] so the voice-driven picker drops the family
 * (ADR-0006). speak() gates on the TTL-cached probe and marks the profile
 * offline immediately when the server dies mid-session.
 *
 * Implements prefetch() (pipelining, ADR-0003 — ElevenLabs pattern): a
 * single-entry cache of decoded audio bytes — the latest prefetch wins —
 * that a later speak() with identical text+options consumes instead of
 * re-synthesizing; a mismatching speak() or cancel() discards it. Local
 * synthesis is the slow path (CPU ONNX), so pipelining hides the
 * between-chunks gap. Only the leia synthesize dialect prefetches; the
 * OpenAI dialect has a different endpoint/body and never populates the
 * cache. prefetch never probes, never touches the active speak, and never
 * marks the profile offline.
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import type { AudioHost, Playback } from "./engine-minimax";
import { DOM_AUDIO_HOST } from "./engine-minimax";
import type { EngineHub } from "./hub";
import {
  BUILT_IN_PROFILES,
  type LocalCapabilities,
  type LocalProfile,
  markProfileOffline,
  probeProfile,
  readLocalProfiles,
} from "./local-profiles";

export interface LocalEngineOptions {
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
}

interface SynthesizeEnvelope {
  audio_b64?: string;
  words?: LocalVoiceWord[];
}

interface LocalVoiceWord {
  begin?: number;
  end?: number;
  time_ms?: number;
}

export class LocalEngine implements TextEngine {
  readonly family: string;
  readonly capabilities: EngineCapabilities;
  private readonly profile: LocalProfile;
  private readonly caps: LocalCapabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private active: { speakId: number; stream: EventStream<EngineEvent>; playback: Playback | null } | null = null;
  private wordTimers: ReturnType<typeof setTimeout>[] = [];
  /** Decoded audio for chunk pipelining (ADR-0003): one entry, latest
   * prefetch wins; cancel() discards it. The key pins text+voice+rate so a
   * mismatching speak() can never serve stale audio. */
  private cache: { cacheKey: string; bytes: Uint8Array; words?: LocalVoiceWord[] } | null = null;
  private cacheEpoch = 0;

  constructor(profile: LocalProfile, caps: LocalCapabilities, opts: LocalEngineOptions = {}) {
    this.profile = profile;
    this.caps = caps;
    this.family = `local-${profile.id}`;
    this.capabilities = {
      wordTiming: caps.wordTiming,
      streaming: false,
      costClass: "free",
      // `edge` proxies Microsoft Edge Read-Aloud (see local-profiles.ts) — audio leaves the machine, so provider-class.
      privacyClass: this.profile.id === "edge" ? "provider" : "local",
    };
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const { online, caps } = await probeProfile(this.profile, this.fetchImpl);
    if (!online) return [];
    return caps.voices.map((v) => ({ name: v.name, lang: v.lang, localService: true, family: this.family }));
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like WebSpeechEngine: close the old stream + stop its audio.
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      wasActive.playback?.stop();
    }
    void this.run(text, speakId, options, stream);
    return stream;
  }

  /**
   * Synthesize ahead for a FUTURE speak() with identical text+options
   * (pipelining, ADR-0003). Best-effort: a failed request stores nothing
   * and the later speak() synthesizes on demand.
   */
  async prefetch(text: string, options: SpeakOptions): Promise<void> {
    if (this.profile.kind === "openai") return;
    const epoch = this.cacheEpoch;
    try {
      const resp = await this.fetchImpl(`${this.profile.baseUrl}/leia/v1/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: this.voiceId(options), rate: clampRate(options.rate), format: "wav" }),
      });
      if (!resp.ok) return;
      const envelope = (await resp.json()) as SynthesizeEnvelope;
      const b64 = envelope.audio_b64;
      if (typeof b64 !== "string" || b64.length === 0) return;
      const bytes = base64ToBytes(b64);
      if (this.cacheEpoch === epoch) {
        this.cache = { cacheKey: this.cacheKey(text, options), bytes, words: envelope.words };
      }
    } catch {
      // best-effort — a later speak() fetches on demand
    }
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
    this.clearWordTimers();
    this.cacheEpoch += 1; // discard in-flight prefetch results too
    this.cache = null;
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

    // TTL-cached probe: a fresh result is instant; a stale one re-probes
    // (30 s TTL, 500 ms abort) so a server that just came up is picked up.
    const { online } = await probeProfile(this.profile, this.fetchImpl);
    if (!this.isCurrent(speakId)) return;
    if (!online) {
      fail(`local server offline — check ${this.profile.baseUrl}`);
      return;
    }

    const voice = this.voiceId(options);
    if (this.profile.kind === "openai") {
      // OpenAI-compatible TTS: POST /v1/audio/speech → raw audio bytes
      // (mp3 by default — vLLM-Omni, LocalAI and Kokoro-FastAPI all encode
      // it). No word timing exists on this API; the media-clock poll the
      // reader arms for timing-less engines keeps the highlight marching.
      let resp: Response;
      try {
        resp = await this.fetchImpl(`${this.profile.baseUrl}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: text,
            voice,
            response_format: "mp3",
            ...(this.profile.model ? { model: this.profile.model } : {}),
          }),
        });
      } catch (err) {
        // Server died mid-session — mark offline NOW so the picker reacts.
        markProfileOffline(this.profile.baseUrl);
        fail(`local server request failed: ${String(err)}`);
        return;
      }
      if (!this.isCurrent(speakId)) return;
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        fail(`${resp.status} ${body.slice(0, 200)}`);
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await resp.arrayBuffer());
      } catch (err) {
        fail(`local server returned malformed audio payload: ${String(err)}`);
        return;
      }
      if (!this.isCurrent(speakId)) return;
      const mime = resp.headers?.get?.("content-type")?.split(";")[0] || "audio/mpeg";
      await this.deliver(bytes, mime, speakId, stream);
      return;
    }

    const cached = this.cachedFor(text, options);
    if (cached) {
      await this.deliver(cached.bytes, "audio/wav", speakId, stream, cached.words);
      return;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.profile.baseUrl}/leia/v1/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice, rate: clampRate(options.rate), format: "wav" }),
      });
    } catch (err) {
      // Server died mid-session — mark offline NOW so the picker reacts.
      markProfileOffline(this.profile.baseUrl);
      fail(`local server request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      fail(`${resp.status} ${body.slice(0, 200)}`);
      return;
    }
    let envelope: SynthesizeEnvelope;
    try {
      envelope = (await resp.json()) as SynthesizeEnvelope;
    } catch (err) {
      fail(`local server returned malformed audio payload: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;

    const b64 = envelope.audio_b64;
    if (typeof b64 !== "string" || b64.length === 0) {
      fail("local server returned no audio payload");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(b64);
    } catch {
      fail("local server returned malformed audio payload");
      return;
    }
    await this.deliver(bytes, "audio/wav", speakId, stream, envelope.words);
  }

  /** Shared playback tail: play, emit start/word/end, close. */
  private async deliver(
    bytes: Uint8Array,
    mime: string,
    speakId: number,
    stream: EventStream<EngineEvent>,
    words?: LocalVoiceWord[],
  ): Promise<void> {
    const playback = this.audioHost.play(bytes, mime);
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    const playResolvedAt = Date.now();
    stream.push({ type: "start", speakId });

    if (this.caps.wordTiming) this.scheduleWords(words, speakId, stream, playResolvedAt);
    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  /** Schedule one word event per timed word (MiniMax pattern: delay = time_ms − firstTime − elapsed). */
  private scheduleWords(
    words: LocalVoiceWord[] | undefined,
    speakId: number,
    stream: EventStream<EngineEvent>,
    playResolvedAt: number,
  ): void {
    if (!Array.isArray(words)) return;
    const firstTime = words[0]?.time_ms;
    if (typeof firstTime !== "number") return;
    const elapsed = Date.now() - playResolvedAt;
    for (const w of words) {
      const { begin, end, time_ms: t } = w;
      if (typeof begin !== "number" || typeof end !== "number" || typeof t !== "number") continue;
      if (end <= begin) continue;
      const delay = Math.max(0, t - firstTime - elapsed);
      this.wordTimers.push(
        setTimeout(() => {
          stream.push({ type: "word", speakId, begin, end });
        }, delay),
      );
    }
  }

  private voiceId(options: SpeakOptions): string {
    return options.voiceName ?? this.caps.voices[0]?.id ?? "default";
  }

  private cacheKey(text: string, options: SpeakOptions): string {
    return `${text}|${this.voiceId(options)}|${clampRate(options.rate)}`;
  }

  /**
   * Serve the pipelining cache when text+options match (ElevenLabs pattern).
   * A mismatching speak() discards the entry (ADR-0003 — latest prefetch
   * wins; nothing stale survives to a later speak). A matching speak()
   * keeps it: the next prefetch overwrites it and cancel() clears it.
   */
  private cachedFor(text: string, options: SpeakOptions): { bytes: Uint8Array; words?: LocalVoiceWord[] } | null {
    const entry = this.cache;
    if (!entry) return null;
    const match = entry.cacheKey === this.cacheKey(text, options);
    if (!match) this.cache = null;
    return match ? { bytes: entry.bytes, words: entry.words } : null;
  }

  private clearWordTimers(): void {
    for (const t of this.wordTimers) clearTimeout(t);
    this.wordTimers = [];
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }
}

function clampRate(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

/** base64 → bytes; atob is available in every extension context (no Buffer). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Boot-time registration (ADR-0006): probe every built-in profile plus each
 * stored custom profile and register a LocalEngine per ONLINE one. Offline
 * servers are simply not registered — the picker never sees an empty
 * family, and getVoices()'s 30 s TTL refresh self-heals when a server
 * appears. Lazy: never blocks web-speech. Re-runnable (the hub's rescan
 * hook calls this on ensureFamily): already-registered families keep their
 * engine and the registration order never grows duplicates.
 */
export async function registerLocalEngines(hub: EngineHub): Promise<void> {
  const profiles = [...BUILT_IN_PROFILES, ...(await readLocalProfiles())];
  const probed = await Promise.all(
    profiles.map(async (profile) => ({ profile, result: await probeProfile(profile) })),
  );
  for (const { profile, result } of probed) {
    const family = `local-${profile.id}`;
    if (result.online && !hub.has(family)) hub.register(family, new LocalEngine(profile, result.caps));
  }
}