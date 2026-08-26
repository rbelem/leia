import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "./router";
import { chromeOffscreen } from "../probes/chrome-apis";
import { handleTtsProbe } from "../probes/tts-probe";
import {
  handleFfPlaybackKeepalive,
  handleFfPlaybackProbe,
} from "../probes/ff-playback";

// --- T2 spike probes: offscreen document bootstrap (Chrome only) ---
let offscreenReady: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
  const offscreen = chromeOffscreen();
  if (!offscreen) {
    return Promise.reject(new Error("offscreen API unavailable — Chrome 109+ only"));
  }
  offscreenReady ??= offscreen
    .createDocument({
      url: "probes/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "T2 spike: host speechSynthesis audio probes",
    })
    .catch((err: unknown): void => {
      // Reuse a document the manifest already created; only real failures retry.
      if (String(err).includes("Only a single offscreen document may be created")) return;
      offscreenReady = null;
      throw err;
    });
  return offscreenReady;
}

browser.runtime.onMessage.addListener(async (msg: unknown): Promise<RouterReply | undefined> => {
  if (!isRouterMessage(msg)) return;
  if (msg.type === "leia:page-info") {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, replyType: "leia:page-info", error: "no active tab" };
      const info = await browser.tabs.sendMessage(tab.id, { type: "leia:page-info" });
      return { ok: true, replyType: "leia:page-info", data: info };
    } catch (err) {
      return { ok: false, replyType: "leia:page-info", error: String(err) };
    }
  }

  // --- T2 spike probe entry points (no product behavior; see docs/spike-*.md) ---
  if (msg.type === "leia:probe-result") {
    // Streamed results from the offscreen document (and future probe contexts).
    console.log("[leia probe]", (msg as { probe?: string }).probe, msg.data);
    return undefined;
  }
  if (msg.type === "leia:probe-voices" || msg.type === "leia:probe-speak" || msg.type === "leia:probe-cancel") {
    try {
      await ensureOffscreenDocument();
      const data = await Promise.race([
        browser.runtime.sendMessage(msg),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("probe timed out after 30s")), 30_000),
        ),
      ]);
      return { ok: true, replyType: msg.type, data };
    } catch (err) {
      return { ok: false, replyType: msg.type, error: String(err) };
    }
  }
  if (msg.type === "leia:tts-probe") {
    return handleTtsProbe();
  }
  if (msg.type === "leia:ff-playback") {
    return handleFfPlaybackProbe();
  }
  if (msg.type === "leia:ff-playback-keepalive") {
    return handleFfPlaybackKeepalive();
  }

  return routeMessage(msg) ?? undefined;
});