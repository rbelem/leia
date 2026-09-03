// SPDX-License-Identifier: MPL-2.0
import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterMessage, type RouterReply } from "./router";
import { chromeOffscreen } from "../probes/chrome-apis";
import { handleTtsProbe } from "../probes/tts-probe";
import {
  handleFfPlaybackKeepalive,
  handleFfPlaybackProbe,
} from "../probes/ff-playback";
import { handleKittenProbe } from "../probes/kitten-probe";
import { chromeAudioEngine, audioClockMs, isChrome, resolveAudioEngine } from "../audio/owner";
import { ReaderSession, type SessionEvent, type TokenText } from "../reader/session";
import type { EngineEvent, TextEngine } from "../reader/contract";
import { ResumeStore } from "./resume";

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
// Voice/engine/rate are durable user prefs: session storage is wiped on
// every browser restart, local survives it (same reasoning as resume.ts).
const prefsStorage = {
  get: (key: string) => browser.storage.local.get(key) as Promise<Record<string, unknown>>,
  set: (items: Record<string, unknown>) => browser.storage.local.set(items),
  remove: (key: string) => browser.storage.local.remove(key),
};

let sessionPromise: Promise<ReaderSession> | null = null;

/** Per-URL reading positions (T16) — the only owner of resume.ts reads. */
const resume = new ResumeStore();

/** Preview id must never collide with session speakIds (which start at 1). */
const PREVIEW_SPEAK_ID = -1;
const PREVIEW_SAMPLE = "Hello, I am Leia.";

async function getSession(): Promise<ReaderSession> {
  sessionPromise ??= ReaderSession.load(engine, sessionStorage, emitSessionEvent, prefsStorage);
  return sessionPromise;
}

async function emitSessionEvent(ev: SessionEvent): Promise<void> {
  let msg: Record<string, unknown>;
  if (ev.type === "state") {
    msg = { type: "leia:session:state", status: ev.status };
  } else if (ev.type === "highlight") {
    msg = {
      type: "leia:highlight:set",
      sessionId: ev.sessionId,
      from: ev.from,
      to: ev.to,
      ...(ev.word ? { word: ev.word } : {}),
      ...(ev.timeline ? { timeline: ev.timeline } : {}),
    };
  } else if (ev.type === "error") {
    msg = { type: "leia:session:error", sessionId: ev.sessionId, message: ev.message };
  } else {
    msg = { type: "leia:highlight:clear", sessionId: ev.sessionId };
  }
  // Mirror to extension pages (the popup): tabs.sendMessage only reaches
  // content scripts, but the popup needs the same signals — the first
  // highlight is its only truthful "audio actually started" event.
  void browser.runtime.sendMessage(msg).catch(() => {});
  await broadcast(msg);
}

async function broadcast(msg: Record<string, unknown>): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((t) => (t.id === undefined ? [] : [browser.tabs.sendMessage(t.id, msg).catch(() => {})])),
  );
}

/**
 * Reader start, shared by the message handler and the keyboard shortcut
 * (T18): toolbar/shortcut fallback captures the active tab's scope when no
 * tokens are passed; T17 preserve-position and T16 restore run here too so
 * every entry point gets identical semantics.
 */
interface TabCapture {
  reply?: RouterReply;
  error?: string;
}

/** One capture round-trip; rejections become `error`, undefined replies stay undefined. */
async function sendCapture(tabId: number): Promise<TabCapture> {
  try {
    const reply = (await browser.tabs.sendMessage(tabId, { type: "leia:selection:capture" })) as
      | RouterReply
      | undefined;
    return { reply };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Content-script injection for the capture retry. The activeTab permission is
 * granted by the very action invocation that led here (popup open / toolbar
 * click / shortcut), so no extra host permission is needed.
 */
async function injectReaderScript(tabId: number): Promise<boolean> {
  try {
    const scripting = (browser as unknown as {
      scripting?: { executeScript: (details: { target: { tabId: number }; files: string[] }) => Promise<unknown> };
    }).scripting;
    if (!scripting) return false;
    await scripting.executeScript({ target: { tabId }, files: ["content/index.js"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the tab's read scope with a distinct reason per failure mode
 * (missing/orphaned content script vs capture returned null vs send threw).
 * An undefined reply means no content script answered — the standard state
 * after an extension reload leaves previously-open tabs orphaned — so the
 * reader script is re-injected (activeTab) and the capture retried once.
 */
async function captureTabScope(tabId: number): Promise<TabCapture> {
  let capture = await sendCapture(tabId);
  if (capture.reply === undefined) {
    const injected = await injectReaderScript(tabId);
    if (injected) capture = await sendCapture(tabId);
    else {
      return {
        error: `no leia reader script in this tab and re-injection failed: ${capture.error ?? "tab not injectable"}`,
      };
    }
  }
  if (capture.reply === undefined) {
    capture.error ??= "reader script did not respond after re-injection — reload the page";
  }
  return capture;
}

/** Exported for tests/reader-start.test.ts (the start reply must not voice-gate). */
export async function handleReaderStart(msg: {
  tokens?: TokenText[];
  voiceName?: string | null;
  rate?: number;
}): Promise<RouterReply> {
  try {
    const s = await getSession();
    let tokens = msg.tokens;
    let captureTabId: number | undefined;
    let captureId: number | undefined;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const tabUrl = typeof tab?.url === "string" ? tab.url : undefined;
    if (!tokens || tokens.length === 0) {
      // Toolbar-action fallback: capture the active tab's selection.
      if (!tab?.id) return { ok: false, replyType: "leia:reader:start", error: "no active tab" };
      captureTabId = tab.id;
      const capture = await captureTabScope(captureTabId);
      if (!capture.reply?.ok) {
        return {
          ok: false,
          replyType: "leia:reader:start",
          error: capture.reply?.error ?? capture.error ?? "no selection",
        };
      }
      tokens = (capture.reply.data as { tokens: TokenText[] }).tokens;
      captureId = (capture.reply.data as { captureId?: number }).captureId;
    }
    // T17 — starting elsewhere must not silently drop the current
    // position: park the running session's record under its URL first.
    // (The global session still switches; the position survives per-URL.)
    const prior = s.snapshot();
    if (prior) {
      const priorUrl = prior.url ?? tabUrl;
      if (priorUrl) await resume.save(priorUrl, prior);
    }
    // T16 — restore the saved position for the incoming URL when the
    // freshly captured scope still matches at that point (strict one-token
    // compare; mismatch degrades to the top and keeps the stored record).
    let resumeAt = 0;
    if (tabUrl) {
      const saved = await resume.load(tabUrl);
      if (
        saved &&
        saved.tokenPos < tokens.length &&
        saved.tokens[saved.tokenPos]?.text === tokens[saved.tokenPos]?.text
      ) {
        resumeAt = saved.tokenPos;
      }
    }
    const overrides = {
      voiceName: msg.voiceName,
      rate: msg.rate,
    };
    const status = await s.start(tokens, { url: tabUrl, resumeAt, ...overrides });
    if (captureTabId !== undefined && captureId !== undefined) {
      const locale = (await s.voiceLang()) ?? navigator.language ?? "en";
      void browser.tabs
        .sendMessage(captureTabId, {
          type: "leia:selection:bind",
          sessionId: status.sessionId,
          captureId,
          locale,
        })
        .catch(() => {});
    }
    // The bar-captured path binds its own highlighter from this reply. No
    // voiceLang() wait here: it re-burned the voices poll after the session's
    // chunk-cap read, so the reply landed seconds after the highlights had
    // already fired and the bar bound its highlighter too late (pre-bind
    // highlights are no-ops). null is tolerated — the bar binds without it
    // and word timing degrades to chunk-level.
    return { ok: true, replyType: "leia:reader:start", data: { ...status, locale: null } };
  } catch (err) {
    return { ok: false, replyType: "leia:reader:start", error: String(err) };
  }
}

/**
 * Reader session control (T2/T16/T17): start/pause/stop/resume/seek and the
 * per-URL resume records. Position-parking lives here so every entry point
 * (popup, floating bar, shortcut) gets identical semantics.
 */
async function handleReaderSession(msg: RouterMessage): Promise<RouterReply | undefined> {
  if (msg.type === "leia:reader:start") {
    return handleReaderStart(msg as { tokens?: TokenText[]; voiceName?: string | null; rate?: number });
  }

  // T16 — pause/stop park the reading position per-URL. The resume record
  // survives stop; only the live session clears.
  if (msg.type === "leia:reader:pause" || msg.type === "leia:reader:stop") {
    try {
      const s = await getSession();
      let prior = null;
      let status;
      if (msg.type === "leia:reader:stop") {
        prior = s.snapshot(); // capture BEFORE stop clears the live session
        status = await s.stop();
      } else {
        status = await s.pause();
        prior = s.snapshot();
      }
      if (prior) {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const priorUrl = prior.url ?? (typeof tab?.url === "string" ? tab.url : undefined);
        if (priorUrl) await resume.save(priorUrl, prior);
      }
      return { ok: true, replyType: msg.type, data: status };
    } catch (err) {
      return { ok: false, replyType: msg.type, error: String(err) };
    }
  }

  if (msg.type === "leia:reader:resume" || msg.type === "leia:reader:seek") {
    try {
      const s = await getSession();
      const status = await (msg.type === "leia:reader:resume"
        ? s.resume()
        : s.seek((msg as { token?: number }).token as number));
      return { ok: true, replyType: msg.type, data: status };
    } catch (err) {
      return { ok: false, replyType: msg.type, error: String(err) };
    }
  }

  if (msg.type === "leia:reader:resume-clear") {
    const s = await getSession();
    const url = (msg as { url?: string }).url ?? s.snapshot()?.url;
    if (url) await resume.clear(url);
    return { ok: true, replyType: "leia:reader:resume-clear" };
  }

  if (msg.type === "leia:reader:resume-info") {
    const url = (msg as { url?: string }).url;
    if (!url) return { ok: true, replyType: "leia:reader:resume-info", data: null };
    const rec = await resume.load(url);
    return {
      ok: true,
      replyType: "leia:reader:resume-info",
      data: rec ? { url: rec.url, tokenPos: rec.tokenPos, tokenCount: rec.tokens.length } : null,
    };
  }

  return undefined;
}

/** Sample utterance (T14 preview button) through the SAME engine the session uses. */
async function handlePreview(msg: RouterMessage): Promise<RouterReply> {
  const { voiceName, family } = msg as { voiceName?: string | null; family?: string };
  try {
    if (family) engine.selectFamily?.(family);
    for await (const ev of engine.speak(PREVIEW_SAMPLE, PREVIEW_SPEAK_ID, {
      voiceName: voiceName ?? null,
      rate: 1,
    })) {
      if (ev.type === "error") {
        // Keyless family and similar: engines may report failure as an
        // error event instead of throwing — surface it as a failed preview.
        return { ok: false, replyType: "leia:reader:preview", error: ev.message || "engine error" };
      }
    }
    return { ok: true, replyType: "leia:reader:preview" };
  } catch (err) {
    return { ok: false, replyType: "leia:reader:preview", error: String(err) };
  }
}

/** Status/voices/preview/pref reads and writes (T14 popup surface). */
async function handleReaderPrefs(msg: RouterMessage): Promise<RouterReply | undefined> {
  if (msg.type === "leia:reader:preview") {
    // Preemption contract: if a session is playing, its current chunk yields
    // `cancelled` and the drive loop re-speaks it — no deadlock. Session
    // state is never touched.
    return handlePreview(msg);
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
  return undefined;
}

/**
 * kitten-local manual verification probe (ticket 06). Firefox's event page
 * has a DOM → run it in place; Chrome's SW has neither DOM nor Worker-with-
 * Audio → forward to the probe offscreen document. The 10-minute ceiling
 * covers a slow first-use model download.
 */
async function handleKittenProbeMessage(msg: { text?: string; voice?: string | null }): Promise<RouterReply> {
  try {
    if (!isChrome()) {
      return { ok: true, replyType: "leia:probe-kitten", data: await handleKittenProbe(msg.text, msg.voice ?? null) };
    }
    await ensureOffscreenDocument();
    const data = await Promise.race([
      browser.runtime.sendMessage(msg),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("kitten probe timed out after 600s")), 600_000),
      ),
    ]);
    return { ok: true, replyType: "leia:probe-kitten", data };
  } catch (err) {
    return { ok: false, replyType: "leia:probe-kitten", error: String(err) };
  }
}

/** T2 spike probe entry points (no product behavior; see docs/spike-*.md). */
async function handleProbeDispatch(msg: RouterMessage): Promise<RouterReply | undefined> {
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
  if (msg.type === "leia:probe-kitten") {
    return handleKittenProbeMessage(msg as { text?: string; voice?: string | null });
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
  return undefined;
}

/** Active-tab page-info relay (content script does the extraction). */
async function handlePageInfo(): Promise<RouterReply> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, replyType: "leia:page-info", error: "no active tab" };
    const info = await browser.tabs.sendMessage(tab.id, { type: "leia:page-info" });
    return { ok: true, replyType: "leia:page-info", data: info };
  } catch (err) {
    return { ok: false, replyType: "leia:page-info", error: String(err) };
  }
}

/** Settings/family disclosure + audio-owner plumbing (ADR-0002, T14). */
async function handleAudioDispatch(msg: RouterMessage): Promise<RouterReply | undefined> {
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
  // Firefox: the hidden background page idles into timer/media-event
  // throttling mid-read (chunk-end events then arrive minutes late, stalling
  // the session; per-word pushes lag the voice). While a read plays, every
  // content page polls the media clock at 250ms — the message traffic keeps
  // the page active AND each synchronous currentTime read re-anchors the
  // visible tab's word march.
  if (msg.type === "leia:audio:clock") {
    return { ok: true, replyType: "leia:audio:clock", data: { clock: audioClockMs() } };
  }
  return undefined;
}

browser.runtime.onMessage.addListener(async (msg: unknown): Promise<RouterReply | undefined> => {
  if (!isRouterMessage(msg)) return;
  if (msg.type === "leia:page-info") return handlePageInfo();

  const readerReply = (await handleReaderSession(msg)) ?? (await handleReaderPrefs(msg));
  if (readerReply !== undefined) return readerReply;

  const audioReply = await handleAudioDispatch(msg);
  if (audioReply !== undefined) return audioReply;

  const probeReply = await handleProbeDispatch(msg);
  if (probeReply !== undefined) return probeReply;

  return routeMessage(msg) ?? undefined;
});

// --- Keyboard shortcut (T18): toggle reading. Configurable in
// chrome://extensions/shortcuts / about:addons → Manage Shortcuts. ---
browser.commands.onCommand.addListener((command: string) => {
  if (command !== "toggle-read") return;
  void (async () => {
    const s = await getSession();
    const { state } = s.status();
    if (state === "playing") {
      await s.pause();
      return;
    }
    if (state === "paused") {
      await s.resume();
      return;
    }
    // Stopped: same capture fallback as the toolbar action — missing
    // selection stays a silent no-op.
    await handleReaderStart({ type: "leia:reader:start" } as never);
  })().catch(() => {});
});