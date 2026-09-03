// SPDX-License-Identifier: MPL-2.0
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
import { ElevenLabsEngine } from "../audio/engine-elevenlabs";
import { AzureEngine } from "../audio/engine-azure";
import { OpenAIEngine } from "../audio/engine-openai";
import { XaiEngine } from "../audio/engine-xai";
import { MistralEngine } from "../audio/engine-mistral";
import { GeminiEngine } from "../audio/engine-gemini";
import { KittenEngine } from "../audio/kitten/engine-kitten";
import { LocalEngine } from "../audio/engine-local";
import { BUILT_IN_PROFILES, probeProfile } from "../audio/local-profiles";
import { readProviderKey, setSnapshot, snapshotLocalProfiles, type KeystoreProfile } from "../audio/keystore";
import { EngineHub, type EngineFamilyInfo } from "../audio/hub";
import type { EngineCapabilities } from "../reader/contract";

// Provider keys do NOT come from storage.local here: some Chrome builds
// (flatpak Chrome 152 observed) give offscreen documents no chrome.storage
// at all, so every read throws and all provider-keyed engines yield 0
// voices. Instead the service worker (which has working storage) rides a
// fresh in-memory snapshot on every forwarded leia:audio:* message and the
// getKey closures below read the snapshot (src/audio/keystore.ts).

const engine = new EngineHub();
engine.register("web-speech", new WebSpeechEngine(speechSynthesis), { default: true });
engine.register("minimax", new MiniMaxEngine({ getKey: readProviderKey("leia:settings:minimaxKey") }));
engine.register("elevenlabs", new ElevenLabsEngine({ getKey: readProviderKey("leia:settings:elevenlabsKey") }));
engine.register("azure", new AzureEngine({
  getKey: readProviderKey("leia:settings:azureKey"),
  getRegion: readProviderKey("leia:settings:azureRegion"),
}));
engine.register("openai", new OpenAIEngine({ getKey: readProviderKey("leia:settings:openaiKey") }));
engine.register("xai", new XaiEngine({ getKey: readProviderKey("leia:settings:xaiKey") }));
engine.register("mistral", new MistralEngine({ getKey: readProviderKey("leia:settings:mistralKey") }));
engine.register("gemini", new GeminiEngine({ getKey: readProviderKey("leia:settings:geminiKey") }));
// kitten-local (ticket 06): lazy — the model worker spawns on first speak.
engine.register("kitten-local", new KittenEngine());

/**
 * Offscreen variant of registerLocalEngines (engine-local.ts): its storage
 * read of custom profiles throws in the offscreen document (no
 * chrome.storage — see keystore.ts), which used to kill even the built-in
 * registrations. Custom profiles come from the key snapshot instead;
 * built-in probing stays fetch-based and works everywhere.
 */
async function registerLocalEnginesFromSnapshot(hub: EngineHub): Promise<void> {
  const profiles = [...BUILT_IN_PROFILES, ...snapshotLocalProfiles()];
  for (const profile of profiles) {
    const { online, caps } = await probeProfile(profile.baseUrl);
    if (online) hub.register(`local-${profile.id}`, new LocalEngine(profile, caps));
  }
}
void registerLocalEnginesFromSnapshot(engine).catch(() => {}); // lazy boot probe (ADR-0006) — never blocks web-speech

/**
 * Apply the service worker's key snapshot from a forwarded leia:audio:*
 * message. Messages without a snapshot keep the last applied one. Best
 * effort only — a snapshot failure must never break web-speech.
 */
function applySnapshotFromMessage(msg: unknown): void {
  try {
    const t = (msg as { type?: unknown }).type;
    if (typeof t !== "string" || !t.startsWith("leia:audio:")) return;
    const m = msg as { keys?: unknown; localProfiles?: unknown };
    if (m.keys === undefined && m.localProfiles === undefined) return;
    setSnapshot({
      ...(typeof m.keys === "object" && m.keys !== null ? { keys: m.keys as Record<string, string> } : {}),
      ...(Array.isArray(m.localProfiles) ? { localProfiles: m.localProfiles as KeystoreProfile[] } : {}),
    });
  } catch {
    // snapshot is best-effort
  }
}

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

/** Reply to one audio message from the engine hub (see listener below). */
function handleAudioMessage(msg: unknown): unknown {
  switch ((msg as { type: string }).type) {
    case "leia:audio:voices":
      return engine.getVoices();
    case "leia:audio:capabilities":
      return engine.capabilities as EngineCapabilities;
    case "leia:audio:families":
      return engine.families() as EngineFamilyInfo[];
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
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return undefined;
  applySnapshotFromMessage(msg); // first: refresh the in-memory key snapshot (if the message carries one)
  return handleAudioMessage(msg);
});