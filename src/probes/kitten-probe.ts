// SPDX-License-Identifier: MPL-2.0
/**
 * Ticket 06 manual verification probe: one real kitten-local synthesis
 * (model download → cache → ORT inference → WAV playback) driven through
 * the same KittenEngine the product session uses. Runs in the Firefox event
 * page directly and in Chrome's probe offscreen document (background forwards
 * `leia:probe-kitten` there); logs each stage and streams results back as
 * `leia:probe-result` messages like the T2 probes.
 */
import { KittenEngine } from "../audio/kitten/engine-kitten";
import type { EngineEvent } from "../reader/contract";

const SENTENCE = "Hello, I am Leia speaking on device.";

export interface KittenProbeData {
  /** First speak → audio start: asset download (first run only) + init + inference. */
  readyMs: number;
  totalMs: number;
  events: string[];
  error?: string;
}

export async function handleKittenProbe(text: string = SENTENCE, voice: string | null = null): Promise<KittenProbeData> {
  const events: string[] = [];
  const engine = new KittenEngine(); // real worker + real DOM audio
  const startedAt = Date.now();
  let readyMs = -1;

  const voices = await engine.getVoices();
  console.log("[leia kitten-probe] voices:", voices.map((v) => v.name));

  for await (const ev of engine.speak(text, -101, { voiceName: voice, rate: 1 })) {
    const e = ev as EngineEvent;
    if (e.type === "start") {
      readyMs = Date.now() - startedAt;
      events.push(`start`);
      console.log("[leia kitten-probe] audio started", { readyMs });
    } else if (e.type === "end") {
      const data: KittenProbeData = { readyMs, totalMs: Date.now() - startedAt, events };
      console.log("[leia kitten-probe] done", data);
      return data;
    } else if (e.type === "error") {
      const data: KittenProbeData = { readyMs, totalMs: Date.now() - startedAt, events, error: e.message };
      console.log("[leia kitten-probe] FAILED", data);
      return data;
    }
  }
  return { readyMs, totalMs: Date.now() - startedAt, events, error: "stream ended without end/error" };
}
