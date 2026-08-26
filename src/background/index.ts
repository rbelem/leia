import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "./router";
import { chromeOffscreen } from "../probes/chrome-apis";
import { handleTtsProbe } from "../probes/tts-probe";
import {
  handleFfPlaybackKeepalive,
  handleFfPlaybackProbe,
} from "../probes/ff-playback";
import { chromeAudioEngine, resolveAudioEngine } from "../audio/owner";
import { ReaderSession, type SessionEvent, type TokenText } from "../reader/session";
import type { EngineEvent, TextEngine } from "../reader/contract";

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

// --- Reader (T2): one active session globally, state in storage.session ---

const engine = resolveAudioEngine();
const sessionStorage = {
  get: (key: string) => browser.storage.session.get(key) as Promise<Record<string, unknown>>,
  set: (items: Record<string, unknown>) => browser.storage.session.set(items),
  remove: (key: string) => browser.storage.session.remove(key),
};

let sessionPromise: Promise<ReaderSession> | null = null;

async function getSession(): Promise<ReaderSession> {
  sessionPromise ??= ReaderSession.load(engine, sessionStorage, emitSessionEvent);
  return sessionPromise;
}

async function emitSessionEvent(ev: SessionEvent): Promise<void> {
  if (ev.type === "state") {
    await broadcast({ type: "leia:session:state", status: ev.status });
    return;
  }
  if (ev.type === "highlight") {
    await broadcast({
      type: "leia:highlight:set",
      sessionId: ev.sessionId,
      from: ev.from,
      to: ev.to,
      ...(ev.word ? { word: ev.word } : {}),
    });
    return;
  }
  await broadcast({ type: "leia:highlight:clear", sessionId: ev.sessionId });
}

async function broadcast(msg: Record<string, unknown>): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((t) => (t.id === undefined ? [] : [browser.tabs.sendMessage(t.id, msg).catch(() => {})])),
  );
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

  // --- Reader control (T2) ---
  if (msg.type === "leia:reader:start") {
    try {
      const s = await getSession();
      let tokens = (msg as { tokens?: TokenText[] }).tokens;
      let captureTabId: number | undefined;
      let captureId: number | undefined;
      if (!tokens || tokens.length === 0) {
        // Toolbar-action fallback: capture the active tab's selection.
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { ok: false, replyType: "leia:reader:start", error: "no active tab" };
        captureTabId = tab.id;
        const reply = (await browser.tabs.sendMessage(captureTabId, { type: "leia:selection:capture" })) as
          | RouterReply
          | undefined;
        if (!reply?.ok) {
          return { ok: false, replyType: "leia:reader:start", error: (reply as RouterReply | undefined)?.error ?? "no selection" };
        }
        tokens = (reply.data as { tokens: TokenText[] }).tokens;
        captureId = (reply.data as { captureId?: number }).captureId;
      }
      const overrides = {
        voiceName: msg.voiceName as string | null | undefined,
        rate: msg.rate as number | undefined,
      };
      const status = await s.start(tokens, overrides);
      if (captureTabId !== undefined && captureId !== undefined) {
        const locale = (await s.voiceLang()) ?? navigator.language;
        void browser.tabs
          .sendMessage(captureTabId, {
            type: "leia:selection:bind",
            sessionId: status.sessionId,
            captureId,
            locale,
          })
          .catch(() => {});
      }
      return { ok: true, replyType: "leia:reader:start", data: status };
    } catch (err) {
      return { ok: false, replyType: "leia:reader:start", error: String(err) };
    }
  }

  if (
    msg.type === "leia:reader:pause" ||
    msg.type === "leia:reader:resume" ||
    msg.type === "leia:reader:stop" ||
    msg.type === "leia:reader:seek"
  ) {
    try {
      const s = await getSession();
      const status =
        msg.type === "leia:reader:pause"
          ? await s.pause()
          : msg.type === "leia:reader:resume"
            ? await s.resume()
            : msg.type === "leia:reader:seek"
              ? await s.seek((msg as { token?: number }).token as number)
              : await s.stop();
      return { ok: true, replyType: msg.type, data: status };
    } catch (err) {
      return { ok: false, replyType: msg.type, error: String(err) };
    }
  }
  if (msg.type === "leia:reader:status") {
    const s = await getSession();
    return { ok: true, replyType: "leia:reader:status", data: s.status() };
  }
  if (msg.type === "leia:reader:voices") {
    return { ok: true, replyType: "leia:reader:voices", data: await engine.getVoices() };
  }
  if (msg.type === "leia:reader:prefs") {
    const s = await getSession();
    const prefs: Partial<{ voiceName: string | null; rate: number; engine: string | null }> = {};
    if ("voiceName" in msg) prefs.voiceName = msg.voiceName as string | null;
    if ("rate" in msg) prefs.rate = msg.rate as number;
    if ("engine" in msg) prefs.engine = msg.engine as string | null;
    const status = await s.setPrefs(prefs);
    return { ok: true, replyType: "leia:reader:prefs", data: status };
  }

  // --- Settings (T14): per-family capability disclosure + theme relay ---
  if (msg.type === "leia:audio:families") {
    // ponytail: engines without families() answer as the single default
    // family; EngineHub.families() and the Chrome proxy both implement it.
    const withFamilies = engine as TextEngine & { families?: () => unknown };
    const data =
      typeof withFamilies.families === "function"
        ? await withFamilies.families()
        : [{ family: "web-speech", capabilities: engine.capabilities }];
    return { ok: true, replyType: "leia:audio:families", data };
  }
  if (msg.type === "leia:theme:set") {
    await broadcast({ type: "leia:theme:set", theme: msg.theme });
    return { ok: true, replyType: "leia:theme:set" };
  }

  // --- Audio events from the Chrome offscreen document (ADR-0002) ---
  if (msg.type === "leia:audio:event") {
    chromeAudioEngine().pushEvent(msg as unknown as EngineEvent);
    return undefined;
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