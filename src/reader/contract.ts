/**
 * Voice-engine adapter contract (ADR-0001). Event-oriented so engines that
 * stream timing (providers, local models) and engines that only fire
 * boundary/start/end events (Web Speech) speak the same language.
 * Formalized by T6; this file is the working v0.
 */

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  /** Engine family the voice belongs to (popup groups by it; engines route by it). */
  family: string;
}

export interface SpeakOptions {
  /** Voice by name (engine family-specific); null = engine default. */
  voiceName: string | null;
  /** Playback rate multiplier (0.5–3). */
  rate: number;
}

/**
 * Events an engine yields per `speak()` call. A stream ends either by
 * completing (last event `end`), by `cancelled` (a `cancel()` or a newer
 * speak preempted it), or by `error`.
 */
export type EngineEvent =
  | { type: "start"; speakId: number }
  | { type: "end"; speakId: number }
  | { type: "error"; speakId: number; message: string }
  | { type: "cancelled"; speakId: number }
  | {
      /** Word-level timing (engines with wordTiming capability). Char offsets
       * are relative to the chunk text the engine received — the march layer
       * maps them onto the page word index. Not terminal. */
      type: "word";
      speakId: number;
      begin: number;
      end: number;
    };

export interface EngineCapabilities {
  /** Engine emits word events with chunk-relative char offsets. */
  wordTiming: boolean;
  /** Engine can stream audio as it is generated (unused by v0 consumers). */
  streaming: boolean;
  costClass: "free" | "paid";
  privacyClass: "local" | "provider";
}

export interface TextEngine {
  /** Engine family identifier — capability disclosure per ADR-0003 later. */
  readonly family: string;
  readonly capabilities: EngineCapabilities;
  getVoices(): Promise<VoiceInfo[]>;
  /**
   * Speak one chunk. Yields events until the chunk ends; the iterable
   * completes after the terminal event. Only one active speak at a time —
   * a new `speak()` preempts the current one (which yields `cancelled`).
   */
  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent>;
  /** Interrupt the current chunk; its stream yields `cancelled` and closes. */
  cancel(): void;
  /**
   * Synthesize ahead for a FUTURE speak() with identical text+options
   * (pipelining, ADR-0003). Implementers may cache; cancel() discards
   * caches. Absent = no pipelining.
   */
  prefetch?(text: string, options: SpeakOptions): Promise<void>;
  /**
   * Engine-family switch hook (provider engines / hubs). `family` is the
   * target family name; unknown families are a no-op. Absent = single-family.
   */
  selectFamily?(family: string): void;
}

export function isEngineEventTerminal(ev: EngineEvent): boolean {
  return ev.type !== "start" && ev.type !== "word";
}