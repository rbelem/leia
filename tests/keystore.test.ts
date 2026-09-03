// SPDX-License-Identifier: MPL-2.0
/**
 * audio/keystore — the offscreen doc's in-memory provider-key snapshot.
 * setSnapshot applies (sanitized) keys/profiles; readProviderKey mirrors the
 * old storage.local getter signature; missing keys are null, not errors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("audio/keystore (offscreen in-memory key snapshot)", () => {
  let keystore: typeof import("../src/audio/keystore");

  beforeEach(async () => {
    vi.resetModules(); // fresh snapshot state per test
    keystore = await import("../src/audio/keystore");
  });

  it("serves applied keys, returns null for missing ones, drops empty/non-string values", async () => {
    keystore.setSnapshot({
      keys: {
        "leia:settings:minimaxKey": "mm-secret",
        "leia:settings:openaiKey": "",
        "leia:settings:azureRegion": 42 as unknown as string,
      },
    });
    await expect(keystore.readProviderKey("leia:settings:minimaxKey")()).resolves.toBe("mm-secret");
    await expect(keystore.readProviderKey("leia:settings:openaiKey")()).resolves.toBeNull();
    await expect(keystore.readProviderKey("leia:settings:azureRegion")()).resolves.toBeNull();
    await expect(keystore.readProviderKey("leia:settings:neverSet")()).resolves.toBeNull();
  });

  it("keeps the last snapshot when nothing new arrives, replaces on a fresh one, sanitizes profiles", async () => {
    keystore.setSnapshot({
      keys: { "leia:settings:minimaxKey": "mm" },
      localProfiles: [
        { id: "kokoro2", name: "Kokoro2", baseUrl: "http://127.0.0.1:9001" },
        { id: "", name: "bad" }, // shape violation → dropped
        null, // junk → dropped
      ] as unknown as Array<{ id: string; name: string; baseUrl: string }>,
    });
    expect(keystore.snapshotLocalProfiles()).toEqual([{ id: "kokoro2", name: "Kokoro2", baseUrl: "http://127.0.0.1:9001" }]);
    keystore.setSnapshot(undefined); // not a snapshot → ignored, prior kept
    await expect(keystore.readProviderKey("leia:settings:minimaxKey")()).resolves.toBe("mm");
    keystore.setSnapshot({ keys: {} }); // fresh empty snapshot replaces the old keys
    await expect(keystore.readProviderKey("leia:settings:minimaxKey")()).resolves.toBeNull();
  });
});
