// SPDX-License-Identifier: MPL-2.0
/**
 * Pure message router shared by every extension context.
 * Each wired context augments it with its own cases (see background/index.ts,
 * content/index.ts, floating-bar/index.ts); unknown messages get no reply.
 * Kept dependency-free so the test harness can run it headlessly.
 */
export interface RouterMessage {
  type: string;
  [key: string]: unknown;
}

/** Narrower for raw extension-API messages (typed `unknown`). */
export function isRouterMessage(msg: unknown): msg is RouterMessage {
  return typeof msg === "object" && msg !== null && "type" in msg;
}

export interface RouterReply {
  ok: boolean;
  replyType: string;
  data?: unknown;
  error?: string;
}

export interface PongData {
  router: "leia-router-v1";
  at: number;
}

export function routeMessage(msg: RouterMessage): RouterReply | null {
  switch (msg.type) {
    case "ping":
      return { ok: true, replyType: "pong", data: { router: "leia-router-v1", at: Date.now() } satisfies PongData };
    case "echo":
      return { ok: true, replyType: "echo", data: msg.data };
    default:
      return null;
  }
}