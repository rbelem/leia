// SPDX-License-Identifier: MPL-2.0
/**
 * Web Speech engine — one utterance per chunk, event-driven, word-granularity
 * highlight marching on estimated timing, corrected by utterance boundary
 * events (drift re-anchor; see `speak`). Cancellation is `cancel()` + stream
 * closure (never `speechSynthesis.pause()`, per T2 item 3 — pause/resume is
 * cancel-and-replay-from-token at the session level).
 *
 * Platform-agnostic: takes the `speechSynthesis` object it should bind to,
 * so the same class runs in the Chrome offscreen document and the Firefox
 * event page (ADR-0002).
 */
import { EventStream } from "../reader/event-stream";
import type { EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { wordSpans } from "../reader/sentences";

export interface SpeechSynthesisLike {
  getVoices(): SpeechSynthesisVoice[];
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

const VOICES_WAIT_MS = 1500;

// Word-duration estimation heuristics. ponytail: not phoneme timing — plain
// chars/rate scaling with hard bounds; utterance.onboundary re-anchors the
// march when the engine's real progress drifts ≥ 1 word, which keeps the
// highlight within ~1 word of the audio across long chunks.
const MS_PER_CHAR = 75; // ≈13 chars/s at rate 1 (~160wpm)
const MIN_WORD_MS = 60;
const MAX_WORD_MS = 800;

export class WebSpeechEngine implements TextEngine {
  readonly family = "web-speech";
  readonly capabilities = { wordTiming: true, streaming: false, costClass: "free", privacyClass: "local" } as const;
  private active: { speakId: number; stream: EventStream<EngineEvent>; stopMarch: () => void } | null = null;

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

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(text);
    } catch (err) {
      console.error("[leia-debug] SpeechSynthesisUtterance ctor threw:", err);
      throw err;
    }
    console.error(`[leia-debug] speak #${speakId} len=${text.length} voice=${options.voiceName ?? "default"}`);
    // Trust boundary: Firefox's rate setter throws on non-finite values.
    utterance.rate = Number.isFinite(options.rate) ? options.rate : 1;
    let locale = navigator.language || "en";
    if (options.voiceName) {
      const voice = this.synth.getVoices().find((v) => v.name === options.voiceName);
      if (voice) {
        utterance.voice = voice;
        locale = voice.lang;
      }
    }

    // --- estimated word march ---
    // Schedule: word i fires at start + cum[i] (cum[0] = 0 → word 0 fires
    // immediately on start). Offsets are wordSpans offsets over `text`, which
    // is exactly what the session/scope relay expects.
    const words = wordSpans(text, locale);
    const cum = new Array<number>(words.length);
    for (let i = 0, acc = 0; i < words.length; i += 1) {
      cum[i] = acc;
      acc += Math.min(MAX_WORD_MS, Math.max(MIN_WORD_MS, (words[i].text.length * MS_PER_CHAR) / options.rate));
    }
    let next = 0; // first word not yet emitted
    let baseAt = 0; // anchor time; word i fires at baseAt + cum[i] − cum[anchorLast]
    let anchorLast = 0;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let dead = false;

    const stopMarch = (): void => {
      dead = true;
      for (const t of timers) clearTimeout(t);
      timers = [];
    };

    const emit = (i: number): void => {
      next = i + 1;
      stream.push({ type: "word", speakId, begin: words[i].start, end: words[i].end });
    };

    const fireWord = (i: number): void => {
      if (dead || i !== next) return; // stale timer (re-anchor dropped it)
      emit(i);
    };

    const scheduleFrom = (i: number): void => {
      for (const t of timers) clearTimeout(t);
      timers = [];
      for (let w = i; w < words.length; w += 1) {
        const delay = baseAt + cum[w] - cum[anchorLast] - Date.now();
        timers.push(setTimeout(() => fireWord(w), Math.max(0, delay)));
      }
    };

    /**
     * Real engine progress (speechSynthesis boundary event ≈ the engine just
     * passed that char). Re-anchor the remaining schedule at now when it
     * disagrees with the estimate by ≥ one word; snap to the boundary word
     * (skip the dropped spans) so the highlight stays ≤ 1 word out of sync.
     */
    const boundary = (charIndex: number): void => {
      if (dead || next === 0 || words.length < 2 || next >= words.length) return;
      const j = words.findIndex((w) => w.end > charIndex); // word the engine actually reached
      if (j < 0) return;
      const expected = words[next].start;
      if (Math.abs(charIndex - expected) < words[j].text.length) return; // noise
      const now = Date.now();
      if (j >= next) {
        emit(j); // snap the highlight forward; skipped spans are dropped
        anchorLast = j;
      } else {
        anchorLast = next - 1; // engine behind: never march backward, just re-time the rest
      }
      baseAt = now;
      scheduleFrom(next);
    };

    utterance.onstart = () => {
      console.error(`[leia-debug] utterance #${speakId} START`);
      stream.push({ type: "start", speakId });
      if (words.length < 2) return; // sentence marching, silently
      baseAt = Date.now();
      anchorLast = 0;
      emit(0); // word 0 fires immediately (t_0 = 0)
      scheduleFrom(1);
    };
    utterance.onboundary = (e) => boundary(e.charIndex);
    utterance.onend = () => {
      console.error(`[leia-debug] utterance #${speakId} END`);
      stopMarch();
      stream.push({ type: "end", speakId });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };
    utterance.onerror = (e) => {
      console.error(`[leia-debug] utterance #${speakId} ERROR: ${e.error}`);
      stopMarch();
      if (e.error === "canceled" || e.error === "interrupted") {
        stream.closeCancelled({ type: "cancelled", speakId });
      } else {
        stream.push({ type: "error", speakId, message: e.error });
        stream.close();
      }
      if (this.active?.speakId === speakId) this.active = null;
    };

    this.active = { speakId, stream, stopMarch };
    if (wasActive) {
      // Preempt: stop the old utterance (its error handler closes the old stream).
      wasActive.stopMarch();
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      this.synth.cancel();
    }

    this.synth.speak(utterance);
    return stream;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.stopMarch();
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
    }
    this.synth.cancel();
  }
}

function mapVoices(voices: SpeechSynthesisVoice[]): VoiceInfo[] {
  return voices.map((v) => ({ name: v.name, lang: v.lang, localService: v.localService, family: "web-speech" }));
}