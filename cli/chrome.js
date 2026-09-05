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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BrowserAdapter } from "./adapter.js";
import { loadState, saveState, clearState } from "./state.js";

const REPO = new URL("..", import.meta.url).pathname;

// Chrome's CSP connect-src (src/manifest.json) is fixed to these loopback
// origins; the harness must land on a port the CSP allows.
const CSP_ALLOWED_PORTS = new Set([9333]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    this.profileDir = mkdtempSync(join("/tmp/opencode", "leia-chrome-"));
    this.child = spawn(
      this.chromeBin,
      [
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--remote-debugging-port=${this.debugPort}`,
        `--load-extension=${dist}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    this.child.unref();

    const extId = await this._discoverExtensionId();
    if (!extId) {
      await this._killChild();
      throw new Error("could not discover the extension id from the background service worker");
    }
    this.extensionId = extId;

    await this._openHarnessAndConnect();
    saveState({ browser: "chrome", debugPort: this.debugPort, profileDir: this.profileDir, extensionId: extId, pid: this.child.pid });
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
      // The harness may need a nudge; but if no bridge bind was running the
      // harness reconnects on its own within ~1s, so a single re-wait suffices.
      await this._waitForHello(2000);
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

  async _killChild() {
    try {
      this.child?.kill("SIGTERM");
    } catch {}
    this.child = null;
  }

  async stop() {
    this._closeTargetSocket();
    const st = loadState();
    const spawnedPid = this.child?.pid;
    await this._killChildIfNeeded(st);
    await sleep(400);
    this._removeProfile(st);
    if (spawnedPid || st?.browser === "chrome") clearState();
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
