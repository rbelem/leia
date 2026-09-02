// SPDX-License-Identifier: MPL-2.0
/**
 * handleReaderStart (background) — the start reply must not voice-gate.
 * It used to `await s.voiceLang()` after s.start() (whose chunk-cap resolve
 * had ALREADY waited on the same voices poll), so on voiceless systems the
 * reply landed seconds after the highlight broadcasts and the bar bound its
 * highlighter only after every highlight had fired (pre-bind highlights are
 * no-ops). The reply now carries locale: null and no extra voices read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, VoiceInfo } from "../src/reader/contract";

const state = vi.hoisted(() => ({
  voices: [] as VoiceInfo[],
  voicesDelayMs: 0,
  getVoicesCalls: 0,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: {
      query: async () => [{ url: "https://example.test/article" }],
      sendMessage: async () => ({}),
    },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: { sendMessage: async () => ({}), onMessage: { addListener: () => {} } },
    alarms: { onAlarm: { addListener: () => {} }, create: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
  },
}));

vi.mock("../src/audio/owner", () => ({
  isChrome: () => false,
  audioClockMs: () => null,
  chromeAudioEngine: () => null,
  resolveAudioEngine: () => ({
    family: "web-speech",
    capabilities: { wordTiming: false, streaming: false, costClass: "free", privacyClass: "local" },
    getVoices: async () => {
      state.getVoicesCalls += 1;
      await new Promise((r) => setTimeout(r, state.voicesDelayMs));
      return state.voices;
    },
    // Never-ending stream: the drive loop just suspends, like the open
    // EventStream double in session-chunk-cap.test.ts.
    speak(): AsyncIterable<EngineEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {});
        },
      };
    },
    cancel: () => {},
  }),
}));

import { handleReaderStart } from "../src/background/index";

const TOKENS = ["First sentence.", "Second sentence."].map((text) => ({ text }));

describe("handleReaderStart (start reply must not voice-gate)", () => {
  beforeEach(() => {
    state.voices = [];
    state.voicesDelayMs = 0;
    state.getVoicesCalls = 0;
  });

  it("replies immediately with locale null on a voiceless engine", async () => {
    state.voices = [];
    const reply = await handleReaderStart({ tokens: TOKENS });
    expect(reply.ok).toBe(true);
    expect(reply.replyType).toBe("leia:reader:start");
    const data = reply.data as {
      sessionId: string | null;
      state: string;
      locale: string | null;
      tokenCount: number;
      settings: { voiceName: string | null; rate: number; engine: string | null };
    };
    expect(data.locale).toBeNull(); // no voiceLang() in the reply path
    expect(data.state).toBe("playing");
    expect(data.sessionId).toBeTruthy();
    expect(data.tokenCount).toBe(2);
    expect(data.settings).toEqual({ voiceName: null, rate: 1, engine: null });
    // Exactly ONE voices read (the session's chunk-cap resolve) — the old
    // handler burned a second full poll before replying.
    expect(state.getVoicesCalls).toBe(1);
  });

  it("still replies with locale null when voices exist (locale never rides the reply)", async () => {
    state.voices = [{ name: "Zira", lang: "en-US", localService: true, family: "web-speech" }];
    const reply = await handleReaderStart({ tokens: TOKENS });
    expect(reply.ok).toBe(true);
    expect((reply.data as { locale: string | null }).locale).toBeNull();
    expect(state.getVoicesCalls).toBe(1);
  });
});
