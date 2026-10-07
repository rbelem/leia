// SPDX-License-Identifier: MPL-2.0
/**
 * QwenCloud TTS engine (Alibaba Qwen/TTS family). Two transports, dispatched
 * on the key's shape (deterministic, testable — no live fallback chains):
 *
 * - Normal DashScope keys ("sk-…"): DashScope REST API — one POST per chunk
 *   to the multimodal-generation endpoint returns a JSON envelope whose
 *   `output.audio.url` points at a WAV file (24h expiry, OSS host) — a second
 *   GET fetches the bytes for audioHost playback.
 * - Alibaba plan keys ("sk-sp-…"): these only reach the token-plan MaaS
 *   gateway, whose TTS models (qwen-audio-3.0-tts-*) are WebSocket-only —
 *   the HTTP path rejects them with 400. The WS task protocol
 *   (run-task → continue-task → finish-task; binary frames = audio) is
 *   batch-collected and played on task-finished.
 *
 * WS auth: the token-plan gateway 401s every browser-reachable credential
 * form (query param `?api-key=`, subprotocol, cookies — all tested live
 * 2026-10-07); it accepts ONLY the handshake `Authorization` header, which
 * browser JS cannot set. The bridge is a declarativeNetRequest session rule
 * that sets `Authorization: bearer <key>` on `websocket`-type requests to
 * the gateway origin (Authorization is not on DNR's restricted-header list;
 * verified live: 52 KB of MP3 synthesized from an extension page). The rule
 * installs right before the socket opens and is removed when the task ends.
 *
 * No timestamps in either response — sentence-granularity marching highlight
 * only (ADR-0003), so `wordTiming: false` and NO word events ever. `rate`
 * has no API field — accepted and ignored.
 *
 * Runs in any DOM-ish context (Firefox event page, Chrome offscreen doc):
 * fetch, getKey, WebSocket creation, header-rule install, and audio playback
 * are injected (or defaulted to the platform).
 */
import { EventStream } from "../reader/event-stream";
import type { EngineCapabilities, EngineEvent, SpeakOptions, TextEngine, VoiceInfo } from "../reader/contract";
import { DOM_AUDIO_HOST, type AudioHost, type Playback } from "./engine-minimax";

export const QWENCLOUD_TTS_URL =
  "https://maas.qwencloudapi.com/api/v1/services/aigc/multimodal-generation/generation";
export const QWENCLOUD_MODEL = "qwen3-tts-flash"; // low-latency tier; plus tier targets audiobook production
export const QWENCLOUD_DEFAULT_VOICE = "Cherry";
export const QWENCLOUD_MAX_CHARS = 600; // API input limit; session chunks are ≤250, so this only trips on misuse

/** token-plan MaaS gateway: the only host plan keys can reach (public gateway 401s them). */
export const QWENCLOUD_WS_URL = "wss://token-plan.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference";
export const QWENCLOUD_WS_MODEL = "qwen-audio-3.0-tts-plus";
export const QWENCLOUD_WS_DEFAULT_VOICE = "longanlingxin";
/** System voices valid for qwen-audio-3.0-tts-plus; any other voice → "Engine error 411". */
export const QWENCLOUD_WS_VOICES: string[] = ["longanlingxin", "longanlufeng"];

/** Plan keys (sk-sp-…) live on the token-plan gateway and speak the WS task protocol. */
export const isPlanKey = (key: string): boolean => key.startsWith("sk-sp-");

/**
 * Installs the WS handshake credentials without touching any HTTP path.
 * Default implementation: a declarativeNetRequest session rule setting the
 * `Authorization` header on websocket-type requests to the gateway.
 */
export interface WsAuthRule {
  install(key: string): Promise<void>;
  remove(): Promise<void>;
}

/** Minimal structural view of the DNR API (avoids a chrome-types dependency). */
export interface DnrApi {
  updateSessionRules(changes: {
    removeRuleIds: number[];
    addRules?: Array<{
      id: number;
      priority: number;
      action: {
        type: string;
        requestHeaders: Array<{ header: string; operation: string; value: string }>;
      };
      condition: { urlFilter: string; resourceTypes: string[] };
    }>;
  }): Promise<void>;
}

const WS_AUTH_RULE_ID = 42;
const WS_AUTH_HOST = "token-plan.ap-southeast-1.maas.aliyuncs.com";

/** Install the Authorization-injecting session rule (websocket requests to the gateway only). */
export function installWsAuthRule(dnr: DnrApi, key: string): Promise<void> {
  return dnr.updateSessionRules({
    removeRuleIds: [WS_AUTH_RULE_ID],
    addRules: [
      {
        id: WS_AUTH_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Authorization", operation: "set", value: `bearer ${key}` }],
        },
        condition: { urlFilter: `||${WS_AUTH_HOST}/`, resourceTypes: ["websocket"] },
      },
    ],
  });
}

export function removeWsAuthRule(dnr: DnrApi): Promise<void> {
  return dnr.updateSessionRules({ removeRuleIds: [WS_AUTH_RULE_ID] });
}

/** chrome (MV3) or browser (Firefox event page) DNR; null where unavailable. */
function directDnr(): DnrApi | null {
  const g = globalThis as { chrome?: { declarativeNetRequest?: DnrApi }; browser?: { declarativeNetRequest?: DnrApi } };
  const dnr = g.browser?.declarativeNetRequest ?? g.chrome?.declarativeNetRequest;
  return dnr?.updateSessionRules ? dnr : null;
}

/** chrome (MV3) or browser runtime messaging; null where unavailable. */
function runtimeApi(): { sendMessage(message: unknown): Promise<unknown> } | null {
  const g = globalThis as {
    chrome?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } };
    browser?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } };
  };
  return g.browser?.runtime ?? g.chrome?.runtime ?? null;
}

/**
 * Default rule source, in order: direct DNR (service worker / Firefox event
 * page), then delegation to the SW over runtime messaging (Chrome offscreen
 * document — it hosts the audio engines but Chrome does not expose
 * declarativeNetRequest there). Null when neither exists (tests without
 * injection).
 */
function platformAuthRule(): WsAuthRule | null {
  const dnr = directDnr();
  if (dnr) {
    return {
      install: (key) => installWsAuthRule(dnr, key),
      remove: () => removeWsAuthRule(dnr),
    };
  }
  const runtime = runtimeApi();
  if (runtime?.sendMessage) {
    const send = async (message: Record<string, unknown>): Promise<void> => {
      const reply = (await runtime.sendMessage(message)) as { ok?: boolean; error?: string } | null | undefined;
      if (reply && reply.ok === false) throw new Error(reply.error ?? "ws-auth request failed");
    };
    return {
      install: async (key) => {
        try {
          await send({ type: "leia:ws-auth", op: "install", key });
        } catch (err) {
          throw new Error(`ws-auth install failed: ${String(err)}`);
        }
      },
      remove: async () => {
        try {
          await send({ type: "leia:ws-auth", op: "remove" });
        } catch {
          // Remove is best-effort hygiene; a failed remove must not mask the task outcome.
        }
      },
    };
  }
  return null;
}

export const QWENCLOUD_CAPABILITIES: EngineCapabilities = {
  wordTiming: false,
  streaming: false,
  costClass: "paid",
  privacyClass: "provider",
  maxUtteranceChars: 2000,
};

/**
 * Curated voice list — QwenCloud documents no voice-list endpoint; the 10
 * voices confirmed for qwen3-tts-flash in the Qwen-TTS voice list
 * (docs.qwencloud.com, 2026-10). ponytail: static list; refresh if
 * QwenCloud documents a list endpoint.
 */
export const QWENCLOUD_VOICES: string[] = [
  "Cherry", // default
  "Serena",
  "Ethan",
  "Chelsie",
  "Momo",
  "Vivian",
  "Moon",
  "Maia",
  "Kai",
  "Nofish",
];

export interface QwenCloudEngineOptions {
  getKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  audioHost?: AudioHost;
  /** WS transport for plan keys; defaults to the platform WebSocket. */
  wsFactory?: (url: string) => WebSocket;
  /** WS handshake credentials; defaults to the platform DNR session rule (null forces it absent — tests). */
  authRule?: WsAuthRule | null;
}

interface ActiveSpeak {
  speakId: number;
  stream: EventStream<EngineEvent>;
  playback: Playback | null;
  /** Tears down the WS transport (close socket + auth rule) on preempt/cancel. */
  abort?: () => void;
}

/** Mutable state of one in-flight WS task (token-plan task protocol). */
interface WsSession {
  ws: WebSocket;
  taskId: string;
  text: string;
  chunks: Uint8Array[];
  /** Terminal state reached (finished/failed/error/cancelled): ignore late WS events. */
  terminal: boolean;
  teardown: () => void;
  stream: EventStream<EngineEvent>;
  speakId: number;
  fail: (message: string) => void;
}

interface WsHeader {
  action?: string;
  event?: string;
  error_code?: unknown;
  error_message?: unknown;
}

export class QwenCloudEngine implements TextEngine {
  readonly family = "qwencloud";
  readonly capabilities = QWENCLOUD_CAPABILITIES;
  private readonly getKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly audioHost: AudioHost;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly authRule: WsAuthRule | null;
  private active: ActiveSpeak | null = null;

  constructor(opts: QwenCloudEngineOptions) {
    this.getKey = opts.getKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis); // Firefox: bare fetch loses its Window `this`
    this.audioHost = opts.audioHost ?? DOM_AUDIO_HOST;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.authRule = opts.authRule === undefined ? platformAuthRule() : opts.authRule;
  }

  async getVoices(): Promise<VoiceInfo[]> {
    const key = await this.getKey();
    if (!key) return [];
    if (isPlanKey(key)) {
      return QWENCLOUD_WS_VOICES.map((name) => ({ name, lang: "zh-CN", localService: false, family: "qwencloud" }));
    }
    return QWENCLOUD_VOICES.map((name) => ({ name, lang: "en-US", localService: false, family: "qwencloud" }));
  }

  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent> {
    const stream = new EventStream<EngineEvent>();
    const wasActive = this.active;
    this.active = { speakId, stream, playback: null };
    if (wasActive) {
      // Preempt like the sibling engines: tear down the old transport,
      // close the old stream + stop its audio.
      wasActive.abort?.();
      wasActive.stream.closeCancelled({ type: "cancelled", speakId: wasActive.speakId });
      wasActive.playback?.stop();
    }
    void this.run(text, speakId, options, stream);
    return stream;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    if (active) {
      active.abort?.();
      active.stream.closeCancelled({ type: "cancelled", speakId: active.speakId });
      active.playback?.stop();
    }
  }

  // --- internals ---

  private async run(
    text: string,
    speakId: number,
    options: SpeakOptions,
    stream: EventStream<EngineEvent>,
  ): Promise<void> {
    const fail = (message: string): void => {
      stream.push({ type: "error", speakId, message });
      stream.close();
      if (this.active?.speakId === speakId) this.active = null;
    };

    const key = await this.getKey();
    if (!this.isCurrent(speakId)) return;
    if (!key) {
      fail("QwenCloud API key not set — providers settings");
      return;
    }
    if (text.length > QWENCLOUD_MAX_CHARS) {
      fail(`QwenCloud text too long (${text.length} > ${QWENCLOUD_MAX_CHARS} chars)`);
      return;
    }
    if (isPlanKey(key)) await this.runWs(text, speakId, options, key, stream, fail);
    else await this.runHttp(text, speakId, options, key, stream, fail);
  }

  /** Plan-key transport: WS task protocol against the token-plan gateway. */
  private async runWs(
    text: string,
    speakId: number,
    options: SpeakOptions,
    key: string,
    stream: EventStream<EngineEvent>,
    fail: (message: string) => void,
  ): Promise<void> {
    const authRule = this.authRule;
    if (!authRule) {
      fail("QwenCloud plan keys need the WebSocket auth rule (declarativeNetRequest unavailable in this context)");
      return;
    }
    try {
      await authRule.install(key);
    } catch (err) {
      fail(`QwenCloud WS auth rule failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) {
      void authRule.remove().catch(() => undefined);
      return;
    }

    let ws: WebSocket;
    try {
      ws = this.wsFactory(QWENCLOUD_WS_URL);
    } catch (err) {
      void authRule.remove().catch(() => undefined);
      fail(`QwenCloud WS open failed: ${String(err)}`);
      return;
    }
    ws.binaryType = "arraybuffer";

    const st: WsSession = {
      ws,
      taskId: crypto.randomUUID(),
      text,
      chunks: [],
      terminal: false,
      teardown: () => undefined, // wired right below
      stream,
      speakId,
      fail,
    };
    st.teardown = (): void => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      void authRule.remove().catch(() => undefined);
    };
    const abort = (): void => {
      st.terminal = true;
      st.teardown();
    };
    // Expose abort on the active slot so preempt/cancel tear the WS down mid-collection.
    if (this.isCurrent(speakId)) this.active = { speakId, stream, playback: null, abort };

    ws.onopen = () => {
      if (st.terminal) return;
      this.sendWsRunTask(ws, st.taskId, options.voiceName ?? QWENCLOUD_WS_DEFAULT_VOICE);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (st.terminal) return;
      this.onWsMessage(ev, st, abort);
    };
    ws.onerror = () => {
      if (st.terminal) return;
      st.terminal = true;
      st.teardown();
      fail("QwenCloud WS connection failed (CSP connect-src, missing host permission, or rejected auth)");
    };
    ws.onclose = () => {
      if (st.terminal) return;
      st.terminal = true;
      void authRule.remove().catch(() => undefined);
      fail("QwenCloud WS closed before task-finished");
    };
  }

  /** run-task opener — the exact task-protocol shape the gateway accepts. */
  private sendWsRunTask(ws: WebSocket, taskId: string, voice: string): void {
    ws.send(
      JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: QWENCLOUD_WS_MODEL,
          parameters: {
            text_type: "PlainText",
            voice,
            format: "mp3",
            sample_rate: 22050,
            volume: 50,
            rate: 1,
            pitch: 1,
            enable_ssml: false,
          },
          input: {},
        },
      }),
    );
  }

  private onWsMessage(ev: MessageEvent, st: WsSession, abort: () => void): void {
    if (typeof ev.data !== "string") {
      st.chunks.push(new Uint8Array(ev.data as ArrayBuffer));
      return;
    }
    this.onWsText(ev.data, st, abort);
  }

  /** Text frames are JSON task events; binary frames were audio (see onWsMessage). */
  private onWsText(data: string, st: WsSession, abort: () => void): void {
    let msg: { header?: WsHeader };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const event = msg.header?.event;
    if (event === "task-started") {
      st.ws.send(JSON.stringify({ header: { action: "continue-task", task_id: st.taskId, streaming: "duplex" }, payload: { input: { text: st.text } } }));
      st.ws.send(JSON.stringify({ header: { action: "finish-task", task_id: st.taskId, streaming: "duplex" }, payload: { input: {} } }));
      return;
    }
    if (event === "task-failed") {
      st.terminal = true;
      st.teardown();
      const message = msg.header?.error_message;
      st.fail(`QwenCloud WS task failed: ${typeof message === "string" && message.length > 0 ? message : "unknown error"}`);
      return;
    }
    if (event === "task-finished") {
      st.terminal = true;
      st.teardown();
      const bytes = concatAudio(st.chunks);
      if (bytes.length === 0) {
        st.fail("QwenCloud WS task finished with no audio");
        return;
      }
      void this.playCollected(bytes, st.speakId, st.stream, abort, "audio/mpeg");
    }
  }

  /** Batch-collected bytes → audioHost playback → start … end. Shared by the WS path. */
  private async playCollected(
    bytes: Uint8Array,
    speakId: number,
    stream: EventStream<EngineEvent>,
    abort: () => void,
    mime: string,
  ): Promise<void> {
    const playback = this.audioHost.play(bytes, mime);
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback, abort };
    stream.push({ type: "start", speakId });

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  /** Normal-key transport: the original two-step HTTP shape. */
  private async runHttp(
    text: string,
    speakId: number,
    options: SpeakOptions,
    key: string,
    stream: EventStream<EngineEvent>,
    fail: (message: string) => void,
  ): Promise<void> {
    // Step 1: synthesize → JSON envelope with a temporary audio URL.
    let resp: Response;
    try {
      resp = await this.fetchImpl(QWENCLOUD_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: QWENCLOUD_MODEL,
          input: {
            text,
            voice: options.voiceName ?? QWENCLOUD_DEFAULT_VOICE,
          },
        }),
      });
    } catch (err) {
      fail(`QwenCloud request failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!resp.ok) {
      fail(await errorDetail(resp));
      return;
    }
    let audioUrl: unknown;
    try {
      const body = (await resp.json()) as { output?: { audio?: { url?: unknown } } };
      audioUrl = body.output?.audio?.url;
    } catch {
      fail("QwenCloud response is not JSON");
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (typeof audioUrl !== "string" || audioUrl.length === 0) {
      fail("QwenCloud response has no audio url");
      return;
    }

    // Step 2: download the WAV bytes from the result URL.
    let audio: Response;
    try {
      audio = await this.fetchImpl(audioUrl);
    } catch (err) {
      fail(`QwenCloud audio download failed: ${String(err)}`);
      return;
    }
    if (!this.isCurrent(speakId)) return;
    if (!audio.ok) {
      fail(`QwenCloud audio error ${audio.status}`);
      return;
    }
    const buf = await audio.arrayBuffer();
    if (!this.isCurrent(speakId)) return;
    const mime = audioMime(audio);
    const playback = this.audioHost.play(new Uint8Array(buf), mime);
    if (!this.isCurrent(speakId)) {
      playback.stop();
      return;
    }
    this.active = { speakId, stream, playback };
    stream.push({ type: "start", speakId });

    await playback.done;
    if (this.active?.speakId === speakId) this.active = null;
    stream.push({ type: "end", speakId });
    stream.close();
  }

  private isCurrent(speakId: number): boolean {
    return this.active?.speakId === speakId;
  }

  /** Media clock of the active playback (audio.currentTime×1000) for the march re-anchor. */
  currentClockMs(): number | null {
    return this.active?.playback?.clockMs?.() ?? null;
  }
}

/** Result URLs are .wav; trust a declared audio/* content-type, else default. */
function audioMime(resp: Response): string {
  const ct = resp.headers.get("content-type")?.split(";")[0].trim() ?? "";
  return ct.startsWith("audio/") ? ct : "audio/wav";
}

/** WS binary frames arrive out of one connection in order — concatenate for one play(). */
function concatAudio(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Non-OK responses carry DashScope's top-level `{code, message}` JSON; fall back to the status. */
async function errorDetail(resp: Response): Promise<string> {
  if ((resp.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await resp.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length > 0) return body.message;
    } catch {
      // fall through to the generic status message
    }
  }
  return `QwenCloud error ${resp.status}`;
}
