// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRADIUM_CAPABILITIES,
  GRADIUM_TTS_URL,
  GRADIUM_VOICES_URL,
  GradiumEngine,
  gradiumPaddingBonus,
} from "../src/audio/engine-gradium";
import type { Playback } from "../src/audio/engine-minimax";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

function wavResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "audio/wav" : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

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

function makeFetch(
  handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return h(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

describe("GradiumEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getVoices: /api/voices/ (x-api-key) → uid as name, name as title, language as BCP-47", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(`${GRADIUM_VOICES_URL}?include_catalog=true&limit=100`);
        expect(init?.headers).toMatchObject({ "x-api-key": "gd1" });
        return jsonResponse([
          { uid: "YTpq7expH9539ERJ", name: "Aria", language: "en", is_catalog: true },
          { uid: "LFZvm12tW_z0xfGo", name: "Lia", language: "pt-BR", is_catalog: true },
          { uid: "clone01", name: "My clone", language: "fr", is_catalog: false },
          { name: "no uid", language: "de" },
          { uid: "", name: "empty uid" },
        ]);
      },
    ]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    expect(await engine.getVoices()).toEqual([
      { name: "YTpq7expH9539ERJ", title: "Aria", lang: "en-US", localService: false, family: "gradium" },
      { name: "LFZvm12tW_z0xfGo", title: "Lia", lang: "pt-BR", localService: false, family: "gradium" },
      { name: "clone01", title: "My clone", lang: "fr-FR", localService: false, family: "gradium" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("getVoices caches per key within the TTL and refetches after a failure", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse([{ uid: "v1", name: "Aria", language: "en" }]),
    ]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    const first = await engine.getVoices();
    expect(await engine.getVoices()).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("getVoices: no key → [] with no fetch; a failure is not cached", async () => {
    const noKey = makeFetch([]);
    const e1 = new GradiumEngine({ getKey: async () => null, fetchImpl: noKey.fetchImpl, audioHost: makeHost() });
    expect(await e1.getVoices()).toEqual([]);
    expect(noKey.calls).toHaveLength(0);

    const failing = makeFetch([() => jsonResponse({ detail: "boom" }, 500)]);
    const e2 = new GradiumEngine({ getKey: async () => "gd1", fetchImpl: failing.fetchImpl, audioHost: makeHost() });
    expect(await e2.getVoices()).toEqual([]);
    expect(failing.calls).toHaveLength(1);
  });

  it("happy path: POST /post/speech/tts (x-api-key + json) → binary wav play → start → end", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url, init) => {
        expect(url).toBe(GRADIUM_TTS_URL);
        expect(init?.headers).toMatchObject({
          "x-api-key": "gd1",
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          text: "Hello world.",
          voice_id: "YTpq7expH9539ERJ",
          output_format: "wav",
          only_audio: true,
        });
        return wavResponse(WAV_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hello world.", 7, { voiceName: "YTpq7expH9539ERJ", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.played).toEqual([{ bytes: WAV_BYTES, mime: "audio/wav" }]);
    expect(calls).toHaveLength(1);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(await events).toEqual([
      { type: "start", speakId: 7 },
      { type: "end", speakId: 7 },
    ]);
  });

  it("rate rides json_config.padding_bonus; rate 1 omits it", async () => {
    const seen: unknown[] = [];
    const { fetchImpl } = makeFetch([
      (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).json_config);
        return wavResponse(WAV_BYTES);
      },
      (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).json_config);
        return wavResponse(WAV_BYTES);
      },
      (_url, init) => {
        seen.push(JSON.parse(String(init?.body)).json_config);
        return wavResponse(WAV_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: host });

    for (const [text, rate] of [["Fast.", 2], ["Slow.", 0.5], ["Plain.", 1]] as const) {
      const events = collect(engine.speak(text, 1, { voiceName: "v1", rate }));
      await vi.advanceTimersByTimeAsync(0);
      host.playbacks[host.playbacks.length - 1].finish();
      await vi.advanceTimersByTimeAsync(0);
      await events;
    }

    expect(seen).toEqual([{ padding_bonus: -2 }, { padding_bonus: 2 }, undefined]);
  });

  it("padding bonus maps the contract rate onto Gradium's band", () => {
    expect(gradiumPaddingBonus(1)).toBe(0);
    expect(gradiumPaddingBonus(2)).toBe(-2);
    expect(gradiumPaddingBonus(0.5)).toBe(2);
    expect(gradiumPaddingBonus(9)).toBe(-2); // clamped
    expect(gradiumPaddingBonus(0)).toBe(2); // clamped
  });

  it("no voice picked and no voice list yet → error instead of a request", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 3, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 3, message: "Gradium: no voice available — pick a voice in the popup" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("no voice picked but the voice list is known → the first voice is used", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse([{ uid: "v1", name: "Aria", language: "en" }]),
      (_url, init) => {
        expect(JSON.parse(String(init?.body)).voice_id).toBe("v1");
        return wavResponse(WAV_BYTES);
      },
    ]);
    const host = makeHost();
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: host });
    await engine.getVoices();

    const events = collect(engine.speak("Hi.", 4, { voiceName: null, rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    host.playbacks[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "start", speakId: 4 },
      { type: "end", speakId: 4 },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("missing key: immediate error, no fetch", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new GradiumEngine({ getKey: async () => null, fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 2, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 2, message: "Gradium API key not set — providers settings" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("a plain-text error body surfaces as the error message", async () => {
    const resp: Response = {
      ok: false,
      status: 500,
      headers: { get: () => "text/plain" },
      text: async () => "error from server 402: out of credits",
    } as unknown as Response;
    const { fetchImpl } = makeFetch([() => resp]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 5, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 5, message: "error from server 402: out of credits" },
    ]);
  });

  it("a JSON error body surfaces as the error message", async () => {
    const { fetchImpl } = makeFetch([() => jsonResponse({ detail: "voice not found" }, 400)]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 6, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([{ type: "error", speakId: 6, message: "voice not found" }]);
  });

  it("request failure → error event", async () => {
    const { fetchImpl } = makeFetch([() => Promise.reject(new Error("net down"))]);
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: makeHost() });

    const events = collect(engine.speak("Hi.", 8, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await events).toEqual([
      { type: "error", speakId: 8, message: "Gradium request failed: Error: net down" },
    ]);
  });

  it("cancel stops audio and closes with cancelled", async () => {
    const { fetchImpl } = makeFetch([() => wavResponse(WAV_BYTES)]);
    const host = makeHost();
    const engine = new GradiumEngine({ getKey: async () => "gd1", fetchImpl, audioHost: host });

    const events = collect(engine.speak("Hi.", 9, { voiceName: "v1", rate: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    engine.cancel();
    expect(host.playbacks[0].stopCalls).toBe(1);
    expect(await events).toEqual([
      { type: "start", speakId: 9 },
      { type: "cancelled", speakId: 9 },
    ]);
  });

  it("capabilities: no word timing (REST has no timestamps), provider privacy, paid", () => {
    expect(GRADIUM_CAPABILITIES).toEqual({
      wordTiming: false,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
      maxUtteranceChars: 2000,
    });
  });
});
