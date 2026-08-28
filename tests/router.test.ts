// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/background/router";

describe("message router", () => {
  it("answers ping with pong", () => {
    const reply = routeMessage({ type: "ping" });
    expect(reply).not.toBeNull();
    expect(reply!.ok).toBe(true);
    expect(reply!.replyType).toBe("pong");
    expect(reply!.data).toMatchObject({ router: "leia-router-v1" });
  });

  it("echoes data back", () => {
    const reply = routeMessage({ type: "echo", data: { n: 42 } });
    expect(reply).not.toBeNull();
    expect(reply!.ok).toBe(true);
    expect(reply!.replyType).toBe("echo");
    expect(reply!.data).toEqual({ n: 42 });
  });

  it("returns null for unknown messages (no reply sent)", () => {
    expect(routeMessage({ type: "nope" })).toBeNull();
  });
});