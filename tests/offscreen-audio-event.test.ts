// SPDX-License-Identifier: MPL-2.0
/**
 * Regression (live-proven Chrome stall): speakAndStream used to send engine
 * events as `{ type: "leia:audio:event", ...ev }` — the spread clobbered the
 * routing key with the engine event's own type ("start"|"end"|...), so the SW
 * dispatch on `msg.type === "leia:audio:event"` never matched, pushEvent was
 * never called, and the session drive loop hung after chunk 1. The wire shape
 * must carry BOTH: the routing type AND the engine event (nested under
 * `event`, whose own `type` drives the SW's terminal check).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MINIMAX_TTS_URL } from "../src/audio/engine-minimax";

type ReplyListener = (msg: unknown, sender: unknown, sendResponse?: (response?: unknown) => void) => unknown;

const state = vi.hoisted(() => ({
  listeners: [] as ReplyListener[],
  sent: [] as unknown[],
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: async (msg: unknown) => {
        state.sent.push(msg);
        return {};
      },
      onMessage: { addListener: (fn: ReplyListener) => state.listeners.push(fn) },
    },
  },
}));

// jsdom has no speechSynthesis — stub the utterance class the engine builds.
class FakeUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onboundary: ((ev: { charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;

const synth = {
  voices: [{ voiceURI: "v", name: "System Voice", lang: "en-US", localService: true, default: true }],
  utterances: [] as FakeUtterance[],
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices as unknown as SpeechSynthesisVoice[];
  },
  speak(u: SpeechSynthesisUtterance): void {
    this.utterances.push(u as unknown as FakeUtterance);
  },
  cancel(): void {},
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Wait until pred() holds or the budget runs out (bounded busy-flush). */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i += 1) await tick();
}

async function loadOffscreen(): Promise<void> {
  vi.resetModules(); // fresh hub per test
  state.listeners = [];
  state.sent = [];
  synth.utterances = [];
  await import("../src/offscreen/audio");
}

/** Deliver the speak request, play the utterance, return the wire messages. */
async function speakToEnd(speakId: number): Promise<unknown[]> {
  state.listeners[0]({ type: "leia:audio:speak", speakId, text: "Hello world.", voiceName: null, rate: 1 }, {});
  await until(() => synth.utterances.length === 1);
  const u = synth.utterances[0];
  u.onstart!(new Event("start"));
  u.onend!(new Event("end"));
  await until(() => state.sent.length === 3); // start + word + end
  return state.sent;
}

describe("offscreen audio event wire shape", () => {
  beforeEach(() => {
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no loopback servers in tests");
      }),
    );
  });

  it("sends each engine event with the routing type AND the engine event intact", async () => {
    await loadOffscreen();
    const sent = await speakToEnd(7);

    expect(sent).toEqual([
      { type: "leia:audio:event", event: { type: "start", speakId: 7 } },
      { type: "leia:audio:event", event: { type: "word", speakId: 7, begin: 0, end: 5 } },
      { type: "leia:audio:event", event: { type: "end", speakId: 7 } },
    ]);
  });

  it("every wire message dispatches as leia:audio:event (the clobber regression)", async () => {
    await loadOffscreen();
    const sent = await speakToEnd(8);

    // The SW routes on msg.type — a spread-clobbered type never matches.
    for (const msg of sent) {
      expect((msg as { type?: unknown }).type).toBe("leia:audio:event");
    }
    // The terminal "end" keeps its engine type — the SW's terminal check
    // reads event.type; a routing key leaking in there would close the
    // stream after the first event instead.
    expect((sent.at(-1) as { event: { type: string } }).event.type).toBe("end");
  });
});

// --- leia:audio:clock (Chrome live-proven dead clock) -------------------------
// The offscreen doc hosts the real engine hub and answers the content
// pages' 250ms word-march clock poll here with the march's envelope shape.
// SINGLE RESPONDER: the SW stays silent on Chrome, so this envelope is the
// only reply the poll can receive (a raw-number second reply raced it and
// the march kept whichever arrived first). The case must answer
// SYNCHRONOUSLY (the reply-listener helper triages sync) with the hub's
// currentClockMs: a real number while audio plays, null when idle.

interface FakeAudioInstance {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

let lastAudio: FakeAudioInstance | null = null;

class FakeAudio implements FakeAudioInstance {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  currentTime = 0;
  constructor(src: string) {
    this.src = src;
    lastAudio = this;
  }
  play(): Promise<void> {
    // "Playing" from the first read — no 50ms anchor-poll wall time needed.
    this.currentTime = 0.25;
    return Promise.resolve();
  }
  pause(): void {}
}

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as unknown as Response;
}

/** Read the clock the way the SW's forward does: through the reply listener. */
function clockReply(): Promise<unknown> {
  return new Promise((resolve) => {
    state.listeners[0]({ type: "leia:audio:clock" }, {}, (r?: unknown) => resolve(r));
  });
}

describe("offscreen leia:audio:clock", () => {
  beforeEach(() => {
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        if (url === MINIMAX_TTS_URL) {
          return jsonResponse({
            base_resp: { status_code: 0 },
            data: { audio: "ff00", subtitle_file: "https://sub.example/segments.json" },
          });
        }
        if (url === "https://sub.example/segments.json") {
          return jsonResponse([
            { timestamped_words: [{ word: "Hello", word_begin: 0, word_end: 5, time_begin: 0 }] },
          ]);
        }
        throw new Error(`unexpected fetch: ${url}`); // local-profile probes → offline → skipped
      }),
    );
    vi.stubGlobal("Audio", FakeAudio);
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:test-url");
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (URL as unknown as Record<string, unknown>).createObjectURL = undefined;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = undefined;
    lastAudio = null;
  });

  it("reads null while idle (current engine has no clock)", async () => {
    await loadOffscreen();
    await expect(clockReply()).resolves.toEqual({
      ok: true,
      replyType: "leia:audio:clock",
      data: { clock: null },
    });
  });

  it("returns a non-null, advancing number while a clocked engine plays", async () => {
    await loadOffscreen();

    // Select minimax AND arm its provider key in one audio message (the
    // offscreen doc reads keys from the SW's in-memory snapshot, keystore.ts).
    state.listeners[0](
      { type: "leia:audio:family", family: "minimax", keys: { "leia:settings:minimaxKey": "k" } },
      {},
    );
    state.listeners[0]({ type: "leia:audio:speak", speakId: 5, text: "Hello world.", voiceName: null, rate: 1 }, {});

    await until(() => lastAudio !== null); // audio element exists…
    await until(() => state.sent.some((m) => (m as { type?: string }).type === "leia:audio:event")); // …and start shipped

    await expect(clockReply()).resolves.toEqual({
      ok: true,
      replyType: "leia:audio:clock",
      data: { clock: 250 },
    }); // live media clock while playing

    lastAudio!.currentTime = 0.6;
    await expect(clockReply()).resolves.toEqual({
      ok: true,
      replyType: "leia:audio:clock",
      data: { clock: 600 },
    }); // advances with playback

    lastAudio!.onended!(); // natural end → active playback cleared
    await until(() => state.sent.length >= 3); // start + timeline + end
    await expect(clockReply()).resolves.toEqual({
      ok: true,
      replyType: "leia:audio:clock",
      data: { clock: null },
    }); // idle again
  });
});
