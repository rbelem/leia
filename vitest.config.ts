import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://example.test/" } },
    // tests/e2e runs under vitest.e2e.config.ts (`npm run test:e2e`) — keep
    // the unit suite jsdom-only and cua-free (council §4: cua has a single
    // choke point). Defaults spread first: overriding `exclude` replaces the
    // built-ins (node_modules etc.), it does not extend them.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});