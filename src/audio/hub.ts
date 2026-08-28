// SPDX-License-Identifier: MPL-2.0
/**
 * EngineHub — multiplexes several TextEngines (families) behind one
 * TextEngine. One family is current: speak/cancel/capabilities route to it,
 * and `selectFamily` switches. getVoices() merges every registered engine
 * (default family first, stable order; rejecting engines are skipped — e.g.
 * a provider with no key).
 */
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";

export interface EngineFamilyInfo {
  family: string;
  capabilities: EngineCapabilities;
}

const NO_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "free",
  privacyClass: "local",
};

export class EngineHub implements TextEngine {
  readonly family = "hub";
  private readonly engines = new Map<string, TextEngine>();
  private readonly order: string[] = [];
  private defaultFamily: string | null = null;
  private current: TextEngine | null = null;
  /** The engine a speak() call was routed to — cancel() must stop it even if the current family changed mid-speech. */
  private cancelTarget: TextEngine | null = null;

  register(family: string, engine: TextEngine, opts: { default?: boolean } = {}): void {
    this.engines.set(family, engine);
    this.order.push(family);
    if (opts.default || this.current === null) {
      this.defaultFamily = family;
      this.current = engine;
    }
  }

  /** Switch the current family. Unknown families are a no-op. */
  select(family: string): void {
    const engine = this.engines.get(family);
    if (engine) this.current = engine;
  }

  get currentFamily(): string | null {
    return this.current?.family ?? null;
  }

  get capabilities(): EngineCapabilities {
    return this.current?.capabilities ?? NO_CAPABILITIES;
  }

  selectFamily(family: string): void {
    this.select(family);
  }

  /** Registered families with their capabilities, in registration order (settings UI). */
  families(): EngineFamilyInfo[] {
    return this.order.map((family) => ({ family, capabilities: this.engines.get(family)!.capabilities }));
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const settled = await Promise.allSettled(this.order.map((f) => this.engines.get(f)!.getVoices()));
    const merged: VoiceInfo[] = [];
    // Default family first; relative order otherwise stable.
    const ordered = [...this.order].sort((a, b) =>
      a === this.defaultFamily ? -1 : b === this.defaultFamily ? 1 : 0,
    );
    for (const family of ordered) {
      const r = settled[this.order.indexOf(family)];
      if (r.status === "fulfilled") merged.push(...r.value);
    }
    return merged;
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    if (!this.current) throw new Error("no engine registered");
    this.cancelTarget = this.current;
    return this.current.speak(text, speakId, options);
  }

  cancel(): void {
    const target = this.cancelTarget ?? this.current;
    this.cancelTarget = null;
    target?.cancel();
  }
}