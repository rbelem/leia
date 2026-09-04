// SPDX-License-Identifier: MPL-2.0
/**
 * leia:audio:clock single-responder routing in the SW (live-proven Chrome
 * dead clock, then a live-proven reply race): on Chrome the engine hub
 * lives in the offscreen document, which answers the content pages' 250ms
 * word-march poll itself with the march's envelope shape. The SW triage
 * stays SILENT on Chrome (sync false — no forward, no reply), because a
 * second SW reply raced the offscreen envelope and the poll kept whichever
 * arrived first. Firefox has no offscreen doc and keeps answering through
 * audioClockMs. Missing/wedged offscreen doc on Chrome → the poll simply
 * gets the offscreen non-answer (same as before: dead-reckon).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chrome: true,
  sent: [] as unknown[],
  responses: [] as unknown[],
  listeners: [] as Array<(msg: unknown, sender: unknown, sendResponse?: (r?: unknown) => void) => unknown>,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    tabs: { query: async () => [], sendMessage: async () => {} },
    scripting: { executeScript: async () => [] },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: {
      sendMessage: async (msg: unknown) => {
        state.sent.push(msg);
        return undefined;
      },
      onMessage: { addListener: (fn: (typeof state)["listeners"][number]) => state.listeners.push(fn) },
    },
    alarms: { onAlarm: { addListener: () => {} }, create: async () => {} },
    commands: { onCommand: { addListener: () => {} } },
  },
}));

vi.mock("../src/audio/owner", () => ({
  isChrome: () => state.chrome,
  audioClockMs: () => 777, // the Firefox path's own background-page hub
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

import "../src/background/index"; // registers the SW reply listener (module under test)

/** The reply listener background/index.ts registered at import. */
const swListener = state.listeners[0]!;

describe("background leia:audio:clock single-responder routing", () => {
  beforeEach(() => {
    state.chrome = true;
    state.sent = [];
    state.responses = [];
  });

  it("Chrome stays silent (sync false, nothing forwarded, no reply) — the offscreen doc owns the poll", async () => {
    let responded = false;
    const ret = swListener({ type: "leia:audio:clock" }, {}, () => {
      responded = true;
    });

    expect(ret).toBe(false); // sync triage: unhandled here
    await new Promise((r) => setTimeout(r, 20));
    expect(responded).toBe(false); // and no late reply either
    expect(state.sent).toEqual([]); // nothing forwarded anywhere
  });

  it("Firefox answers through audioClockMs — no forward", async () => {
    state.chrome = false;

    const reply = await new Promise((resolve) => {
      swListener({ type: "leia:audio:clock" }, {}, (r?: unknown) => resolve(r));
    });

    expect(state.sent).toEqual([]); // nothing leaves the background page
    expect(reply).toEqual({ ok: true, replyType: "leia:audio:clock", data: { clock: 777 } });
  });
});
