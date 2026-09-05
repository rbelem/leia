// SPDX-License-Identifier: MPL-2.0
/**
 * BrowserAdapter interface + factory.
 *
 * An adapter bootstraps a browser so the extension's harness page connects to
 * the CLI's WS server, then routes commands/events over that same WS bridge.
 * Two transports are used:
 *   (a) Pure WS — the CLI runs the WebSocketServer; the adapter only brings
 *       the browser up + navigates the harness page to the WS URL so it
 *       connects. Commands/events flow over WS. This is what both adapters
 *       use (it is what the harness is built for).
 *   (b) evaluate() — a per-adapter escape hatch (CDP evaluated script for
 *       Chrome, BiDi script.evaluate for Firefox) used as a fallback to
 *       re-trigger the harness connect, or for ad-hoc JS.
 *
 * Adapters share the SAME WS bridge to the harness; only browser bring-up and
 * page-navigation differ.
 */
import { createWsServer } from "./ws-server.js";

/**
 * @typedef {object} AdapterOptions
 * @property {number} [port]               CLI WS bridge port (default 9333).
 * @property {string} [host]               loopback host (default 127.0.0.1).
 * @property {string|null} [token]         optional WS handshake token.
 * @property {string} [chromeBin]          chrome/chromium binary path (Chrome).
 * @property {number} [debugPort]          CDP debug port (Chrome).
 * @property {number} [marionettePort]     Firefox marionette port (default 2828).
 * @property {number} [bidiPort]           Firefox WebDriver BiDi port (default 9223).
 */

/**
 * Interface contract. Each adapter must implement:
 *   start()                      -> Promise<void>   bring browser up + navigate harness
 *   stop()                       -> Promise<void>   tear down what start() launched
 *   sendCommand(name, args)      -> Promise<reply>  route harness command over WS
 *   onEvent(cb)                  -> () => void      subscribe to {type:'event'}
 *   onConnection(cb)             -> () => void      harness socket connected
 *   onDisconnect(cb)             -> () => void      harness socket dropped
 *   eval(js)                     -> Promise<any>    (fallback) evaluate in page
 *   openTab(url)                 -> Promise<void>   open a subject/fixture tab
 *   wsUrl                        -> string          bridge URL for the harness
 *   connected                    -> boolean
 *   close()                      -> void             release WS server
 */
export class BrowserAdapter {
  constructor(opts = {}) {
    this.opts = opts;
    this.port = opts.port ?? 9333;
    this.host = opts.host ?? "127.0.0.1";
    this.token = opts.token ?? null;
    this.ws = null;
    // Queued subscriptions: applied whenever the bridge is (re)created so a
    // subscriber registered before `up` still receives live events.
    this._subs = { event: new Set(), connection: new Set(), disconnect: new Set() };
  }

  get wsUrl() {
    return `ws://${this.host}:${this.port}`;
  }

  async _startBridge() {
    this.ws = await createWsServer({ port: this.port, host: this.host, token: this.token });
    for (const cb of this._subs.event) this.ws.onEvent(cb);
    for (const cb of this._subs.connection) this.ws.onConnection(cb);
    for (const cb of this._subs.disconnect) this.ws.onDisconnect(cb);
    return this.ws;
  }

  // Overridden per adapter.
  async start() {
    throw new Error("not implemented");
  }
  async stop() {
    throw new Error("not implemented");
  }
  /**
   * One-shot command path: make sure the harness is connected. Default impl
   * only checks the bridge; subclasses that need to re-attach to a persistent
   * browser override this.
   */
  async ensureReady(_timeoutMs = 8000) {
    if (!this.ws) throw new Error("bridge not started — run `leia up` first");
  }
  async sendCommand(name, args = {}) {
    if (!this.ws) throw new Error("bridge not started");
    return this.ws.sendCommand(name, args);
  }
  async eval(_js) {
    throw new Error("not implemented");
  }
  async openTab(_url) {
    throw new Error("not implemented");
  }

  onEvent(cb) {
    this._subs.event.add(cb);
    this.ws?.onEvent(cb);
    return () => {
      this._subs.event.delete(cb);
      this.ws?.offEvent?.(cb);
    };
  }
  onConnection(cb) {
    this._subs.connection.add(cb);
    this.ws?.onConnection(cb);
    return () => {
      this._subs.connection.delete(cb);
      this.ws?.offConnection?.(cb);
    };
  }
  onDisconnect(cb) {
    this._subs.disconnect.add(cb);
    this.ws?.onDisconnect(cb);
    return () => {
      this._subs.disconnect.delete(cb);
      this.ws?.offDisconnect?.(cb);
    };
  }

  get connected() {
    return Boolean(this.ws && this.ws.connected);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Factory.
 * @param {"chrome"|"firefox"} browser
 * @param {AdapterOptions} [opts]
 * @returns {Promise<BrowserAdapter>}
 */
export async function createAdapter(browser, opts = {}) {
  if (browser === "chrome") {
    const mod = await import("./chrome.js");
    return new mod.ChromeAdapter(opts);
  }
  if (browser === "firefox") {
    const mod = await import("./firefox.js");
    return new mod.FirefoxAdapter(opts);
  }
  throw new Error(`unknown browser '${browser}' (expected 'chrome' or 'firefox')`);
}
