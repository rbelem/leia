// SPDX-License-Identifier: MPL-2.0
/**
 * T2 spike: offscreen document (reason AUDIO_PLAYBACK) hosting speechSynthesis
 * probes. Answers typed messages forwarded by the service worker and streams
 * results back as `leia:probe-result` messages (logged by the SW) plus the
 * message reply. See docs/spike-offscreen-speech.md.
 *
 *   leia:probe-voices — getVoices, sync-vs-voiceschanged population, names
 *   leia:probe-speak  — speak a fixed sentence with the default voice
 *   leia:probe-cancel — cancel any running utterance
 */
import browser from "webextension-polyfill";
import { handleKittenProbe } from "./kitten-probe";

const SENTENCE = "hello world, this is leia.";

function report(probe: string, data: unknown): void {
  console.log("[leia offscreen]", probe, data);
  void browser.runtime.sendMessage({ type: "leia:probe-result", probe, data });
}

interface VoicesResult {
  voices: SpeechSynthesisVoice[];
  populatedSync: boolean;
  waitMs: number;
}

function waitForVoices(): Promise<VoicesResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const first = speechSynthesis.getVoices();
    if (first.length > 0) {
      resolve({ voices: first, populatedSync: true, waitMs: 0 });
      return;
    }
    const onChanged = () => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        speechSynthesis.removeEventListener("voiceschanged", onChanged);
        resolve({ voices, populatedSync: false, waitMs: Date.now() - started });
      }
    };
    speechSynthesis.addEventListener("voiceschanged", onChanged);
    // Fallback: report whatever is there if voices never populate.
    setTimeout(() => {
      speechSynthesis.removeEventListener("voiceschanged", onChanged);
      resolve({ voices: speechSynthesis.getVoices(), populatedSync: false, waitMs: Date.now() - started });
    }, 1500);
  });
}

async function probeVoices(): Promise<unknown> {
  const { voices, populatedSync, waitMs } = await waitForVoices();
  const data = {
    populatedSync,
    waitMs,
    count: voices.length,
    localCount: voices.filter((v) => v.localService).length,
    names: voices.slice(0, 5).map((v) => `${v.name} (${v.lang}, local=${v.localService})`),
  };
  report("voices", data);
  return data;
}

function probeSpeak(): Promise<unknown> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const events: string[] = [];
    const u = new SpeechSynthesisUtterance(SENTENCE);
    u.onstart = () => {
      events.push(`start@${Date.now() - startedAt}ms`);
      report("speak:start", { elapsedMs: Date.now() - startedAt });
    };
    u.onboundary = (e) => {
      const data = { charIndex: e.charIndex, charLength: e.charLength, elapsedMs: Date.now() - startedAt };
      events.push(`boundary@${e.charIndex}:${e.charLength}`);
      report("speak:boundary", data);
    };
    u.onend = () => {
      const elapsedMs = Date.now() - startedAt;
      report("speak:end", { elapsedMs, boundaries: events.filter((x) => x.startsWith("boundary")).length });
      resolve({ stage: "end", elapsedMs, events });
    };
    u.onerror = (e) => {
      const elapsedMs = Date.now() - startedAt;
      report("speak:error", { error: e.error, elapsedMs });
      resolve({ stage: "error", error: e.error, elapsedMs, events });
    };
    speechSynthesis.speak(u);
  });
}

function probeCancel(): unknown {
  speechSynthesis.cancel();
  const data = { stage: "canceled", at: Date.now() };
  report("cancel", data);
  return data;
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return undefined;
  switch ((msg as { type: string }).type) {
    case "leia:probe-voices":
      return probeVoices();
    case "leia:probe-speak":
      return probeSpeak();
    case "leia:probe-cancel":
      return probeCancel();
    case "leia:probe-kitten": {
      const m = msg as unknown as { text?: string; voice?: string | null };
      return handleKittenProbe(m.text, m.voice ?? null);
    }
    default:
      return undefined;
  }
});

console.log("[leia offscreen] ready", navigator.userAgent);