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
  private wordTimers: number[] = [];

  constructor(profile: LocalProfile, caps: LocalCapabilities, opts: LocalEngineOptions = {}) {
    this.profile = profile;
    this.caps = caps;
    this.family = `local-${profile.id}`;
    this.capabilities = {
      wordTiming: caps.wordTiming,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const { online, caps } = await probeProfile(this.profile.baseUrl, this.fetchImpl);
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

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
    this.clearWordTimers();
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
    const { online } = await probeProfile(this.profile.baseUrl, this.fetchImpl);
    if (!this.isCurrent(speakId)) return;
    if (!online) {
      fail(`local server offline — check ${this.profile.baseUrl}`);
      return;
    }

    const voice = options.voiceName ?? this.caps.voices[0]?.id ?? "default";
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
    const playback = this.audioHost.play(bytes, "audio/wav");
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    const playResolvedAt = Date.now();
    stream.push({ type: "start", speakId });

    if (this.caps.wordTiming) this.scheduleWords(envelope.words, speakId, stream, playResolvedAt);
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
 * appears. Lazy: never blocks web-speech. ponytail: a T14 refresh could
 * re-probe and register newly-online profiles without a hub restart.
 */
export async function registerLocalEngines(hub: EngineHub): Promise<void> {
  const profiles = [...BUILT_IN_PROFILES, ...(await readLocalProfiles())];
  for (const profile of profiles) {
    const { online, caps } = await probeProfile(profile.baseUrl);
    if (online) hub.register(`local-${profile.id}`, new LocalEngine(profile, caps));
  }
}