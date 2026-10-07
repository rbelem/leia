// SPDX-License-Identifier: MPL-2.0
/**
 * Chrome CDP BrowserAdapter. CLI-spawned browser.
 *
 * Proven in prototype/driver-chrome.mjs + driver-live.mjs. Reuses:
 *  - spawn chromium with --load-extension=dist/chrome --remote-debugging-port.
 *  - discover the extension id from the service-worker target whose URL ends
 *    with `/background/index.js` (NOT a bundled background_page).
 *  - open chrome-extension://<id>/harness/harness.html?ws=<bridge> via PUT
 *    /json/new; the page auto-connects to the CLI's WS server (point (a)).
 *  - CDP Runtime.evaluate as the eval fallback.
 *
 * Cross-invocation model: each `leia <cmd>` is its own process. `up` spawns the
 * browser and persists state (debug port, profile, extension id, pid) so a
 * later `status` / `events` / `down` can re-attach to the still-running browser
 * (the harness reconnects to the bridge port every ~1s) or tear it down.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { BrowserAdapter } from "./adapter.js";
import { loadState, saveState, clearState } from "./state.js";

const REPO = new URL("..", import.meta.url).pathname;

// Chrome's CSP connect-src (src/manifest.json) is fixed to these loopback
// origins; the harness must land on a port the CSP allows.
const CSP_ALLOWED_PORTS = new Set([9333]);

// a11y activation recipe — WHY this exists (rationale lives here; pointers:
// docs/cua-e2e.md §"activation recipe", AGENTS.md "a11y recipe"):
// cua-driver enumerates browsers over AT-SPI, and chromium is invisible to
// AT-SPI unless BOTH (a) org.a11y.Status.ScreenReaderEnabled=true on the
// session bus BEFORE the browser process starts, and (b)
// --force-renderer-accessibility is on its command line (investigation
// 2026-10-07, isolated experiments; without (b) the tree stays 2-element
// shallow). LEIA_NO_FORCE_A11Y=1 opts out (perf/privacy kill switch).
// Argument vectors for busctl (the binary name is passed by the spawnSync
// call sites — keeping it out of these arrays avoids a doubled verb).
const A11Y_FLAG_GET = ["--user", "get-property", "org.a11y.Bus",
  "/org/a11y/bus", "org.a11y.Status", "ScreenReaderEnabled"];
const A11Y_FLAG_SET = (v) => ["--user", "set-property", "org.a11y.Bus",
  "/org/a11y/bus", "org.a11y.Status", "ScreenReaderEnabled", "b", v];
// The cua daemon owns the flag while it runs: it sets ScreenReaderEnabled=true
// at its own startup and re-asserts it, so restoring `false` under it would
// break the NEXT launch's a11y visibility. Socket presence + a status answer
// is the ownership test (docs/cua-e2e.md §restore).
const CUA_DAEMON_SOCK = join(process.env.HOME ?? "", ".cache", "cua-driver", "cua-driver.sock");
const FORCE_A11Y_ARG = "--force-renderer-accessibility";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flatpak wrapper detection (issue #21): a `--chrome-bin` whose content execs
 * `flatpak run <app-id>` launches the browser inside a flatpak sandbox that
 * OUTLIVES the wrapper pid and keeps a private /tmp. Returns the app-id
 * ("org.chromium.Chromium") or null for plain binaries. Pure — exported for
 * unit tests.
 */
export function parseFlatpakWrapper(source) {
  const m = /flatpak\s+run\b/.exec(source ?? "");
  if (!m) return null;
  // The app-id is the first dotted token after `run` — skips intervening
  // flags (`--user`, `--branch=stable`, …). Flatpak ids are dotted
  // (reverse-DNS), so a dot is the discriminator against further flags.
  for (const tok of source.slice(m.index + m[0].length).split(/\s+/)) {
    if (/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(tok)) return tok;
  }
  return null;
}

function detectFlatpakWrapper(binPath) {
  try {
    if (!existsSync(binPath)) return null;
    return parseFlatpakWrapper(readFileSync(binPath, "utf8"));
  } catch {
    return null;
  }
}

/** Durable profile root for flatpak sessions (host-visible in the sandbox via the home grant). */
export function flatpakProfileRoot() {
  return join(process.env.HOME ?? tmpdir(), ".local", "share", "leia", "profiles");
}

/**
 * Profile dir for a new session. Flatpak mode: under ~/.local/share/leia
 * (issue #21 gap 2 — the sandbox has no /tmp grant, so a /tmp profile dies
 * with the sandbox tmpfs and wipes storage.local under a still-running
 * browser; the home grant makes this root host-visible inside the sandbox).
 * Plain mode: /tmp/opencode exactly as before. mkdtemp keeps concurrent
 * sessions (lanes, parallel e2e) collision-free.
 */
export function makeProfileDir(flatpakAppId) {
  if (flatpakAppId) {
    const root = flatpakProfileRoot();
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, "leia-chrome-"));
  }
  return mkdtempSync(join("/tmp/opencode", "leia-chrome-"));
}

export class ChromeAdapter extends BrowserAdapter {
  constructor(opts = {}) {
    super(opts);
    this.chromeBin = opts.chromeBin || process.env.CHROME || "chromium";
    this.debugPort = opts.debugPort ?? 9224;
    this.profileDir = null;
    this.child = null;
    this.extensionId = "";
    this._targetWs = null; // CDP socket to the harness page
    this._cdpSeq = 0;
    // a11y recipe bookkeeping: the pre-spawn flag value leia flipped (§
    // _ensureA11yRecipe); null when leia changed nothing. Restore happens in
    // stop()'s finally — `down` needs no a11y teardown because the spawn arg
    // dies with the browser process and the bus flag is session-scoped
    // launcher state, not per-browser state.
    this._a11yPrior = null;
    // Flatpak session bookkeeping (issue #21): app-id from the wrapper
    // content, and the sandbox instance id resolved after spawn for surgical
    // teardown. Null/null = plain binary, byte-for-byte today's behavior.
    this.flatpakAppId = null;
    this.flatpakInstanceId = null;
  }

  async start() {
    if (this.opts.port && !CSP_ALLOWED_PORTS.has(this.opts.port)) {
      console.warn(
        `[chrome] port ${this.opts.port} is not in the extension CSP connect-src; ` +
          `the harness WS auto-connect may be blocked. Use 9333 for the default path.`,
      );
    }
    await this._startBridge();

    const dist = join(REPO, "dist", "chrome");
    if (!existsSync(join(dist, "manifest.json"))) {
      throw new Error(`dist/chrome missing — run \`npm run build -- --dev\` first`);
    }

    this.flatpakAppId = detectFlatpakWrapper(this.chromeBin);
    await this._prepareFlatpakSession();
    this.profileDir = makeProfileDir(this.flatpakAppId);
    const recipe = this._ensureA11yRecipe();
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--remote-debugging-port=${this.debugPort}`,
      `--load-extension=${dist}`,
      "about:blank",
    ];
    if (recipe.spawnArg) args.splice(args.indexOf("--disable-gpu") + 1, 0, recipe.spawnArg);
    this.child = spawn(
      this.chromeBin,
      args,
      // detached: the browser must outlive `up` — one-shot commands re-attach
      // to its CDP port via state.json (the firefox path survives through
      // geckodriver; chromium's wrapper chain dies with the parent otherwise).
      { stdio: "ignore", detached: true },
    );
    this.child.unref();

    const extId = await this._discoverExtensionId();
    if (!extId) await this._failMissingExtension();
    this.extensionId = extId;
    // The wrapper execs `flatpak run`, so child.pid IS the flatpak-run pid.
    // Resolve OUR sandbox instance now (browser is up, so the instance is
    // listed) — `down` needs it to kill the sandbox, not just the wrapper
    // (issue #21 gap 1).
    this.flatpakInstanceId = this.flatpakAppId ? this._resolveFlatpakInstance() : null;

    await this._openHarnessAndConnect();
    this._persistState(extId);
    // Let the CLI process exit after `up` like the firefox path: unref the
    // bridge listener and the CDP socket so neither holds the event loop
    // open. One-shot commands re-bind the bridge; the harness wake
    // reconnects it.
    if (this.ws?.wss?._server) this.ws.wss._server.unref();
    this._targetWs?._socket?.unref?.();
  }

  /** One-shot command path: start the bridge + wait for the harness to connect. */
  async ensureReady(timeoutMs = 8000) {
    if (!this.ws) await this._startBridge();
    const st = loadState();
    if (st?.browser === "chrome") {
      this.debugPort = st.debugPort;
      this.profileDir = st.profileDir;
      this.extensionId = st.extensionId;
      await this._attachTargetSocket();
    }
    const gotHello = await this._waitForHello(timeoutMs);
    if (!gotHello) {
      // Background-tab timer throttling can park the harness's reconnect
      // loop for a minute — poke the page (CDP) like the firefox tiered
      // wake, then wait once more.
      await this._retriggerConnect();
      await this._waitForHello(3000);
    }
    if (!this.ws?.helloSeen && !this.connected) {
      throw new Error("harness not connected — run `leia up` first");
    }
  }

  async _openHarnessAndConnect() {
    const tokenQ = this.opts.token ? `&token=${encodeURIComponent(this.opts.token)}` : "";
    const harnessUrl = `chrome-extension://${this.extensionId}/harness/harness.html?ws=${encodeURIComponent(this.wsUrl)}${tokenQ}`;
    await this._openTarget(harnessUrl);
    let gotHello = await this._waitForHello(8000);
    if (!gotHello) {
      await this._retriggerConnect();
      gotHello = await this._waitForHello(3000);
    }
    await this._attachTargetSocket();
  }

  async _discoverExtensionId() {
    for (let i = 0; i < 60; i++) {
      const targets = await this._targets();
      const sw = targets.find(
        (t) => t.type === "service_worker" && t.url && t.url.includes("/background/index.js"),
      );
      if (sw) {
        try {
          return new URL(sw.url).hostname;
        } catch {
          return "";
        }
      }
      await sleep(500);
    }
    return "";
  }

  async _targets() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.debugPort}/json`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  async _openTarget(url) {
    const r = await fetch(`http://127.0.0.1:${this.debugPort}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
    });
    const j = await r.json();
    return j.webSocketDebuggerUrl || null;
  }

  async _attachTargetSocket() {
    const targets = await this._targets();
    const page = targets.find((t) => t.url && t.url.includes("/harness/harness.html"));
    const wsUrl = page?.webSocketDebuggerUrl;
    if (!wsUrl) return;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    this._targetWs = ws;
  }

  _cdp(method, params) {
    const ws = this._targetWs;
    if (!ws) return Promise.reject(new Error("no CDP target socket attached"));
    const id = ++this._cdpSeq;
    return new Promise((resolve, reject) => {
      const on = (data) => {
        const m = JSON.parse(data.toString());
        if (m.id === id) {
          ws.off("message", on);
          if (m.error) reject(new Error(`CDP ${method}: ${m.error.message || "error"}`));
          else resolve(m);
        }
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _waitForHello(timeoutMs) {
    if (this.ws?.helloSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const off = this.ws?.onHello(() => {
        off?.();
        resolve(true);
      });
      setTimeout(() => {
        off?.();
        resolve(false);
      }, timeoutMs);
    });
  }

  _retriggerConnect() {
    return this
      ._evalNow(
        `(function(){ try { if (globalThis.__leiaRestart) globalThis.__leiaRestart(); } catch(e){} return 'ok'; })()`,
      )
      .catch(() => undefined);
  }

  /** Evaluate JS in the extension harness page context (CDP). */
  async _evalNow(expression) {
    if (!this._targetWs) await this._attachTargetSocket();
    const res = await this._cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return res.result?.result?.value;
  }

  eval(js) {
    return this._evalNow(js);
  }

  async openTab(url) {
    await this._openTarget(url);
  }

  /**
   * Pre-spawn a11y activation recipe (docs/cua-e2e.md). Best-effort — NEVER
   * hard-fails `leia up` (a11y only matters to the cua e2e; leia must keep
   * working on bus-less systems). The flag is read by chromium at browser
   * process start, so this runs before spawn, never after.
   *
   * Restore semantics live in stop(): only a flag leia itself flipped
   * (`set-by-leia`) is restored, and only when no cua daemon owns it.
   */
  _ensureA11yRecipe() {
    if (process.env.LEIA_NO_FORCE_A11Y) {
      console.warn("[chrome] a11y recipe disabled (LEIA_NO_FORCE_A11Y)");
      return { flag: "skipped", spawnArg: null };
    }
    let value;
    try {
      const read = spawnSync("busctl", A11Y_FLAG_GET, { encoding: "utf8" });
      if (read.status !== 0) throw new Error(read.stderr?.trim() || `exit ${read.status}`);
      value = read.stdout.trim() === "b true";
    } catch (err) {
      console.warn(
        `[chrome] a11y bus flag unreadable (${err.message}); the cua e2e cannot ` +
          "see this browser — see docs/cua-e2e.md",
      );
      // Still add the spawn arg: alone it enables nothing, costs nothing, and
      // self-heals if the bus flag gets set later.
      return { flag: "unknown", spawnArg: FORCE_A11Y_ARG };
    }
    if (value) return { flag: "already", spawnArg: FORCE_A11Y_ARG };
    try {
      const set = spawnSync("busctl", A11Y_FLAG_SET("true"), { encoding: "utf8" });
      if (set.status !== 0) throw new Error(set.stderr?.trim() || `exit ${set.status}`);
    } catch (err) {
      console.warn(
        `[chrome] could not set the a11y bus flag (${err.message}); the cua e2e ` +
          "cannot see this browser — see docs/cua-e2e.md",
      );
      return { flag: "unknown", spawnArg: FORCE_A11Y_ARG };
    }
    this._a11yPrior = false;
    return { flag: "set-by-leia", prior: false, spawnArg: FORCE_A11Y_ARG };
  }

  /**
   * Restore ScreenReaderEnabled only when leia flipped it (`_a11yPrior ===
   * false`); a flag that was already true needs no restore (we changed
   * nothing). While a cua daemon answers, leave it true — the daemon set the
   * flag first and re-asserts it at startup; restoring `false` under it would
   * break the next launch's a11y visibility. Best-effort, ignores errors.
   */
  _restoreA11yFlag() {
    if (this._a11yPrior !== false) return;
    this._a11yPrior = null;
    const daemonActive = existsSync(CUA_DAEMON_SOCK) && spawnSync("cua-driver", ["status"]).status === 0;
    if (daemonActive) {
      console.warn("[chrome] cua daemon active — leaving ScreenReaderEnabled=true (daemon-owned)");
      return;
    }
    try {
      spawnSync("busctl", A11Y_FLAG_SET("false"));
    } catch {}
  }

  async _killChild() {
    try {
      this.child?.kill("SIGTERM");
    } catch {}
    this.child = null;
  }

  async stop() {
    try {
      this._closeTargetSocket();
      const st = loadState();
      const spawnedPid = this.child?.pid;
      await this._killChildIfNeeded(st);
      // Flatpak sandboxes outlive their wrapper pid (issue #21 gap 1): after
      // the pid kill, surgically kill OUR instance and verify the debug port
      // is actually free. On failure this throws BEFORE the profile/state
      // cleanup — state.json stays for a retry, and the durable profile of a
      // possibly-still-alive browser is not deleted underneath it.
      await this._teardownFlatpak(st);
      await sleep(400);
      this._removeProfile(st);
      if (spawnedPid || st?.browser === "chrome") clearState();
    } finally {
      this._restoreA11yFlag();
    }
  }

  _closeTargetSocket() {
    try {
      this._targetWs?.close();
    } catch {}
    this._targetWs = null;
  }

  async _killChildIfNeeded(st) {
    if (this.child) {
      await this._killChild();
    } else if (st?.browser === "chrome" && st?.pid) {
      try {
        process.kill(st.pid, "SIGTERM");
      } catch {}
    }
  }

  // ----- flatpak lifecycle (issue #21) ------------------------------------

  /** No-op for plain binaries; warns + reconciles stale state for flatpak. */
  async _prepareFlatpakSession() {
    if (!this.flatpakAppId) return;
    console.warn(
      `[chrome] flatpak mode: ${this.flatpakAppId} — durable profile under ` +
        `${flatpakProfileRoot()}, teardown kills the sandbox instance (issue #21)`,
    );
    await this._reconcileStaleState();
  }

  /** Extension discovery failed: tear down what we spawned, then throw. */
  async _failMissingExtension() {
    // Resolve the instance while this.child is still known (pid matching).
    if (this.flatpakAppId) this.flatpakInstanceId ??= this._resolveFlatpakInstance();
    await this._killChild();
    if (this.flatpakAppId) {
      // The sandbox outlives the wrapper — kill it before bailing.
      try {
        await this._teardownFlatpak(null);
      } catch {}
    }
    throw new Error("could not discover the extension id from the background service worker");
  }

  /** Persist the cross-invocation record. Optional flatpak fields stay absent for plain binaries. */
  _persistState(extId) {
    saveState({
      browser: "chrome",
      debugPort: this.debugPort,
      profileDir: this.profileDir,
      extensionId: extId,
      pid: this.child.pid,
      // state.json written by older versions (or for plain binaries) lacks
      // the flatpak fields — every reader treats them as nullable.
      ...(this.flatpakAppId
        ? { flatpakAppId: this.flatpakAppId, instanceId: this.flatpakInstanceId }
        : {}),
    });
  }

  /**
   * `flatpak ps -j` rows. Empty on any failure — teardown then degrades to
   * the port-polling ladder instead of trusting a half-read inventory.
   */
  _flatpakRows() {
    try {
      const r = spawnSync("flatpak", ["ps", "-j"], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout?.trim()) return [];
      const rows = JSON.parse(r.stdout);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /**
   * Match our spawned child to its flatpak sandbox instance. The wrapper
   * script `exec`s `flatpak run`, so child.pid is the flatpak-run pid —
   * matched against the `pid` (wrapper) or `child-pid` (sandbox process)
   * column, whichever this flatpak version populates. Falls back to the only
   * listed instance of the app when the pid columns disagree with reality;
   * never guesses among several (a wrong guess would kill someone else's
   * browser).
   */
  _resolveFlatpakInstance() {
    const rows = this._flatpakRows().filter((row) => row.application === this.flatpakAppId);
    const mine = rows.find(
      (row) => Number(row.pid) === this.child?.pid || Number(row["child-pid"]) === this.child?.pid,
    );
    if (mine) return String(mine.instance);
    if (rows.length === 1) {
      console.warn(
        `[chrome] flatpak ps pid mismatch (child ${this.child?.pid} not listed) — ` +
          `assuming the only ${this.flatpakAppId} instance ${rows[0].instance}`,
      );
      return String(rows[0].instance);
    }
    console.warn(
      `[chrome] could not match pid ${this.child?.pid} to a ${this.flatpakAppId} instance ` +
        `(${rows.length} listed) — teardown will poll the port and last-resort only if still bound`,
    );
    return null;
  }

  /** True while something answers CDP on the debug port. */
  async _portAlive(port, timeoutMs = 800) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Poll until the port stops answering CDP (or the budget runs out). */
  async _waitPortFree(port, budgetMs = 5000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!(await this._portAlive(port))) return true;
      await sleep(250);
    }
    return !(await this._portAlive(port));
  }

  /**
   * Surgical sandbox teardown (issue #21 gap 1). `flatpak kill <instance>`
   * only ever targets OUR instance — never the app-id wholesale, because the
   * user may have their own windows of the same app running. Ladder:
   * instance kill → poll port → (still bound) loud last-resort app-id kill →
   * poll → (still bound) throw, naming what to clean up by hand. A no-op for
   * plain binaries (no flatpakAppId anywhere) — exactly today's behavior.
   */
  async _teardownFlatpak(st) {
    const appId = this.flatpakAppId ?? (st?.browser === "chrome" ? st?.flatpakAppId : null);
    if (!appId) return;
    const instanceId = this.flatpakInstanceId ?? st?.instanceId ?? null;
    const port = st?.debugPort ?? this.debugPort;
    if (instanceId) {
      const r = spawnSync("flatpak", ["kill", String(instanceId)], { encoding: "utf8" });
      if (r.status !== 0) {
        console.warn(
          `[chrome] flatpak kill ${instanceId} failed (${r.stderr?.trim() || `exit ${r.status}`})`,
        );
      }
    }
    if (await this._waitPortFree(port)) return;
    // Last resort: the instance kill did not free the port. Killing by
    // app-id takes down EVERY instance of the app — including the user's own
    // windows — so enumerate them loudly BEFORE pulling the trigger.
    const victims = this._flatpakRows().filter((row) => row.application === appId);
    console.warn(
      `[chrome] debug port ${port} still bound after killing instance ${instanceId ?? "(unknown)"}` +
        ` — LAST RESORT: killing ALL instances of ${appId}: ` +
        (victims.map((v) => `${v.instance} (pid ${v.pid})`).join(", ") || "(none currently listed)"),
    );
    spawnSync("flatpak", ["kill", appId]);
    if (await this._waitPortFree(port)) return;
    throw new Error(
      `flatpak teardown failed: debug port ${port} is still bound ` +
        `(instance ${instanceId ?? "unknown"}, pid ${this.child?.pid ?? st?.pid ?? "?"}) — ` +
        "inspect `flatpak ps` and free it manually; leia state kept for a retry",
    );
  }

  /**
   * Pre-spawn guard for flatpak `up` (issue #21 gap 1's double-bind): a live
   * session on the recorded port would leave `up` probing SOMEONE ELSE'S CDP
   * server (possibly an orphan), so refuse; a dead one gets its profile
   * swept (crash left it — clean `down` removes it) and its state cleared.
   * Plain binaries keep today's behavior.
   */
  async _reconcileStaleState() {
    const st = loadState();
    if (st?.browser !== "chrome") return;
    const port = st.debugPort ?? this.debugPort;
    if (await this._portAlive(port)) {
      throw new Error(
        `a leia chrome session is already running (pid ${st.pid ?? "?"}, port ${port}) — run \`leia down\` first`,
      );
    }
    console.warn(
      `[chrome] stale state from a dead session (pid ${st.pid ?? "?"}, port ${port}) — ` +
        "sweeping its profile before a fresh spawn",
    );
    if (st.profileDir) {
      try {
        rmSync(st.profileDir, { recursive: true, force: true });
      } catch {}
    }
    clearState();
  }

  _removeProfile(st) {
    const profile = this.profileDir || (st?.browser === "chrome" ? st?.profileDir : null);
    if (profile) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }
    this.profileDir = null;
  }

  close() {
    this._targetWs?.close();
    this._targetWs = null;
    super.close();
  }
}
