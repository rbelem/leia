import { defineConfig } from "vitest/config";

/**
 * Native permission-grant e2e (tests/e2e, issue #22). Separate project from
 * the jsdom unit suite: node env (spawns a real browser + cua-driver CLI) and
 * `fileParallelism: false` — cua is a desktop-global mutex (council §5),
 * enforced structurally rather than by convention. Armed by LEIA_E2E=1
 * (docs/cua-e2e.md carries the CI contract).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.mjs"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
