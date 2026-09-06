// SPDX-License-Identifier: MPL-2.0
/**
 * In-extension harness page (dev tooling, NOT shipped in production builds).
 *
 * The harness is one side of the `ws://127.0.0.1:<port>` protocol (the CLI
 * built in parallel is the server). It:
 *   - opens a WebSocket to the CLI (loopback only; `?ws=` overrides the port), and
 *   - forwards CLI `{type:'command'}` messages to `runtime.sendMessage`, and
 *   - observes background broadcasts via `runtime.onMessage` and pushes them
 *     back as live `{type:'event'}` WS messages.
 *
 * It deliberately uses `globalThis.browser ?? globalThis.chrome` rather than
 * importing webextension-polyfill, staying self-contained so it can be dropped
 * into an extension-context page and bundled on its own.
 */

/**
 * Minimal, self-contained view of the extension runtime API the harness needs.
 * The real `browser`/`chrome` object has far more surface; we only declare the
 * slice we touch. `api` may be undefined at runtime (guard in main()).
 */
interface HarnessApi {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(listener: (message: unknown, sender?: unknown) => unknown): void;
    };
  };
  storage: {
    local: {
      get(key: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

const api: HarnessApi | undefined =
  (globalThis as { browser?: HarnessApi }).browser ?? (globalThis as { chrome?: HarnessApi }).chrome;

const qs = new URLSearchParams(location.search);
const paramPort = qs.get("ws");
const WS_URL = paramPort
  ? paramPort.startsWith("ws://") || paramPort.startsWith("http://")
    ? paramPort
    : `ws://127.0.0.1:${paramPort}`
  : "ws://127.0.0.1:9333";
// Optional handshake token: the CLI sets `?token=` when it wants to refuse
// unrelated local pages from driving the harness. Presented in `hello`.
const TOKEN = qs.get("token") ?? null;

const RECONNECT_MS = 1000;

// The current socket, held so the runtime observer (which is installed once)
// always pushes events onto whichever connection is live.
let socket: WebSocket | null = null;

function log(cls: string, txt: string): void {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = txt;
  document.getElementById("log")?.appendChild(d);
}

function setConn(txt: string): void {
  const el = document.getElementById("conn");
  if (el) el.textContent = txt;
}

function send(o: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(o));
}

/** Map a CLI command name + args to the extension message to send. */
function commandToMessage(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "ping":
      return { type: "ping" };
    case "voices":
      return { type: "leia:reader:voices" };
    case "status":
      return { type: "leia:reader:status" };
    case "page-info":
      return { type: "leia:page-info" };
    case "theme":
      return { type: "leia:theme:set", theme: args.theme ?? "amber" };
    case "start":
      // `args.text` carries explicit token text; otherwise the background
      // captures the active tab's selection (its `handleReaderStart` fallback).
      return {
        type: "leia:reader:start",
        ...(typeof args.text === "string" ? { tokens: [{ text: args.text }] } : {}),
      };
    case "pause":
      return { type: "leia:reader:pause" };
    case "resume":
      return { type: "leia:reader:resume" };
    case "stop":
      return { type: "leia:reader:stop" };
    case "seek":
      return { type: "leia:reader:seek", token: args.token };
    case "prefs":
      return {
        type: "leia:reader:prefs",
        voiceName: args.voiceName,
        rate: args.rate,
        engine: args.engine,
      };
    case "preview":
      return { type: "leia:reader:preview", voiceName: args.voiceName };
    case "scope":
      return { type: "leia:selection:capture" };
    case "audio:families":
      return { type: "leia:audio:families" };
    case "audio:clock":
      return { type: "leia:audio:clock" };
    default:
      // `probe:<x>` resolves to `leia:probe-<x>` / `leia:tts-probe` / etc.
      if (name.startsWith("probe:")) {
        const probe = name.slice("probe:".length);
        if (probe === "tts") return { type: "leia:tts-probe" };
        if (probe === "ff" || probe === "ff-playback") return { type: "leia:ff-playback" };
        return { type: `leia:probe-${probe}` };
      }
      return null;
  }
}

interface CommandMessage {
  type: "command";
  id: number;
  name: string;
  args?: Record<string, unknown>;
}

function isCommand(m: unknown): m is CommandMessage {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { type?: unknown }).type === "command" &&
    typeof (m as { name?: unknown }).name === "string"
  );
}

const LOCAL_PROFILES_KEY = "leia:settings:localProfiles";
const PROVIDER_KEY_KEYS: Record<string, string> = {
  minimax: "leia:settings:minimaxKey",
  elevenlabs: "leia:settings:elevenlabsKey",
  openai: "leia:settings:openaiKey",
  xai: "leia:settings:xaiKey",
  mistral: "leia:settings:mistralKey",
  gemini: "leia:settings:geminiKey",
  azure: "leia:settings:azureKey",
};
const AZURE_REGION_KEY = "leia:settings:azureRegion";

/** Options config is storage.local (the sendMessage router has no options messages). */
async function handleOptions(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!api) return { ok: false, error: "no storage api" };
  const store = api.storage.local;

  switch (name) {
    case "options:servers": {
      const got = await store.get(LOCAL_PROFILES_KEY);
      return got[LOCAL_PROFILES_KEY] ?? [];
    }
    case "options:add-server": {
      const got = await store.get(LOCAL_PROFILES_KEY);
      const list = (got[LOCAL_PROFILES_KEY] as Array<{ id?: string; name?: string; baseUrl?: string }>) ?? [];
      const id = `custom-${Date.now()}`;
      const next = [...list, { id, name: String(args.name ?? "custom"), baseUrl: String(args.url ?? "") }];
      await store.set({ [LOCAL_PROFILES_KEY]: next });
      return next;
    }
    case "options:remove-server": {
      const got = await store.get(LOCAL_PROFILES_KEY);
      const list = (got[LOCAL_PROFILES_KEY] as Array<{ id?: string }>) ?? [];
      const next = list.filter((p) => p.id !== args.id);
      await store.set({ [LOCAL_PROFILES_KEY]: next });
      return next;
    }
    case "options:keys": {
      const keys = Object.values(PROVIDER_KEY_KEYS).concat(AZURE_REGION_KEY);
      const got = await store.get(keys);
      return got;
    }
    case "options:set-key": {
      const provider = String(args.provider ?? "");
      const storageKey = PROVIDER_KEY_KEYS[provider];
      if (!storageKey) return { ok: false, error: `unknown provider ${provider}` };
      const items: Record<string, unknown> = { [storageKey]: String(args.key ?? "") };
      if (provider === "azure" && typeof args.region === "string") items[AZURE_REGION_KEY] = args.region;
      await store.set(items);
      return { saved: provider };
    }
    default:
      return { ok: false, error: `unknown options command ${name}` };
  }
}

function runCommand(id: number, name: string, args: Record<string, unknown>): void {
  log("cmd", `[cmd] ${name} ${JSON.stringify(args)}`);
  const reply = (m: Record<string, unknown>): void => send({ type: "reply", id, replyType: name, ...m });

  if (!api) {
    reply({ ok: false, error: "no runtime api (browser/chrome undefined)" });
    return;
  }

  // Options config is storage.local, NOT the sendMessage router — handle it
  // directly (the harness is an extension page with storage access).
  if (name.startsWith("options:")) {
    void handleOptions(name, args)
      .then((data) => reply({ ok: true, data }))
      .catch((e: unknown) => reply({ ok: false, error: String(e) }));
    return;
  }

  const msg = commandToMessage(name, args);
  if (msg === null || msg === undefined) {
    reply({ ok: false, error: `unknown command ${name}` });
    return;
  }

  api.runtime
    .sendMessage(msg)
    .then((r: unknown) => {
      log("evt", `[reply ${name}] ${JSON.stringify(r)}`);
      if (r === undefined) {
        // Unhandled message: no one answered — report success with null payload.
        reply({ ok: true, data: null });
      } else {
        const rr = r as { ok?: boolean; data?: unknown; error?: string };
        reply({ ok: rr.ok !== false, data: rr.data ?? null, error: rr.error });
      }
    })
    .catch((e: unknown) => {
      log("err", `[err ${name}] ${String(e)}`);
      reply({ ok: false, error: String(e) });
    });
}

/**
 * Observe background broadcasts to extension pages (session state, audio
 * event, highlight, theme). Return `undefined` so we never claim a reply
 * channel that belongs to the owner (repo rule, echoed in messaging.ts).
 */
function observeRuntime(): void {
  api?.runtime.onMessage.addListener((msg: unknown, _sender?: unknown): undefined => {
    if (!msg || (msg as { type?: unknown }).type === "ping") return undefined;
    const m = msg as { type?: unknown };
    log("evt", `[event] ${String(m.type)}`);
    send({ type: "event", name: m.type, data: msg });
    return undefined;
  });
}

function connect(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setConn("ws constructor failed, retrying…");
    log("err", `[ws error] ${String(e)}`);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectFailures = 0;
    sessionStorage.removeItem("leia:reloads");
    setConn("connected");
    log("conn", "[ws open]");
    send({ type: "hello", url: location.href, token: TOKEN });
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    let m: unknown;
    try {
      m = JSON.parse(ev.data as string) as unknown;
    } catch {
      return;
    }
    if (isCommand(m)) runCommand(m.id, m.name, m.args ?? {});
  };
  ws.onclose = () => {
    setConn("closed, retrying…");
    log("err", "[ws close]");
    scheduleReconnect();
  };
  ws.onerror = () => log("err", "[ws error]");
}

/**
 * Reconnect scheduling. Firefox's reconnect-from-a-dead-socket path is
 * unreliable in long-lived extension tabs (timers stall, sockets hang in
 * CLOSING/CONNECTING), while a FRESH page load always connects instantly.
 * So: try in place a couple of times, then reload the page — the reload
 * path is deterministic. The worker heartbeat (below) drives this even when
 * page timers are throttled.
 */
let reconnectFailures = 0;
// Reload immediately on a lost bridge: a fresh page load is the one connect
// path Firefox never gets wrong here, and in-place retries just add latency
// to the reconnect cycle.
const MAX_IN_PLACE_RETRIES = 0;

function scheduleReconnect(): void {
  reconnectFailures += 1;
  setTimeout(reconnectOrReload, RECONNECT_MS);
}

/** Shared decision: try in place, or reload for a clean connection. */
function reconnectOrReload(): void {
  if (socket && socket.readyState !== WebSocket.CLOSED) return; // healthy or in-flight
  reconnectFailures += 1;
  if (reconnectFailures <= MAX_IN_PLACE_RETRIES) {
    connect();
    return;
  }
  // Cap self-reloads so a long-gone CLI doesn't leave the page churning
  // forever; sessionStorage survives reloads within the same tab.
  const RELOAD_CAP = 30;
  const reloaded = Number(sessionStorage.getItem("leia:reloads") ?? "0");
  if (reloaded >= RELOAD_CAP) {
    setConn("bridge down — reload the page to retry");
    log("conn", "[reload cap reached — idle]");
    return;
  }
  sessionStorage.setItem("leia:reloads", String(reloaded + 1));
  log("conn", "[reloading page for a clean reconnect]");
  location.reload();
}

/**
 * Occlusion-proof heartbeat: Firefox pauses/throttles page timers when the
 * window is occluded, which stalls the setTimeout reconnect loop above for
 * tens of seconds (leia-ctl then sees "harness not connected" at random).
 * Worker timers are not throttled, so a tick from reconnect-worker.js forces
 * a reconnect attempt whenever the socket is fully closed.
 */
let reconnectWorker: Worker | null = null;
try {
  reconnectWorker = new Worker("reconnect-worker.js");
  reconnectWorker.onmessage = () => {
    // Drive BOTH the in-place retry and the reload threshold from worker
    // ticks (unthrottled), since page timers can stall on occluded windows.
    if (!socket || socket.readyState === WebSocket.CLOSED) reconnectOrReload();
  };
} catch (e) {
  log("err", `[reconnect worker unavailable: ${String(e)}]`);
}

function main(): void {
  const urlEl = document.getElementById("url");
  if (urlEl) urlEl.textContent = location.href;
  setConn(`target ${WS_URL}`);
  if (!api) log("err", "[no runtime api: browser/chrome undefined]");

  // Install the observer once so every reconnect pushes broadcast events onto
  // whichever socket is live (module-level `socket`).
  observeRuntime();
  connect();
}

main();
