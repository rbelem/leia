// SPDX-License-Identifier: MPL-2.0
// WS-transport tests for the QwenCloud plan-key path (token-plan task protocol).
// The socket and the auth-rule are injected, mirroring the fetchImpl/audioHost
// pattern of the HTTP tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QWENCLOUD_WS_DEFAULT_VOICE,
  QWENCLOUD_WS_MODEL,
  QWENCLOUD_WS_URL,
  QWENCLOUD_WS_VOICES,
  QWENCLOUD_VOICES,
  QwenCloudEngine,
  isPlanKey,
  type WsAuthRule,
} from "../src/audio/engine-qwencloud";
import type { Playback } from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

interface StubPlayback extends Playback {
  stopCalls: number;
  finish(): void;
}

interface StubHost {
  played: Array<{ bytes: Uint8Array; mime: string }>;
  playbacks: StubPlayback[];
  play(bytes: Uint8Array, mime: string): StubPlayback;
}

function makeHost(): StubHost {
  const played: StubHost["played"] = [];
  const playbacks: StubPlayback[] = [];
  return {
    played,
    playbacks,
    play(bytes: Uint8Array, mime: string): StubPlayback {
      played.push({ bytes, mime });
      let resolveDone!: () => void;
      const pb: StubPlayback = {
        stopCalls: 0,
        done: new Promise((r) => (resolveDone = r)),
        stop: () => {
          pb.stopCalls += 1;
          resolveDone();
        },
        finish: () => resolveDone(),
      };
      playbacks.push(pb);
      return pb;
    },
  };
}

/** Enough of the WebSocket surface for the engine: handlers + send/close. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readonly url: string;
  readyState = 0; // CONNECTING
  binaryType = "";
  sent: string[] = [];
  closedByEngine = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByEngine = true;
  }
  // --- test drivers ---
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverEvent(event: string, extra: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: JSON.stringify({ header: { event, ...extra } }) });
  }
  serverBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  serverError(): void {
    this.onerror?.();
  }
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const wsFactory = (url: string): WebSocket => new FakeWebSocket(url) as unknown as WebSocket;

function makeAuthRule(): { rule: WsAuthRule; calls: string[]; failInstall: (err: string) => void } {
  const calls: string[] = [];
  let installError: ((err: string) => void) | null = null;
  return {
    calls,
    failInstall: (err) => {
      installError = () => {
        throw new Error(err);
      };
    },
    rule: {
      install: async (key: string) => {
        if (installError) installError(`injected: ${key}`);
        else calls.push(`install:${key}`);
      },
      remove: async () => {
        calls.push("remove");
      },
    },
  };
}

const PLAN_KEY = "sk-sp-abcd1234s__c";
const CHUNK_A = new Uint8Array([0xff, 0xf3, 0x01]);
const CHUNK_B = new Uint8Array([0x0a, 0x0b]);

const speakOpts = { voiceName: null as string | null, rate: 1 };

function makeEngine(
  opts: { key: string | null; fetchImpl?: typeof fetch } = { key: PLAN_KEY },
): { engine: QwenCloudEngine; auth: ReturnType<typeof makeAuthRule>; host: StubHost } {
  const auth = makeAuthRule();
  const host = makeHost();
  const engine = new QwenCloudEngine({
    getKey: async () => opts.key,
    fetchImpl: opts.fetchImpl ?? (() => Promise.reject(new Error("unexpected fetch"))),
    audioHost: host,
    wsFactory,
    authRule: auth.rule,
  });
  return { engine, auth, host };
}

describe("QwenCloudEngine WS transport (plan keys)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("isPlanKey dispatches on key shape", () => {
    expect(isPlanKey("sk-sp-whatever")).toBe(true);
    expect(isPlanKey("sk-1234567890")).toBe(false);
  });

  it("happy path: install rule → open WS → run-task → task-started → continue+finish → binary frames → play → start → end → remove rule", async () => {
    const { engine, auth, host } = makeEngine();
    const events = collect(engine.speak("Hello there.", 7, speakOpts));
    await vi.advanceTimersByTimeAsync(0);

    // rule installed before the socket exists
    expect(auth.calls).toEqual([`install:${PLAN_KEY}`]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe(QWENCLOUD_WS_URL);
    expect(ws.binaryType).toBe("arraybuffer");

    ws.serverOpen();
    expect(JSON.parse(ws.sent[0])).toEqual({
      header: { action: "run-task", task_id: expect.any(String), streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: QWENCLOUD_WS_MODEL,
        parameters: {
          text_type: "PlainText",
          voice: QWENCLOUD_WS_DEFAULT_VOICE,
          format: "mp3",
          sample_rate: 22050,
          volume: 50,
          rate: 1,
          pitch: 1,
          enable_ssml: false,
        },
        input: {},
      },
    });

    ws.serverEvent("task-started");
    expect(JSON.parse(ws.sent[1])).toEqual({
      header: { action: "continue-task", task_id: JSON.parse(ws.sent[0]).header.task_id, streaming: "duplex" },
      payload: { input: { text: "Hello there." } },
    });
    expect(JSON.parse(ws.sent[2]).header.action).toBe("finish-task");

    ws.serverBinary(CHUNK_A);
    ws.serverBinary(CHUNK_B);
    ws.serverEvent("task-finished");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: new Uint8Array([...CHUNK_A, ...CHUNK_B]), mime: "audio/mpeg" }]);
    expect(ws.closedByEngine).toBe(true);
    expect(auth.calls[1]).toBe("remove");

    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("custom voiceName is forwarded in run-task parameters", async () => {
    const { engine } = makeEngine();
    const events = collect(engine.speak("X.", 1, { voiceName: "longanlufeng", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    expect(JSON.parse(ws.sent[0]).payload.parameters.voice).toBe("longanlufeng");
    ws.serverEvent("task-failed", { error_code: "InvalidParameter", error_message: "boom" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 1, message: "QwenCloud WS task failed: boom" }]);
  });

  it("task-failed surfaces error_message and tears down", async () => {
    const { engine, auth } = makeEngine();
    const events = collect(engine.speak("Hi.", 3, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverEvent("task-started");
    ws.serverEvent("task-failed", { error_code: "InvalidParameter", error_message: "[cosyvoice:]Engine error [411]" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "QwenCloud WS task failed: [cosyvoice:]Engine error [411]" },
    ]);
    expect(ws.closedByEngine).toBe(true);
    expect(auth.calls).toContain("remove");
  });

  it("task-failed without a message falls back to 'unknown error'", async () => {
    const { engine } = makeEngine();
    const events = collect(engine.speak("Hi.", 4, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0].serverOpen();
    FakeWebSocket.instances[0].serverEvent("task-started");
    FakeWebSocket.instances[0].serverEvent("task-failed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 4, message: "QwenCloud WS task failed: unknown error" }]);
  });

  it("handshake/socket error (401, CSP, missing grant) → error and rule removal", async () => {
    const { engine, auth } = makeEngine();
    const events = collect(engine.speak("Hi.", 5, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0].serverError();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 5, message: "QwenCloud WS connection failed (CSP connect-src, missing host permission, or rejected auth)" },
    ]);
    expect(auth.calls).toContain("remove");
  });

  it("server close before task-finished → error", async () => {
    const { engine } = makeEngine();
    const events = collect(engine.speak("Hi.", 6, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverEvent("task-started");
    ws.serverBinary(CHUNK_A);
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 6, message: "QwenCloud WS closed before task-finished" }]);
  });

  it("cancel mid-collection: socket closed, rule removed, no playback, stream cancelled", async () => {
    const { engine, auth, host } = makeEngine();
    const events = collect(engine.speak("Hi.", 8, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverEvent("task-started");
    ws.serverBinary(CHUNK_A);
    engine.cancel();
    expect(ws.closedByEngine).toBe(true);
    expect(auth.calls).toContain("remove");
    expect(host.played).toHaveLength(0);
    expect(await events).toEqual([{ type: "cancelled", speakId: 8 }]);
  });

  it("cancel during playback: stop + cancelled", async () => {
    const { engine, host } = makeEngine();
    const events = collect(engine.speak("Hi.", 9, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverEvent("task-started");
    ws.serverBinary(CHUNK_A);
    ws.serverEvent("task-finished");
    await vi.advanceTimersByTimeAsync(0);
    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 9 },
      { type: "cancelled", speakId: 9 },
    ]);
  });

  it("a new speak preempts a collecting WS speak: old socket closed, only the new chunk plays", async () => {
    const { engine, host } = makeEngine();
    const eventsA = collect(engine.speak("Alpha.", 1, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const wsA = FakeWebSocket.instances[0];
    wsA.serverOpen();
    wsA.serverEvent("task-started");
    wsA.serverBinary(CHUNK_A);

    const eventsB = collect(engine.speak("Beta.", 2, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    expect(wsA.closedByEngine).toBe(true);
    expect(await eventsA).toEqual([{ type: "cancelled", speakId: 1 }]);

    const wsB = FakeWebSocket.instances[1];
    expect(wsB).toBeDefined();
    wsB.serverOpen();
    wsB.serverEvent("task-started");
    wsB.serverBinary(CHUNK_B);
    wsB.serverEvent("task-finished");
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: CHUNK_B, mime: "audio/mpeg" }]);
    expect(await eventsB).toEqual([
      { type: "start", speakId: 2 },
      { type: "end", speakId: 2 },
    ]);
  });

  it("task-finished with zero audio bytes errors", async () => {
    const { engine } = makeEngine();
    const events = collect(engine.speak("Hi.", 10, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverEvent("task-started");
    ws.serverEvent("task-finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 10, message: "QwenCloud WS task finished with no audio" }]);
  });

  it("auth rule install failure → error, no socket", async () => {
    const { engine, auth, host } = makeEngine();
    auth.failInstall("DNR unavailable");
    const events = collect(engine.speak("Hi.", 11, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 11, message: "QwenCloud WS auth rule failed: Error: DNR unavailable" }]);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(host.played).toHaveLength(0);
  });

  it("no auth rule (non-extension context) → clear error, no socket", async () => {
    const engine = new QwenCloudEngine({
      getKey: async () => PLAN_KEY,
      audioHost: makeHost(),
      wsFactory,
      authRule: null,
    });
    const events = collect(engine.speak("Hi.", 12, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 12, message: "QwenCloud plan keys need the WebSocket auth rule (declarativeNetRequest unavailable in this context)" },
    ]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("plan keys never touch fetch; http keys never touch WebSocket", async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetchCalls.push(String(url));
      return {
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        json: async () => ({ message: "nope" }),
      } as unknown as Response;
    }) as typeof fetch;

    const plan = makeEngine({ key: PLAN_KEY });
    const eventsP = collect(plan.engine.speak("Hi.", 1, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].serverError();
    await vi.advanceTimersByTimeAsync(0);
    await eventsP;
    expect(fetchCalls).toHaveLength(0);

    FakeWebSocket.reset();
    const http = makeEngine({
      key: "sk-normal",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const eventsH = collect(http.engine.speak("Hi.", 2, speakOpts));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("maas.qwencloudapi.com");
    expect(await eventsH).toEqual([{ type: "error", speakId: 2, message: "nope" }]);
  });

  it("getVoices follows the dispatch: plan → 2 zh voices (longanlingxin default); http → curated 10", async () => {
    const plan = makeEngine({ key: PLAN_KEY }).engine;
    const planVoices = await plan.getVoices();
    expect(planVoices).toEqual(QWENCLOUD_WS_VOICES.map((name) => ({ name, lang: "zh-CN", localService: false, family: "qwencloud" })));
    expect(planVoices[0].name).toBe("longanlingxin");

    const http = makeEngine({ key: "sk-normal" }).engine;
    const httpVoices = await http.getVoices();
    expect(httpVoices).toHaveLength(QWENCLOUD_VOICES.length);
    expect(httpVoices[0].name).toBe("Cherry");
    expect(httpVoices.every((v) => v.lang === "en-US")).toBe(true);

    expect(await makeEngine({ key: null }).engine.getVoices()).toEqual([]);
  });
});
