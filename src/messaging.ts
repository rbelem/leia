// SPDX-License-Identifier: MPL-2.0
/**
 * Respond-only-if-handled runtime.onMessage wiring.
 *
 * WHY (live-proven in Chrome): an `async` listener ALWAYS claims the reply
 * channel — Chrome keeps the port open for the returned Promise, and
 * webextension-polyfill@0.12.0 forwards even a resolved `undefined` — so every
 * context that registered an async listener answered every runtime message,
 * racing the real handler and hijacking replies with null/undefined. But a
 * synchronously returned plain value is ALSO dropped by the polyfill: only
 * sendResponse, `return true`, or a returned Promise ever deliver.
 *
 * Contract: the handler triages SYNCHRONOUSLY.
 *  - Return `undefined` for messages it does not handle → the wrapper returns
 *    `false` immediately: no reply is sent and other contexts may answer.
 *  - Return a value (or a Promise of one) for messages it handles → the
 *    wrapper returns `true` and delivers via sendResponse once resolved; a
 *    Promise resolving `undefined` sends nothing (streaming/fire-and-forget).
 *
 * Handler payload shape is intentionally `unknown`: router contexts reply
 * with RouterReply, while the audio hub and probes reply with their own
 * payloads (voice lists, probe stages).
 */
import browser from "webextension-polyfill";

export function addReplyListener(handler: (msg: unknown) => unknown): void {
  browser.runtime.onMessage.addListener(
    (msg: unknown, _sender: unknown, sendResponse?: (response?: unknown) => void): boolean => {
      const reply = handler(msg);
      if (reply === undefined) return false; // unhandled: no reply — don't race the context that owns it
      Promise.resolve(reply).then((value) => {
        if (value !== undefined) sendResponse?.(value);
      });
      return true; // handled: hold the channel open for the async delivery
    },
  );
}
