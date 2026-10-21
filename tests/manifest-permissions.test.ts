// SPDX-License-Identifier: MPL-2.0
/**
 * Manifest ↔ provider-catalog agreement.
 *
 * The extension fetches a provider's API (and, for HeyGen, the audio file
 * its response points at) from the origins in `PROVIDERS[].originPatterns`.
 * A runtime grant of those origins only works if the manifest declares them
 * under `optional_host_permissions` — otherwise Chrome rejects the grant and
 * the engine fetch is CORS-walled ("Failed to fetch") even with a saved key.
 *
 * The build guard (scripts/build.mjs) checks the other direction
 * (optional_host_permissions → connect-src); this test covers the one that
 * was missing, and did ship broken once (HeyGen, commit 0d70431).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/settings/providers";

interface Manifest {
  optional_host_permissions?: string[];
}

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "src", "manifest.json"), "utf8"),
) as Manifest;

describe("provider host permissions", () => {
  it("every origin a provider engine fetches is declared in optional_host_permissions", () => {
    const declared = new Set(manifest.optional_host_permissions ?? []);
    for (const provider of PROVIDERS) {
      for (const origin of provider.originPatterns ?? []) {
        expect(declared.has(origin), `${provider.id} fetches ${origin}`).toBe(true);
      }
    }
  });
});
