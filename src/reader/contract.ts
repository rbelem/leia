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
  | { type: "cancelled"; speakId: number };

export interface TextEngine {
  /** Engine family identifier — capability disclosure per ADR-0003 later. */
  readonly family: string;
  getVoices(): Promise<VoiceInfo[]>;
  /**
   * Speak one chunk. Yields events until the chunk ends; the iterable
   * completes after the terminal event. Only one active speak at a time —
   * a new `speak()` preempts the current one (which yields `cancelled`).
   */
  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent>;
  /** Interrupt the current chunk; its stream yields `cancelled` and closes. */
  cancel(): void;
}

export function isEngineEventTerminal(ev: EngineEvent): boolean {
  return ev.type !== "start";
}