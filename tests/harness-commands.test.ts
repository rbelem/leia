// SPDX-License-Identifier: MPL-2.0
// Harness prefs mapping: a phantom `engine: undefined` key must not reach the
// session — there it suppresses the voice→family pin (see session.test.ts).
import { describe, expect, it } from "vitest";
import { commandToMessage } from "../src/harness/commands";

describe("harness commandToMessage: prefs", () => {
  it("omits the engine key when no engine arg is given", () => {
    const msg = commandToMessage("prefs", { voiceName: "af_heart", rate: 1 }) as Record<string, unknown>;
    expect(msg).toEqual({ type: "leia:reader:prefs", voiceName: "af_heart", rate: 1 });
    expect("engine" in msg).toBe(false);
  });

  it("omits voice/rate keys that were not given too (no phantom keys at all)", () => {
    const msg = commandToMessage("prefs", { engine: "minimax" }) as Record<string, unknown>;
    expect(msg).toEqual({ type: "leia:reader:prefs", engine: "minimax" });
    expect("voiceName" in msg).toBe(false);
    expect("rate" in msg).toBe(false);
  });

  it("passes an explicit engine value through, including null (engine default)", () => {
    expect(commandToMessage("prefs", { engine: "minimax" })).toEqual({
      type: "leia:reader:prefs",
      engine: "minimax",
    });
    expect(commandToMessage("prefs", { engine: null })).toEqual({
      type: "leia:reader:prefs",
      engine: null,
    });
  });

  it("unknown command names still map to null", () => {
    expect(commandToMessage("nope", {})).toBeNull();
  });
});
