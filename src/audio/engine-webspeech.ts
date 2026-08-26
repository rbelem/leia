/**
 * Web Speech engine — one utterance per chunk, event-driven, sentence
 * granularity. Cancellation is `cancel()` + stream closure (never
 * `speechSynthesis.pause()`, per T2 item 3 — pause/resume is
 * cancel-and-replay-from-token at the session level).
 *
 * Platform-agnostic: takes the `speechSynthesis` object it should bind to,
 * so the same class runs in the Chrome offscreen document and the Firefox
 * event page (ADR-0002).
 */
import { EventStream } from "../reader/event-stream";
import type { EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";

export interface SpeechSynthesisLike {
  getVoices(): SpeechSynthesisVoice[];
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

const VOICES_WAIT_MS = 1500;

export class WebSpeechEngine implements TextEngine {
  readonly family = "web-speech";
  private active: { speakId: number; stream: EventStream<EngineEvent> } | null = null;

  constructor(private readonly synth: SpeechSynthesisLike) {}

  async getVoices(): Promise<VoiceInfo[]> {
    const first = this.synth.getVoices();
    if (first.length > 0) return mapVoices(first);
    // Voices populate asynchronously on most platforms.
    return new Promise((resolve) => {
      const started = Date.now();
      const poll = (): void => {
        const voices = this.synth.getVoices();
        if (voices.length > 0 || Date.now() - started > VOICES_WAIT_MS) {
          resolve(mapVoices(voices));
        } else {
          setTimeout(poll, 100);
        }
      };
      poll();
    });
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream };
    if (wasActive) {
      // Preempt: stop the old utterance (its error handler closes the old stream).
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      this.synth.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = options.rate;
    if (options.voiceName) {
      const voice = this.synth.getVoices().find((v) => v.name === options.voiceName);
      if (voice) utterance.voice = voice;
    }

    utterance.onstart = () => stream.push({ type: "start", speakId });
    utterance.onend = () => {
      stream.push({ type: "end", speakId });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };
    utterance.onerror = (e) => {
      if (e.error === "canceled" || e.error === "interrupted") {
        stream.closeCancelled({ type: "cancelled", speakId });
      } else {
        stream.push({ type: "error", speakId, message: e.error });
        stream.close();
      }
      if (this.active?.speakId === speakId) this.active = null;
    };

    this.synth.speak(utterance);
    return stream;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
    this.synth.cancel();
  }
}

function mapVoices(voices: SpeechSynthesisVoice[]): VoiceInfo[] {
  return voices.map((v) => ({ name: v.name, lang: v.lang, localService: v.localService }));
}