/**
 * T2 spike: `chrome.tts` comparison probe (service-worker side, Chrome only).
 * Contender against the offscreen speechSynthesis probe — see
 * docs/spike-offscreen-speech.md §2. On Firefox the API is absent and the
 * probe reports that instead.
 */
import { chromeTts, type TtsVoice } from "./chrome-apis";

const SENTENCE = "hello world, this is leia.";

export interface ProbeReply {
  ok: boolean;
  replyType: string;
  data?: unknown;
  error?: string;
}

interface TtsProbeData {
  final: string;
  elapsedMs: number;
  errorMessage?: string;
  events: string[];
  voices: string[];
}

export async function handleTtsProbe(): Promise<ProbeReply> {
  const tts = chromeTts();
  if (!tts) {
    return { ok: false, replyType: "leia:tts-probe", error: "chrome.tts unavailable (Firefox only, or speech stack disabled — e.g. headless Chrome)" };
  }

  const voices = await new Promise<TtsVoice[]>((resolve) => {
    tts.getVoices(resolve);
  });
  console.log("[leia tts-probe] voices:", voices.map((v) => `${v.voiceName} (${v.lang}, remote=${v.remote})`));

  const events: string[] = [];
  const startedAt = Date.now();

  const result = await new Promise<Pick<TtsProbeData, "final" | "elapsedMs" | "errorMessage">>((resolve) => {
    const done = (final: string, errorMessage?: string) =>
      resolve({ final, elapsedMs: Date.now() - startedAt, errorMessage });
    try {
      tts.speak(SENTENCE, {
        onEvent: (ev) => {
          const line =
            `${ev.type}@` +
            `${typeof ev.charIndex === "number" ? ev.charIndex : "-"}/` +
            `${typeof ev.charLength === "number" ? ev.charLength : "-"}`;
          events.push(line);
          console.log("[leia tts-probe]", line);
          if (["end", "error", "interrupted", "cancelled"].includes(ev.type)) {
            done(ev.type, ev.errorMessage);
          }
        },
      });
    } catch (err) {
      done("exception", String(err));
    }
    // Safety net: some platforms never deliver a terminal event.
    setTimeout(() => done("timeout"), 20_000);
  });

  return {
    ok: true,
    replyType: "leia:tts-probe",
    data: {
      ...result,
      events,
      voices: voices.map((v) => v.voiceName),
    } satisfies TtsProbeData,
  };
}