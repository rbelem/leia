/**
 * Product offscreen document (Chrome audio owner, ADR-0002). Hosts the real
 * WebSpeechEngine and answers audio messages forwarded by the service
 * worker; events stream back as `leia:audio:event` messages. Separate from
 * the spike probe document (src/probes/) — only one offscreen document may
 * exist per extension, so a probe run and a product session are mutually
 * exclusive in a profile (probes fail cleanly while a session is active).
 */
import browser from "webextension-polyfill";
import { WebSpeechEngine } from "../audio/engine-webspeech";

const engine = new WebSpeechEngine(speechSynthesis);

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