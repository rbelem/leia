/**
 * Product offscreen document (Chrome audio owner, ADR-0002). Hosts the real
 * engine hub (Web Speech default + MiniMax provider) and answers audio
 * messages forwarded by the service worker; events stream back as
 * `leia:audio:event` messages. Separate from the spike probe document
 * (src/probes/) — only one offscreen document may exist per extension, so a
 * probe run and a product session are mutually exclusive in a profile
 * (probes fail cleanly while a session is active).
 */
import browser from "webextension-polyfill";
import { WebSpeechEngine } from "../audio/engine-webspeech";
import { MiniMaxEngine } from "../audio/engine-minimax";
import { EngineHub } from "../audio/hub";
import type { EngineCapabilities } from "../reader/contract";

const engine = new EngineHub();
engine.register("web-speech", new WebSpeechEngine(speechSynthesis), { default: true });
engine.register(
  "minimax",
  new MiniMaxEngine({
    getKey: async (): Promise<string | null> => {
      try {
        const got = (await browser.storage.local.get("leia:settings:minimaxKey")) as Record<string, unknown>;
        const v = got["leia:settings:minimaxKey"];
        return typeof v === "string" && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
  }),
);

async function speakAndStream(msg: {
  speakId: number;
  text: string;
  voiceName: string | null;
  rate: number;
}): Promise<void> {
  for await (const ev of engine.speak(msg.text, msg.speakId, { voiceName: msg.voiceName, rate: msg.rate })) {
    await browser.runtime
      .sendMessage({ type: "leia:audio:event", ...(ev as object) })
      .catch(() => {
        // SW gone mid-stream; session state in storage.session covers recovery.
      });
  }
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return undefined;
  switch ((msg as { type: string }).type) {
    case "leia:audio:voices":
      return engine.getVoices();
    case "leia:audio:capabilities":
      return engine.capabilities as EngineCapabilities;
    case "leia:audio:family": {
      const m = msg as unknown as { family?: string };
      if (typeof m.family === "string") engine.select(m.family);
      return engine.capabilities as EngineCapabilities;
    }
    case "leia:audio:speak": {
      const m = msg as unknown as { speakId: number; text: string; voiceName: string | null; rate: number };
      void speakAndStream(m);
      return undefined; // streaming; reply arrives as leia:audio:event messages
    }
    case "leia:audio:cancel":
      engine.cancel();
      return { ok: true };
    default:
      return undefined;
  }
});