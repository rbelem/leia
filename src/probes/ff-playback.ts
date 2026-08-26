/**
 * T2 spike: Firefox event-page persistence probe.
 *
 * Starts a ≥5-minute speechSynthesis utterance from the background page and
 * watches whether the event page survives it: heartbeat written to
 * `storage.session` every 5s, lifecycle logs, and a watchdog note on the next
 * wake if the page was suspended mid-playback. Gated by the
 * `leia:ff-playback` message. See docs/spike-firefox-eventpage.md.
 *
 * IMPORTANT: the handler returns immediately. A long-lived promise reply
 * would keep the event page awake and invalidate the spike — results are
 * streamed via console + storage.session, never held open as a reply.
 */
import browser from "webextension-polyfill";

const STORAGE_KEY = "leia:ff-playback";
const KEEPALIVE_ALARM = "leia:ff-playback-kick";
// ~1000 words ≈ 5-7 min at normal TTS speed (the ≥5 min pass gate).
const LONG_TEXT = "This is a long read. ".repeat(200);

interface PlaybackState {
  active: boolean;
  startAt: number;
  lastHb: number;
  boundaries: number;
  lastBoundaryAt: number;
  endedAt?: number;
  endReason?: string;
}

export interface ProbeReply {
  ok: boolean;
  replyType: string;
  data?: unknown;
  error?: string;
}

let state: PlaybackState | null = null;
let hbTimer: ReturnType<typeof setInterval> | undefined;
let startAt = 0;
let boundaryCount = 0;

function log(line: string): void {
  console.log(`[leia ff-playback] ${line}`);
}

function persist(): void {
  if (state) void browser.storage.session.set({ [STORAGE_KEY]: state });
}

function elapsedSec(): string {
  return ((Date.now() - startAt) / 1000).toFixed(1);
}

/**
 * Watchdog note, run at every event-page load: if a probe run is still
 * recorded as active with a stale heartbeat, the page was suspended
 * mid-playback (storage.session survives suspension but not browser restarts).
 */
void browser.storage.session.get(STORAGE_KEY).then((stored) => {
  const prev = stored[STORAGE_KEY] as PlaybackState | undefined;
  if (!prev?.active) return;
  const gapSec = ((Date.now() - prev.lastHb) / 1000).toFixed(0);
  log(`wake: previous run still active, heartbeat ${gapSec}s old, boundaries=${prev.boundaries} → event page WAS suspended mid-playback`);
  if (typeof speechSynthesis !== "undefined") {
    log(`wake: fresh context, speechSynthesis.speaking=${speechSynthesis.speaking} (expected false)`);
  }
});

function finish(reason: string): void {
  if (!state) return;
  state.active = false;
  state.endedAt = Date.now();
  state.endReason = reason;
  if (hbTimer !== undefined) {
    clearInterval(hbTimer);
    hbTimer = undefined;
  }
  log(`end: ${reason} @ ${elapsedSec()}s, boundaries=${boundaryCount}`);
  persist();
}

export function handleFfPlaybackProbe(): ProbeReply {
  if (typeof speechSynthesis === "undefined") {
    return {
      ok: false,
      replyType: "leia:ff-playback",
      error: "speechSynthesis unavailable — Firefox event page only (Chrome SW has no DOM)",
    };
  }
  if (state?.active) {
    return { ok: true, replyType: "leia:ff-playback", data: { stage: "already-running" } };
  }

  activeStart();
  log(`start: ${LONG_TEXT.length} chars (~5-7 min); heartbeat every 5s → storage.session.${STORAGE_KEY}`);
  const u = new SpeechSynthesisUtterance(LONG_TEXT);
  u.onstart = () => {
    log(`onstart @ ${elapsedSec()}s`);
    persist();
  };
  u.onboundary = () => {
    boundaryCount += 1;
    if (state) {
      state.boundaries = boundaryCount;
      state.lastBoundaryAt = Date.now();
    }
    // First few boundaries individually, then rely on heartbeat counts.
    if (boundaryCount <= 5) {
      log(`boundary #${boundaryCount} @ ${elapsedSec()}s`);
    }
  };
  u.onend = () => finish("end");
  u.onerror = (e) => finish(`error:${e.error}`);

  hbTimer = setInterval(() => {
    if (state) state.lastHb = Date.now();
    log(`hb @ ${elapsedSec()}s, boundaries=${boundaryCount}`);
    persist();
  }, 5000);

  speechSynthesis.speak(u);
  return { ok: true, replyType: "leia:ff-playback", data: { stage: "started" } };
}

function activeStart(): void {
  startAt = Date.now();
  boundaryCount = 0;
  state = { active: true, startAt, lastHb: startAt, boundaries: 0, lastBoundaryAt: startAt };
  persist();
}

/** Optional keepalive: a 30s alarm wakes the event page so it never idles out. */
export function handleFfPlaybackKeepalive(): ProbeReply {
  void browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }).catch((err) => {
    log(`keepalive arm failed: ${String(err)}`);
  });
  return { ok: true, replyType: "leia:ff-playback-keepalive", data: { armed: true, periodMinutes: 0.5 } };
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  log(`alarm kick — page woke at ${Date.now()}, boundaries=${boundaryCount}`);
});