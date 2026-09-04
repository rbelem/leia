// SPDX-License-Identifier: MPL-2.0
/**
 * Test harness fakes for engine lanes (T5/T7/T8/T11 will import these).
 * FakeEngine implements the v1 TextEngine contract (see docs/engine-contract.md)
 * with scripted event sequences, so reader tests run against a deterministic,
 * inspectable engine instead of a platform API.
 *
 * Dependency-light: no vitest import. Only the contract types + the EventStream
 * class every real engine uses to bridge callback APIs into the contract.
 */

import {
  isEngineEventTerminal,
  type EngineCapabilities,
  type EngineEvent,
  type SpeakOptions,
  type TextEngine,
  type VoiceInfo,
} from "../src/reader/contract";
import { EventStream } from "../src/reader/event-stream";

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "free",
  privacyClass: "local",
};

export interface FakeEngineOptions {
  /** Overrides merged over the default (wordTiming false / streaming false / free / local). */
  capabilities?: Partial<EngineCapabilities>;
  /** Voices getVoices() resolves with; family tags default to the engine's family. */
  voices?: VoiceInfo[];
  /** Scripted events per speak call. Return the full sequence incl. the terminal event. */
  script?: (speakId: number) => EngineEvent[];
  /** Deliver scripted events synchronously (default) or on a microtask (`await tick()`). */
  schedule?: "sync" | "tick";
  /** Optional selectFamily behavior; calls are recorded in selectFamilyCalls. */
  selectFamily?: (family: string) => void;
  /**
   * Cold-start model of Chrome's ProxyEngine capabilities round trip: the
   * sync `capabilities` view starts at the bare default (no
   * maxUtteranceChars) and `caps` land on the view + `awaitCapabilities()`
   * after `delayMs` (default 50). "never" models a wedged round trip — the
   * awaitable never settles; callers must time-box it. Absent = no
   * awaitCapabilities (direct-engine shape: sync view authoritative).
   */
  asyncCapabilities?: { caps: Partial<EngineCapabilities>; delayMs?: number } | "never";
}

export class FakeEngine implements TextEngine {
  readonly family: string;
  readonly selectFamily?: (family: string) => void;
  /** Present only when asyncCapabilities is set — the ProxyEngine-shaped
   * seam the session duck-types on. */
  readonly awaitCapabilities?: (timeoutMs?: number) => Promise<EngineCapabilities>;

  voices: VoiceInfo[];
  speakCalls: Array<{ text: string; speakId: number; options: SpeakOptions }> = [];
  cancelCount = 0;
  selectFamilyCalls: string[] = [];

  private capsView: EngineCapabilities;
  private script?: (speakId: number) => EngineEvent[];
  private schedule: "sync" | "tick";
  private streams = new Map<number, EventStream<EngineEvent>>();
  private active: number | null = null;

  get capabilities(): EngineCapabilities {
    return this.capsView;
  }

  constructor(family: string, opts: FakeEngineOptions = {}) {
    this.family = family;
    this.capsView = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.voices = opts.voices ?? [];
    this.script = opts.script;
    this.schedule = opts.schedule ?? "sync";
    if (opts.selectFamily) {
      this.selectFamily = (f: string): void => {
        this.selectFamilyCalls.push(f);
        opts.selectFamily!(f);
      };
    }
    if (opts.asyncCapabilities) {
      // Cold start: the sync view answers defaults until the "round trip"
      // lands (or never, for the wedged variant).
      this.capsView = { ...DEFAULT_CAPABILITIES };
      if (opts.asyncCapabilities === "never") {
        this.awaitCapabilities = (): Promise<EngineCapabilities> => new Promise(() => {});
      } else {
        const live: EngineCapabilities = {
          ...DEFAULT_CAPABILITIES,
          ...opts.capabilities,
          ...opts.asyncCapabilities.caps,
        };
        let land: (c: EngineCapabilities) => void = () => {};
        const landed = new Promise<EngineCapabilities>((resolve) => {
          land = resolve;
        });
        this.awaitCapabilities = (): Promise<EngineCapabilities> => landed;
        setTimeout(() => {
          this.capsView = live;
          land(live);
        }, opts.asyncCapabilities.delayMs ?? 50);
      }
    }
  }

  getVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(this.voices.map((v) => ({ ...v, family: v.family ?? this.family })));
  }

  async *speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    this.speakCalls.push({ text, speakId, options });

    // Contract preemption: a new speak cancels the current one.
    if (this.active !== null) {
      const prev = this.streams.get(this.active);
      if (prev) prev.closeCancelled({ type: "cancelled", speakId: this.active });
    }
    this.active = speakId;
    const stream = new EventStream<EngineEvent>();
    this.streams.set(speakId, stream);

    const scripted = this.script?.(speakId);
    if (scripted) {
      const deliver = (): void => {
        for (const ev of scripted) stream.push(ev);
        stream.close();
      };
      if (this.schedule === "tick") queueMicrotask(deliver);
      else deliver();
    }

    yield* stream;
  }

  cancel(): void {
    this.cancelCount += 1;
    if (this.active === null) return;
    const stream = this.streams.get(this.active);
    const speakId = this.active;
    this.active = null;
    if (stream) stream.closeCancelled({ type: "cancelled", speakId });
  }

  /** Push one event onto a speak's stream (manual driving). Terminal events close it. */
  push(speakId: number, ev: EngineEvent): void {
    const stream = this.streams.get(speakId);
    if (!stream) return;
    stream.push(ev);
    if (isEngineEventTerminal(ev)) stream.close();
  }
}

/** Drain an AsyncIterable into an array, like tests/engine-webspeech.test.ts. */
export const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

/** Let queued microtasks / scripted "tick" events run. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));