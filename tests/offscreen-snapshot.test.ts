// SPDX-License-Identifier: MPL-2.0
/**
 * Offscreen audio doc without chrome.storage (flatpak Chrome 152 bug): the
 * SW rides a key snapshot on every leia:audio:* message. With a snapshot
 * carrying the minimax key, getVoices includes minimax voices; without one
 * (storage unavailable) minimax contributes [] while web-speech still works.
 *
 * The listener is the respond-only-if-handled wrapper (src/messaging.ts):
 * it returns `true` for handled messages and delivers the reply through
 * sendResponse once resolved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInfo } from "../src/reader/contract";

type ReplyListener = (msg: unknown, sender: unknown, sendResponse?: (response?: unknown) => void) => unknown;

const state = vi.hoisted(() => ({
  listeners: [] as ReplyListener[],
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: (fn: ReplyListener) => state.listeners.push(fn) },
    },
  },
}));

const MINIMAX_KEY = "leia:settings:minimaxKey";

/** Load the offscreen doc, then deliver one message and return its reply. */
async function reply(msg: unknown): Promise<unknown> {
  const listener = state.listeners[0];
  const sendResponse = vi.fn();
  expect(listener(msg, {}, sendResponse)).toBe(true); // handled: channel held open
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); // flush delivery
  return sendResponse.mock.calls[0][0];
}

async function loadOffscreen(): Promise<void> {
  vi.resetModules(); // fresh hub + keystore per test
  state.listeners = [];
  await import("../src/offscreen/audio");
}

describe("offscreen audio snapshot-apply (no chrome.storage)", () => {
  beforeEach(() => {
    // speechSynthesis is absent in jsdom; fetch would hit real loopback ports.
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [{ voiceURI: "v", name: "System Voice", lang: "en-US", localService: true, default: true }],
      speak: () => {},
      cancel: () => {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no loopback servers in tests");
      }),
    );
  });

  it("returns minimax voices after a message applies a snapshot with its key", async () => {
    await loadOffscreen();
    const withKey = (await reply({ type: "leia:audio:voices", keys: { [MINIMAX_KEY]: "mm-secret" } })) as VoiceInfo[];
    expect(withKey.some((v) => v.family === "minimax")).toBe(true);
    // Next message carries no snapshot — the last one must stay applied.
    const again = (await reply({ type: "leia:audio:voices" })) as VoiceInfo[];
    expect(again.some((v) => v.family === "minimax")).toBe(true);
  });

  it("yields no provider voices without a snapshot, but web-speech still answers", async () => {
    await loadOffscreen();
    const voices = (await reply({ type: "leia:audio:voices" })) as VoiceInfo[];
    expect(voices.some((v) => v.family === "minimax")).toBe(false);
    expect(voices.some((v) => v.family === "web-speech")).toBe(true);
  });
});
