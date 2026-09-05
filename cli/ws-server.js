// SPDX-License-Identifier: MPL-2.0
/**
 * CLI-side WS bridge. The harness page is the WS *client*; this is the
 * *server*. The extension page connects to `ws://127.0.0.1:<port>` (see
 * SPEC "WS protocol"), exchanges `{type:'command'}` / `{type:'reply'}` /
 * `{type:'event'}` / `{type:'hello'}` messages.
 *
 * This module owns the socket + the pending-reply correlation table. It is a
 * transport ONLY — no command semantics. The browser adapters own bring-up
 * and just call `sendCommand` / subscribe to events.
 */
import { WebSocketServer, WebSocket } from "ws";
/** One logical time to wait for a harness reply before giving up. */
const DEFAULT_REPLY_TIMEOUT_MS = 15_000;

export class WsServer {
  /**
   * @param {{ port: number, host?: string, token?: string | null }} opts
   */
  constructor({ port, host = "127.0.0.1", token = null }) {
    this.host = host;
    this.port = port;
    this.token = token || null; // accepted but NOT enforced yet (see note below)
    // TODO(token handshake): the SPEC calls for a `--token` handshake (token on
    // by default). The harness only reads `?ws=` and has no token param, so the
    // CLI defaults to no-token. To enforce: have the harness read `?token=` and
    // present it, then reject connections whose first message lacks a matching
    // token. Left as accepted-but-unenforced so the CLI is ready once the
    // harness lane adds the param.
    this.wss = null;
    this.client = null; // the connected harness socket (may reconnect)
    this.seq = 0;
    this.helloSeen = false; // whether we ever received a hello on this run
    this._authorized = new Set(); // sockets that passed the token handshake
    this.pending = new Map(); // id -> {resolve, reject, timer, name}
    this.eventListeners = new Set();
    this.helloListeners = new Set();
    this.connectionListeners = new Set();
    this.disconnectListeners = new Set();
    this.errorListeners = new Set();
    this.rawListeners = new Set();
  }

  start() {
    this.wss = new WebSocketServer({ host: this.host, port: this.port });
    this.wss.on("connection", (sock) => this._onConnection(sock));
    this.wss.on("error", (e) => this._emit("error", e));
    return new Promise((resolve, reject) => {
      this.wss.once("listening", () => resolve(`ws://${this.host}:${this.port}`));
      this.wss.once("error", reject);
    });
  }

  _onConnection(sock) {
    this.client = sock;
    sock.on("message", (d) => this._onMessage(sock, d));
    sock.on("close", () => {
      if (this.client === sock) {
        this.client = null;
        this._rejectAll("harness disconnected");
      }
      this._emit("disconnect", sock);
    });
    sock.on("error", () => {});
    this._emit("connect", sock);
  }
  /** Enforce the token handshake: reject any socket that doesn't greet correctly. */
  _authorize(sock, m) {
    if (!this.token) return true;
    if (this._authorized.has(sock)) return true;
    if (m && m.type === "hello" && m.token === this.token) {
      this._authorized.add(sock);
      return true;
    }
    sock.close(4001, "bad-or-missing-token");
    return false;
  }

  _onMessage(sock, d) {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (!this._authorize(sock, m)) return;

    if (m.type === "hello") {
      this.helloSeen = true;
      this._emit("hello", m);
      return;
    }    if (m.type === "event") {
      this._emitEvent(m.name, m.data, m);
      return;
    }
    if (m.type === "reply" && typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    // Unknown message shape — surface it on the raw stream.
    this._emit("raw", m);
  }

  // ---- sending ----------------------------------------------------------

  _nextId() {
    return ++this.seq;
  }

  /**
   * Send a `{type:'command'}` and await the matching `{type:'reply'}`.
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<{ok:boolean, replyType?:string, data?:unknown, error?:string}>}
   */
  async sendCommand(name, args = {}) {
    const sock = this.client;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      throw new Error("no harness connected — run `leia up` first");
    }
    const id = this._nextId();
    sock.send(JSON.stringify({ type: "command", id, name, args }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command '${name}' timed out after ${DEFAULT_REPLY_TIMEOUT_MS}ms`));
      }, DEFAULT_REPLY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, name });
    });
  }

  _rejectAll(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Close the server and any live connection. */
  close() {
    this._rejectAll("server closed");
    try {
      this.client?.close();
    } catch {}
    this.wss?.close();
  }

  /** @returns {boolean} whether a harness socket is currently connected. */
  get connected() {
    return Boolean(this.client && this.client.readyState === WebSocket.OPEN);
  }

  // ---- subscriptions -----------------------------------------------------

  onEvent(cb) {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onHello(cb) {
    this.helloListeners.add(cb);
    return () => this.helloListeners.delete(cb);
  }

  onConnection(cb) {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  onDisconnect(cb) {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  onError(cb) {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  onRaw(cb) {
    this.rawListeners.add(cb);
    return () => this.rawListeners.delete(cb);
  }

  offEvent(cb) {
    this.eventListeners.delete(cb);
  }
  offConnection(cb) {
    this.connectionListeners.delete(cb);
  }
  offDisconnect(cb) {
    this.disconnectListeners.delete(cb);
  }

  _emit(kind, payload) {
    const table = {
      connect: this.connectionListeners,
      disconnect: this.disconnectListeners,
      hello: this.helloListeners,
      error: this.errorListeners,
      raw: this.rawListeners,
    };
    for (const cb of table[kind] || []) cb(payload);
  }

  _emitEvent(name, data, raw) {
    for (const cb of this.eventListeners) {
      try {
        cb(name, data, raw);
      } catch {}
    }
  }
}

/** Convenience: create + start a server, awaiting listening. */
export async function createWsServer(opts) {
  const s = new WsServer(opts);
  await s.start();
  return s;
}
