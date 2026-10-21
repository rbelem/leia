// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  HEYGEN_DEFAULT_MODEL,
  HEYGEN_DEFAULT_VOICE,
  HEYGEN_TTS_URL,
  HEYGEN_VOICES_URL,
  HeyGenVoiceEngine,
  type Playback,
} from "../src/audio/engine-heygen";

const collect = async (it: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => data,
  } as unknown as Response;
}

function audioResponse(bytes: Uint8Array): Response {
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

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"

const VOICES_PAYLOAD = {
  data: [
    { voice_id: "v-active", name: "Nadine", language: "en", mode: "instant", status: "ACTIVE" },
    { voice_id: "v-pending", name: "Pending", language: "en", mode: "instant", status: "PENDING" },
    { voice_id: "v-failed", name: "Broken", language: "en", mode: "instant", status: "FAILED" },
    { voice_id: "v-no-status", name: "NoStatus", language: "fr", mode: "instant" },
  ],
  has_more: false,
};

describe("HeyGenVoiceEngine", () => {
  it("lists the ACTIVE public voices and skips the rest", async () => {
    const { fetchImpl, calls } = makeFetch([() => jsonResponse(VOICES_PAYLOAD)]);
    const engine = new HeyGenVoiceEngine({
      getKey: async () => "k",
      fetchImpl,
      audioHost: makeHost(),
    });

    const voices = await engine.getVoices();

    expect(calls[0].url).toBe(`${HEYGEN_VOICES_URL}?type=public&limit=100`);
    expect((calls[0].init?.headers as Record<string, string>)["X-Api-Key"]).toBe("k");
    expect(voices.map((v) => v.name)).toEqual(["v-active"]);
    expect(voices[0]).toMatchObject({ title: "Nadine", lang: "en", localService: false, family: "heygen" });
  });

  it("returns no voices without a key and asks for nothing", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const engine = new HeyGenVoiceEngine({
      getKey: async () => null,
      fetchImpl,
      audioHost: makeHost(),
    });

    expect(await engine.getVoices()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("synthesizes the requested voice, plays the audio and marks the spoken words", async () => {
    const host = makeHost();
    const { fetchImpl, calls } = makeFetch([
      () =>
        jsonResponse({
          data: {
            audio_url: "https://files.heygen.ai/audio/req_1.wav",
            duration: 1.5,
            original_words: [
              { text: "Hello", start_time: 0, end_time: 0.5 },
              { text: "world", start_time: 0.5, end_time: 1 },
            ],
          },
        }),
      () => audioResponse(WAV_BYTES),
    ]);
    const engine = new HeyGenVoiceEngine({
      getKey: async () => "k",
      fetchImpl,
      audioHost: host,
    });

    const stream = engine.speak("Hello world", 7, { voiceName: "v-active", rate: 1 });
    // The word events ride the audio's own timeline (0.5s apart), so the
    // playback has to outlive them before it ends the stream.
    await new Promise((r) => setTimeout(r, 700));
    host.playbacks[0]?.finish();
    const events = await collect(stream);

    expect(calls[0].url).toBe(HEYGEN_TTS_URL);
    const body = JSON.parse(String((calls[0].init as RequestInit).body));
    expect(body).toMatchObject({ text: "Hello world", voice_id: "v-active", model: HEYGEN_DEFAULT_MODEL });
    expect(body.with_timestamps).toBe(true);
    expect(calls[1].url).toBe("https://files.heygen.ai/audio/req_1.wav");
    expect(host.played[0].mime).toBe("audio/wav");
    expect(host.played[0].bytes).toEqual(WAV_BYTES);

    const types = events.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("end");
    const words = events.filter((e) => (e as { type: string }).type === "word") as Array<{
      begin: number;
      end: number;
    }>;
    expect(words).toEqual([
      { type: "word", speakId: 7, begin: 0, end: 5 },
      { type: "word", speakId: 7, begin: 6, end: 11 },
    ]);
  });

  it("falls back to the default voice when the picker sends none", async () => {
    const host = makeHost();
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ data: { audio_url: "https://files.heygen.ai/a.wav", duration: 0.2 } }),
      () => audioResponse(WAV_BYTES),
    ]);
    const engine = new HeyGenVoiceEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const stream = engine.speak("hi", 1, { voiceName: null, rate: 1 });
    await new Promise((r) => setTimeout(r, 5));
    host.playbacks[0]?.finish();
    await collect(stream);

    const body = JSON.parse(String((calls[0].init as RequestInit).body));
    expect(body.voice_id).toBe(HEYGEN_DEFAULT_VOICE);
  });

  it("reports the API's own error message and code", async () => {
    const host = makeHost();
    const { fetchImpl } = makeFetch([
      () =>
        jsonResponse(
          { error: { code: "rate_limit_exceeded", message: "Too many requests. Retry after 42 seconds." } },
          429,
        ),
    ]);
    const engine = new HeyGenVoiceEngine({ getKey: async () => "k", fetchImpl, audioHost: host });

    const stream = engine.speak("hi", 3, { voiceName: null, rate: 1 });
    const events = await collect(stream);

    const error = events.find((e) => (e as { type: string }).type === "error") as { message?: string };
    expect(error?.message).toContain("rate_limit_exceeded");
    expect(error?.message).toContain("Too many requests");
    expect(host.played).toHaveLength(0);
  });
});
