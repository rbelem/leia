// SPDX-License-Identifier: MPL-2.0
/**
 * Background key-snapshot enrichment: every leia:audio:* message forwarded
 * toward the offscreen doc carries a fresh storage.local snapshot (provider
 * keys from the catalog incl. azureRegion + custom local profiles). Storage
 * failure sends without a snapshot; non-audio messages pass through
 * untouched. owner.ts (and the Firefox path) stay untouched — the wrap sits
 * on the SW's runtime.sendMessage forward path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storageGet: (async () => ({})) as (keys?: unknown) => Promise<Record<string, unknown>>,
  sent: [] as Array<{ msg: unknown; rest: unknown[] }>,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: { query: async () => [], sendMessage: async () => {} },
    scripting: { executeScript: async () => [] },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: {
        get: (...args: unknown[]) => state.storageGet(...args),
        set: async () => {},
        remove: async () => {},
      },
    },
    runtime: {
      // The ORIGINAL sendMessage — background/index.ts wraps this on import.
      sendMessage: async (msg: unknown, ...rest: unknown[]) => {
        state.sent.push({ msg, rest });
        return {};
      },
      onMessage: { addListener: () => {} },
    },
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
    getVoices: async () => [],
    speak(): AsyncIterable<never> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {});
        },
      };
    },
    cancel: () => {},
  }),
}));

import browser from "webextension-polyfill";
import { LOCAL_PROFILES_STORAGE_KEY } from "../src/audio/local-profiles";
import { PROVIDERS } from "../src/settings/providers";
import "../src/background/index"; // installs the enriching sendMessage wrap (module under test)

describe("background leia:audio:* key-snapshot enrichment", () => {
  beforeEach(() => {
    state.sent = [];
    state.storageGet = async () => ({});
  });

  it("enriches forwarded audio messages with catalog keys (incl. azureRegion) and local profiles", async () => {
    const keys: Record<string, string> = {};
    for (const p of PROVIDERS) {
      keys[p.keyStorage] = `key-${p.id}`;
      if (p.regionStorage) keys[p.regionStorage] = "eastus";
    }
    const profiles = [{ id: "kokoro2", name: "Kokoro2", baseUrl: "http://127.0.0.1:9001" }];
    state.storageGet = async () => ({ ...keys, [LOCAL_PROFILES_STORAGE_KEY]: profiles });

    // background/index.ts replaced runtime.sendMessage with the enriching wrap.
    await browser.runtime.sendMessage({ type: "leia:audio:voices" });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].msg).toMatchObject({ type: "leia:audio:voices", keys, localProfiles: profiles });
  });

  it("sends WITHOUT a snapshot when the storage read fails (audio call not blocked)", async () => {
    state.storageGet = async () => {
      throw new Error("storage unavailable");
    };
    await browser.runtime.sendMessage({ type: "leia:audio:speak", speakId: 1, text: "hi", voiceName: null, rate: 1 });
    expect(state.sent).toHaveLength(1);
    const msg = state.sent[0].msg as Record<string, unknown>;
    expect(msg.type).toBe("leia:audio:speak");
    expect("keys" in msg).toBe(false);
    expect("localProfiles" in msg).toBe(false);
  });

  it("leaves non-audio messages untouched", async () => {
    await browser.runtime.sendMessage({ type: "leia:session:state", status: "playing" });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].msg).toEqual({ type: "leia:session:state", status: "playing" });
  });
});
