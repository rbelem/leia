// SPDX-License-Identifier: MPL-2.0
/**
 * Firefox BrowserAdapter — attaches via geckodriver (WebDriver classic).
 *
 * Firefox cannot be spawned by this adapter directly (the flatpak build fails
 * with a user-namespace EPERM; the repo documents manual launch). Instead the
 * adapter drives a geckodriver process that launches/holds Firefox and exposes
 * the WebDriver-classic HTTP API (which is the proven mechanism the
 * firefox-devtools-MCP uses under the hood).
 *
 * WHY geckodriver/WebDriver-classic, NOT raw BiDi (chosen after live testing):
 *   - A Firefox instance permits only ONE active WebDriver session. A raw BiDi
 *     client that calls `session.new` on an instance that already has a session
 *     is rejected ("Maximum number of active sessions"), and a transient CLI
 *     process strands the session it created. geckodriver correctly creates a
 *     session and `DELETE /session` frees it, so each CLI run owns + releases
 *     the session cleanly.
 *   - geckodriver's WebDriver-classic path is PROVEN to navigate a
 *     `moz-extension://` URL and to execute `browser.runtime.sendMessage` in the
 *     extension page (verified live: session → Moz:InstallAddon → navigate the
 *     harness → execute ping → reply).
 *
 * geckodriver is required on PATH (or via GECKODRIVER env / opts.geckodriverPath).
 * A known-good binary is at /tmp/geckodriver (0.37.1) in this dev env; the
 * firefox-devtools-MCP also bundles one. The Firefox binary is supplied via
 * `moz:firefoxOptions.binary` — the CLI must know which build to use. This env
 * uses the Nix playwright-firefox build:
 *   /nix/store/nvqkhvdw9xqk948rq5rx8nwb5rwmkzry-playwright-firefox/firefox/firefox
 * (falls back to $FIREFOX_BIN or `which firefox`).
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserAdapter } from "./adapter.js";
import { loadState, saveState, clearState } from "./state.js";

const REPO = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Firefox MV3 needs CSP connect-src for the extension page's loopback WS.
const CSP_ALLOWED_PORTS = new Set([9333]);

/** Known-good Firefox binary for this dev env; env/path fallbacks follow. */
function detectFirefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const nix = "/nix/store/nvqkhvdw9xqk948rq5rx8nwb5rwmkzry-playwright-firefox/firefox/firefox";
  if (existsSync(nix)) return nix;
  const which = spawnSync("which", ["firefox"]).stdout?.toString().trim();
  return which || "firefox";
}
function detectGeckodriver() {
  if (process.env.GECKODRIVER) return process.env.GECKODRIVER;
  const which = spawnSync("which", ["geckodriver"]).stdout?.toString().trim();
  if (which) return which;
  return "/tmp/geckodriver"; // known-good in this dev env
}

/**
 * Locate a libpulse.so.0 for Firefox's cubeb audio backend.
 *
 * The playwright-firefox build does not bundle libpulse: its audio backend
 * dlopen("libpulse.so.0") fails at runtime, so EVERY media element plays
 * silently (play() resolves, zero audio — YouTube/reader alike). The flatpak
 * Firefox works because its runtime bundles libpulse. On Nix hosts a copy
 * lives in the store; injecting it via LD_LIBRARY_PATH for the geckodriver →
 * firefox process tree restores audio. Override with LEIA_LIBPULSE_DIR.
 */
function detectLibpulseDir() {
  if (process.env.LEIA_LIBPULSE_DIR) return process.env.LEIA_LIBPULSE_DIR;
  try {
    const entries = readdirSync("/nix/store");
    const dir = entries.find((d) => d.includes("libpulseaudio-") && !d.endsWith(".drv") && !d.includes(".tar"));
    if (dir) {
      const lib = join("/nix/store", dir, "lib");
      if (existsSync(join(lib, "libpulse.so.0"))) return lib;
    }
  } catch {}
  return null;
}

/** Minimal WebDriver-classic HTTP client for geckodriver (W3C JSON Wire). */
class WebDriverClient {
  constructor(base) {
    this.base = base;
    this.sessionId = null;
  }
  async req(method, path, body) {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
    return j.value;
  }
  async newSession(binary, headless) {
    const args = headless ? ["-headless"] : [];
    const v = await this.req("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary,
            args,
            prefs: {
              // WebSockets from extension pages to the loopback bridge hang in
              // CONNECTING for 30-40s when Firefox resolves them through proxy
              // auto-detection (fetch() on the same port is instant, WS is not
              // — WS proxy resolution ignores the localhost bypass). Force
              // direct connections: there is no proxy in the leia-ctl model.
              "network.proxy.type": 0,
              "network.proxy.allow_hijacking_localhost": true,
              // WS is served by Firefox's SOCKET PROCESS; on this Nix host that
              // process can't connect (user-namespace/sandbox EPERM — same
              // class of issue flatpak hits), so every WebSocket hangs in
              // CONNECTING forever while HTTP falls back to the parent and
              // works. Run sockets in the parent process.
              "network.process.enabled": false,
              // The reader plays audio from the background EVENT PAGE, which
              // has no user gesture — Firefox's autoplay policy blocks
              // audio.play() there and the engine treats the rejection as a
              // silent finish (no error, no sound). Automation launches must
              // allow autoplay.
              "media.autoplay.default": 0,
              "media.autoplay.block-webaudio": false,
            },
          },
        },
      },
    });
    this.sessionId = v.sessionId;
    this.sessionProfile = v.capabilities?.["moz:profile"] || "";
    return v;
  }
  installAddon(path, temporary = true) {
    return this.req("POST", `/session/${this.sessionId}/moz/addon/install`, { path, temporary });
  }
  navigate(url) {
    return this.req("POST", `/session/${this.sessionId}/url`, { url });
  }
  execute(script, args = []) {
    return this.req("POST", `/session/${this.sessionId}/execute/sync`, { script, args });
  }
  async deleteSession() {
    if (!this.sessionId) return;
    try { await this.req("DELETE", `/session/${this.sessionId}`); } catch {}
    this.sessionId = null;
  }
}

function discoverExtensionUuid(profileDir) {
  try {
    const dirs = readdirSync(join(profileDir, "storage", "default"));
    const e = dirs.find((d) => d.startsWith("moz-extension+++") && d.includes("^userContextId"));
    return e ? e.replace("moz-extension+++", "").split("^")[0] : "";
  } catch {
    return "";
  }
}

/** Find the PID listening on a TCP port via `ss` (Linux). Returns null if none. */
function pidOnPort(port) {
  try {
    const out = spawnSync("ss", ["-ltnp"]).stdout?.toString() || "";
    const line = out.split("\n").find((l) => l.includes(`:${port}`));
    const m = line?.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export class FirefoxAdapter extends BrowserAdapter {
  constructor(opts = {}) {
    super(opts);
    this.geckoPort = opts.geckoPort ?? 4444;
    this.geckoPath = opts.geckodriverPath || detectGeckodriver();
    this.firefoxBin = opts.firefoxBin || detectFirefoxBinary();
    this.headless = opts.headless ?? true;
    this.gecko = null; // spawned geckodriver child (if we started it)
    this._spawnedGecko = false; // whether WE spawned it (vs reused an existing one)
    this._geckoPid = null; // geckodriver PID on the gecko port (owned or reused)
    this.wd = null; // WebDriverClient
    this.extensionUuid = "";
    this._attached = false;
  }

  async _ensureGeckodriver() {
    // If geckodriver is already serving and ready, reuse it (often the case
    // when the firefox-devtools-MCP's copy is up). Mark that we did NOT spawn it.
    try {
      const r = await fetch(`http://127.0.0.1:${this.geckoPort}/status`);
      const j = await r.json();
      if (j.value?.ready) {
        this._spawnedGecko = false;
        this._geckoPid = this.gecko?.pid || pidOnPort(this.geckoPort);
        return;
      }
    } catch {}
    // A geckodriver may be running but stale (session torn down, not ready).
    // We cannot safely kill one we didn't spawn here, so just spawn our own on
    // a fresh process; the reusable-path handling below is enough for the
    // normal reused-ready case.
    // Otherwise spawn our own.
    try {
      // Inject libpulse (if found) so the launched Firefox can actually output
      // audio — geckodriver passes its environment down to the browser.
      const env = { ...process.env };
      const pulseDir = detectLibpulseDir();
      if (pulseDir) {
        env.LD_LIBRARY_PATH = [pulseDir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
        console.log(`[firefox] LD_LIBRARY_PATH += ${pulseDir} (cubeb audio backend)`);
      } else {
        console.warn("[firefox] no libpulse found — Firefox may play audio silently");
      }
      this.gecko = spawn(this.geckoPath, ["--port", String(this.geckoPort), "--log", "warn"], { stdio: "ignore", env });
      this.gecko.unref();
      this._spawnedGecko = true;
      this._geckoPid = this.gecko.pid;
    } catch (e) {
      throw new Error(`could not start geckodriver (${this.geckoPath}): ${e.message}`);
    }
    // Wait for readiness.
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.geckoPort}/status`);
        const j = await r.json();
        if (j.value?.ready) return;
      } catch {}
      await sleep(250);
    }
    throw new Error(`geckodriver did not become ready on 127.0.0.1:${this.geckoPort}`);
  }

  async start() {
    if (this.opts.port && !CSP_ALLOWED_PORTS.has(this.opts.port)) {
      console.warn(`[firefox] port ${this.opts.port} is not in the extension CSP connect-src; use 9333.`);
    }
    await this._startBridge();
    await this._ensureGeckodriver();
    this.wd = new WebDriverClient(`http://127.0.0.1:${this.geckoPort}`);
    const profile = await this._createSessionAndInstall();
    this.extensionUuid = await this._discoverUuid(profile);
    await this._navigateHarness();
    await this._connectHarness();
    saveState({
      browser: "firefox",
      geckoPort: this.geckoPort,
      profileDir: profile,
      sessionId: this.wd.sessionId,
      extensionUuid: this.extensionUuid,
      pid: this.gecko?.pid || null,
      geckoPid: this._geckoPid,
    });
  }

  async _createSessionAndInstall() {
    try {
      await this.wd.newSession(this.firefoxBin, this.headless);
    } catch (e) {
      throw new Error(`could not create Firefox WebDriver session: ${e.message}`);
    }
    const dist = join(REPO, "dist", "firefox");
    try {
      await this.wd.installAddon(dist, true);
    } catch (e) {
      console.warn(`[firefox] addon install: ${e.message}`);
    }
    this._attached = true;
    return this.wd.sessionProfile || "";
  }

  async _discoverUuid(profile) {
    let uuid = discoverExtensionUuid(profile);
    if (!uuid) {
      // storage dir may briefly lag the addon install
      await sleep(2000);
      uuid = discoverExtensionUuid(profile);
    }
    return uuid || "";
  }

  async _navigateHarness() {
    const tokenQ = this.opts.token ? `&token=${encodeURIComponent(this.opts.token)}` : "";
    const harnessUrl = `moz-extension://${this.extensionUuid}/harness/harness.html?ws=${encodeURIComponent(this.wsUrl)}${tokenQ}`;
    await this.wd.navigate(harnessUrl);
  }

  async _connectHarness() {
    let gotHello = await this._waitForHello(8000);
    if (!gotHello) {
      await this._retriggerConnect();
      gotHello = await this._waitForHello(3000);
    }
  }

  /** One-shot command path: start the bridge + wait for the harness to connect. */
  async ensureReady(timeoutMs = 8000) {
    if (!this.ws) await this._startBridge();
    const st = loadState();
    if (st?.browser === "firefox") {
      this.geckoPort = st.geckoPort;
      this.extensionUuid = st.extensionUuid || this.extensionUuid;
    }
    const gotHello = await this._waitForHello(timeoutMs);
    if (!gotHello) await this._waitForHello(2000);
    if (!this.ws?.helloSeen && !this.connected) {
      throw new Error("harness not connected — run `leia up` first");
    }
  }

  _waitForHello(timeoutMs) {
    if (this.ws?.helloSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const off = this.ws?.onHello(() => { off?.(); resolve(true); });
      setTimeout(() => { off?.(); resolve(false); }, timeoutMs);
    });
  }

  async _retriggerConnect() {
    const expr = `(function(){ if (globalThis.__leiaRestart) globalThis.__leiaRestart(); return 'ok'; })()`;
    try { await this.wd?.execute(expr); } catch { /* WS-only path is primary */ }
  }

  async eval(js) {
    if (!this.wd?.sessionId) throw new Error("no Firefox WebDriver session");
    const res = await this.wd.execute(`return (${js});`);
    return res;
  }

  async openTab(url) {
    // WebDriver classic navigates the current window; for a new tab we'd need
    // window handles + a new window. Keep it simple: navigate the current one.
    if (this.wd?.sessionId) await this.wd.navigate(url);
  }

  async stop() {
    // Destructive teardown: free the geckodriver session (releasing the
    // marionette session — the key anti-stranding behavior) and stop any
    // geckodriver we spawned. This is the explicit `leia down`.
    if (this.wd) {
      await this.wd.deleteSession();
      this.wd = null;
    }
    const st = loadState();
    const geckoPid = this._geckoPid || this.gecko?.pid || st?.geckoPid || null;
    if (geckoPid) {
      try { process.kill(geckoPid, "SIGTERM"); } catch {}
    }
    if (this.gecko) {
      try { this.gecko.kill("SIGTERM"); } catch {}
      this.gecko = null;
    }
    this._spawnedGecko = false;
    this._geckoPid = null;
    this._attached = false;
    clearState();
  }

  close() {
    // NON-destructive: only release the WS bridge. The browser + geckodriver
    // session must persist so a later `status`/`start` reconnects the harness.
    // Use `stop()` (`leia down`) for explicit teardown.
    super.close();
  }
}
