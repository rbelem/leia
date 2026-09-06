// SPDX-License-Identifier: MPL-2.0
/**
 * Command registry — one function per `leia <cmd>` subcommand.
 *
 * Each handler receives a `ctx`:
 *   { adapter, json, help, rest, flags, opts }
 * and returns a value that `index.js` prints (JSON if `--json`, else a
 * human-readable summary). Commands that send to the harness return the WS
 * reply's `data` (or the whole reply), so `--json` prints exactly that.
 *
 * Note: several commands (`options:*`) currently map to harness WS commands
 * that the extension/harness lanes have NOT yet added to `commandToMessage`
 * (the harness returns `{ok:false, error:'unknown command …'}`). They are
 * wired here so the CLI is ready once those mappings land. See the TODO.
 */
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** Resolve a `--flag value` out of the raw token list into a flags object. */
function parseFlags(tokens) {
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--json") flags.json = true;
    else if (t === "--help") flags.help = true;
    else if (t.startsWith("--")) {
      const key = t.slice(2);
      const val = tokens[i + 1] && !tokens[i + 1].startsWith("--") ? tokens[++i] : true;
      flags[key] = val;
    }
  }
  return flags;
}

/** Split raw tokens into positional `rest` (bare words) + parsed `flags`. */
function splitArgs(tokens) {
  const rest = [];
  const flags = parseFlags(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--json" || t === "--help") continue;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      // skip the value if it was consumed as a flag value
      if (flags[key] !== true && flags[key] !== undefined && tokens[i + 1] === flags[key]) i++;
      continue;
    }
    rest.push(t);
  }
  return { rest, flags };
}

function num(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Ensure the harness is connected (start bridge + wait for hello in one-shots). */
async function ensureConnected(adapter) {
  try {
    await adapter.ensureReady();
  } catch (e) {
    // `ensureReady` may throw "not connected" during the ~1s reconnect window.
    // Instead of surfacing it immediately, give the harness a bounded grace to
    // (re)connect — the bridge is already up and the harness retries every 1s.
    if (!String(e.message || e).includes("not connected")) throw e;
  }
  const ws = adapter.ws;
  if (ws?.waitConnected) {
    try {
      await ws.waitConnected(9000);
    } catch {
      // fall through to the explicit check below for a clear message
    }
  }
  if (!adapter.connected && !(ws?.helloSeen)) {
    throw new Error("harness not connected — run `leia up` first");
  }
}

function fixtureUrl() {
  return `file://${join(ROOT, "cli", "fixtures", "article.html")}`;
}

// ---------------------------------------------------------------------------
// Commands — one named handler per CLI subcommand
// ---------------------------------------------------------------------------

// ----- bring-up ---------------------------------------------------------
async function up(ctx) {
  await ctx.adapter.start();
  // Release the WS bridge so the CLI process can exit — `up` is not a
  // daemon. The browser + session persist; one-shot commands re-bind the
  // bridge and the harness wake reconnects it (close() is non-destructive).
  ctx.adapter.close?.();
  return { ok: true, message: `adapter up (${ctx.adapter.constructor.name}); bridge ${ctx.adapter.wsUrl}` };
}

async function down(ctx) {
  await ctx.adapter.stop();
  ctx.adapter.close();
  return { ok: true, message: "adapter down" };
}

// ----- subject tab ------------------------------------------------------
async function open(ctx, { rest }) {
  const url = rest[0];
  if (!url) return { ok: false, error: "open requires a URL" };
  await ensureConnected(ctx.adapter);
  await ctx.adapter.openTab(url);
  return { ok: true, url };
}

async function openFixture(ctx) {
  await ensureConnected(ctx.adapter);
  const url = fixtureUrl();
  await ctx.adapter.openTab(url);
  return { ok: true, url, message: "opened bundled fixture" };
}

// ----- reader transport -------------------------------------------------
async function start(ctx, { flags }) {
  await ensureConnected(ctx.adapter);
  // voice/rate ride as prefs first (the harness `start` mapping only carries
  // `text`); `--text S` is sent as explicit token text.
  if (flags.voice || flags.voiceName) {
    await ctx.adapter.sendCommand("prefs", { voiceName: flags.voice || flags.voiceName });
  }
  if (flags.rate !== undefined) {
    await ctx.adapter.sendCommand("prefs", { rate: num(flags.rate) });
  }
  const args = {};
  if (typeof flags.text === "string") args.text = flags.text;
  if (typeof flags.url === "string") args.url = flags.url;
  return ctx.adapter.sendCommand("start", args);
}

async function pause(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("pause");
}

async function resume(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("resume");
}

async function stop(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("stop");
}

async function seek(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const token = rest[0];
  if (token === undefined) return { ok: false, error: "seek requires a token index" };
  return ctx.adapter.sendCommand("seek", { token });
}

// ----- voices / prefs ---------------------------------------------------
async function voices(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("voices");
}

async function voice(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const name = rest[0];
  if (!name) return { ok: false, error: "voice requires a name" };
  return ctx.adapter.sendCommand("prefs", { voiceName: name });
}

async function rate(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const r = num(rest[0]);
  if (r === undefined) return { ok: false, error: "rate requires a number" };
  return ctx.adapter.sendCommand("prefs", { rate: r });
}

async function preview(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const v = rest[0];
  if (!v) return { ok: false, error: "preview requires a voice" };
  return ctx.adapter.sendCommand("preview", { voiceName: v });
}

// ----- status / theme / scope / page ------------------------------------
async function status(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("status");
}

async function state(ctx) {
  // `state` mirrors the live session state (alias of `status`).
  return status(ctx);
}

async function theme(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const name = rest[0];
  if (!name) return { ok: false, error: "theme requires a name" };
  return ctx.adapter.sendCommand("theme", { theme: name });
}

async function scope(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("scope");
}

async function pageInfo(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("page-info");
}

// ----- options config (harness mapping pending — see note) --------------
async function optionsServers(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("options:servers");
}

async function optionsAddServer(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const [name, url] = rest;
  if (!name || !url) return { ok: false, error: "options:add-server requires <name> <url>" };
  return ctx.adapter.sendCommand("options:add-server", { name, url });
}

async function optionsKeys(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("options:keys");
}

async function optionsSetKey(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const [provider, key] = rest;
  if (!provider || !key) return { ok: false, error: "options:set-key requires <provider> <key>" };
  return ctx.adapter.sendCommand("options:set-key", { provider, key });
}

// ----- probes -----------------------------------------------------------
async function probeVoices(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:voices");
}
async function probeSpeak(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:speak");
}
async function probeCancel(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:cancel");
}
async function probeKitten(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:kitten");
}
async function probeTts(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:tts");
}
async function probeFf(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("probe:ff");
}

// ----- engine / audio ---------------------------------------------------
async function audioFamilies(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("audio:families");
}
async function audioClock(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("audio:clock");
}

// ----- ping (harmless / diagnostic) -------------------------------------
async function ping(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.adapter.sendCommand("ping");
}

// ----- live event stream ------------------------------------------------
async function events(ctx) {
  await ensureConnected(ctx.adapter);
  return ctx.spawnEventsFollow();
}

// ----- assertion mode ---------------------------------------------------
async function wait(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const condition = rest[0];
  if (!condition) return { ok: false, error: "wait requires a condition (e.g. state==playing)" };
  return waitFor(ctx, condition, timeoutFromFlags(ctx));
}

async function expect(ctx, { rest }) {
  await ensureConnected(ctx.adapter);
  const condition = rest[0];
  if (!condition) return { ok: false, error: "expect requires a condition (e.g. state==playing)" };
  const ok = await waitFor(ctx, condition, timeoutFromFlags(ctx));
  if (!ok) process.exitCode = 1;
  return { ok, condition };
}

function timeoutFromFlags(ctx) {
  const t = num(ctx.flags.timeout) ?? 15_000;
  return ctx.flags.seconds ? t * (num(ctx.flags.seconds) ?? 1) : t;
}

// ---------------------------------------------------------------------------
// Registry: CLI-facing subcommand name -> handler
// ---------------------------------------------------------------------------
const commands = {
  up,
  down,
  open,
  "open-fixture": openFixture,
  start,
  pause,
  resume,
  stop,
  seek,
  voices,
  voice,
  rate,
  preview,
  status,
  state,
  theme,
  scope,
  "page-info": pageInfo,
  "options:servers": optionsServers,
  "options:add-server": optionsAddServer,
  "options:keys": optionsKeys,
  "options:set-key": optionsSetKey,
  "probe:voices": probeVoices,
  "probe:speak": probeSpeak,
  "probe:cancel": probeCancel,
  "probe:kitten": probeKitten,
  "probe:tts": probeTts,
  "probe:ff": probeFf,
  "audio:families": audioFamilies,
  "audio:clock": audioClock,
  ping,
  events,
  wait,
  expect,
};

// ---------------------------------------------------------------------------
// `wait` / `expect` condition engine
// ---------------------------------------------------------------------------

/**
 * Poll `status` and the event stream until `condition` holds or `timeoutMs`.
 * Grammar:
 *   `state==playing` | `state==paused` | `state!=idle`   (compare leader state)
 *   `has:event:<name>`                                    (saw a broadcast event)
 * Returns true if it held within the timeout, false otherwise.
 */
async function waitFor(ctx, condition, timeoutMs) {
  const eventNames = new Set();
  const un = ctx.adapter.onEvent((name) => eventNames.add(name));
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      if (await testCondition(ctx, condition, eventNames)) return true;
      await sleep(300);
    }
    return testCondition(ctx, condition, eventNames);
  } finally {
    un();
  }
}

async function testCondition(ctx, condition, eventNames) {
  const h = condition.match(/^(state|status)\s*(==|!=)\s*(.+)$/);
  if (h) {
    const op = h[2];
    const val = h[3].trim();
    const reply = await ctx.adapter.sendCommand("status");
    const data = reply && reply.data ? reply.data : {};
    const state = data.state ?? data.status ?? data.mode;
    if (state === undefined || state === null) return false;
    const s = String(state);
    return op === "==" ? s === val : s !== val;
  }
  if (condition.startsWith("has:event:")) {
    return eventNames.has(condition.slice("has:event:".length));
  }
  throw new Error(`unknown condition '${condition}' (use state==<v> / state!=<v> / has:event:<name>)`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function getCommand(name) {
  return commands[name];
}

export function listCommandNames() {
  return Object.keys(commands);
}

export { splitArgs, fixtureUrl };
