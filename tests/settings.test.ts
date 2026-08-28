// SPDX-License-Identifier: MPL-2.0
/**
 * T14 settings tests: theme persistence round-trip, content-script theme
 * init from storage, provider-key masking/row states, and capability
 * disclosure rendering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory browser.storage.local shared by the polyfill mock.
const storageData = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: (key: string | string[]) => {
          if (Array.isArray(key)) {
            return Promise.resolve(Object.fromEntries(key.map((k) => [k, storageData.data[k]])));
          }
          return Promise.resolve({ [key]: storageData.data[key] });
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(storageData.data, items);
          return Promise.resolve();
        },
      },
    },
  },
}));

import {
  PROVIDERS,
  THEME_STORAGE_KEY,
  buildProviderRow,
  capabilityChips,
  loadStoredTheme,
  maskKey,
  renderCapabilities,
  saveStoredTheme,
} from "../src/popup/popup";
import type { EngineCapabilities } from "../src/reader/contract";
import { AZURE_DEFAULT_REGION, AZURE_REGIONS } from "../src/audio/engine-azure";
import { ACTIVE_THEME } from "../src/content/themes";

const fakeStorage = {
  get: (key: string) => Promise.resolve({ [key]: storageData.data[key] }),
  set: (items: Record<string, unknown>) => {
    Object.assign(storageData.data, items);
    return Promise.resolve();
  },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of Object.keys(storageData.data)) delete storageData.data[k];
});

describe("capability disclosure", () => {
  it("describes web speech as free, local, estimated timing", () => {
    const caps: EngineCapabilities = {
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    };
    expect(capabilityChips(caps)).toEqual(["free", "local", "estimated word timing"]);
  });

  it("describes a paid provider with word timing and streaming", () => {
    const caps: EngineCapabilities = {
      wordTiming: true,
      streaming: true,
      costClass: "paid",
      privacyClass: "provider",
    };
    expect(capabilityChips(caps)).toEqual(["paid", "provider", "word timing", "streaming"]);
  });

  it("renders chips into a container", () => {
    const el = document.createElement("div");
    renderCapabilities(el, {
      wordTiming: false,
      streaming: false,
      costClass: "free",
      privacyClass: "local",
    });
    const chips = [...el.querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(["free", "local", "estimated word timing"]);
  });

  it("renders nothing and clears stale chips when caps are unknown", () => {
    const el = document.createElement("div");
    renderCapabilities(el, {
      wordTiming: true,
      streaming: false,
      costClass: "paid",
      privacyClass: "provider",
    });
    renderCapabilities(el, null);
    expect(el.querySelectorAll(".chip")).toHaveLength(0);
  });
});

describe("provider keys", () => {
  it("masks all but the last 4 chars", () => {
    expect(maskKey("sk-abcdef123456")).toBe("••••3456");
    expect(maskKey("abc")).toBe("••••");
  });

  it("catalog covers the four BYO-key providers with their storage keys", () => {
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
    expect(byId.minimax.keyStorage).toBe("leia:settings:minimaxKey");
    expect(byId.elevenlabs.keyStorage).toBe("leia:settings:elevenlabsKey");
    expect(byId.openai.keyStorage).toBe("leia:settings:openaiKey");
    expect(byId.azure.keyStorage).toBe("leia:settings:azureKey");
    expect(byId.azure.regionStorage).toBe("leia:settings:azureRegion");
  });

  it("renders the no-key state", () => {
    const row = buildProviderRow(PROVIDERS[0], null);
    expect(row.querySelector(".provider-state")!.textContent).toBe("no key");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(false);
    const input = row.querySelector<HTMLInputElement>(".key-input")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
  });

  it("renders the saved state masked, key hidden behind a reveal toggle", () => {
    const row = buildProviderRow(PROVIDERS[0], "sk-abcdef123456");
    expect(row.querySelector(".provider-state")!.textContent).toBe("saved ••••3456");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(true);
    const input = row.querySelector<HTMLInputElement>(".key-input")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("sk-abcdef123456");
    row.querySelector<HTMLButtonElement>(".reveal")!.click();
    expect(input.type).toBe("text");
  });

  it("renders a region field only for azure, prefilled when stored", () => {
    const azure = PROVIDERS.find((p) => p.id === "azure")!;
    expect(buildProviderRow(azure, "k", "eastus").querySelector<HTMLInputElement>(".region")!.value).toBe("eastus");
    expect(buildProviderRow(PROVIDERS[0], "k").querySelector(".region")).toBeNull();
  });

  it("azure region renders as a dropdown: curated list, default labeled + preselected, saved region honored", () => {
    const azure = PROVIDERS.find((p) => p.id === "azure")!;
    // No stored region → default preselected.
    const row = buildProviderRow(azure, "k");
    const select = row.querySelector<HTMLSelectElement>("select.region")!;
    expect(select.tagName).toBe("SELECT");
    expect([...select.options].map((o) => o.value)).toEqual([...AZURE_REGIONS]);
    expect(select.value).toBe(AZURE_DEFAULT_REGION);
    const defaultOpt = [...select.options].find((o) => o.value === AZURE_DEFAULT_REGION)!;
    expect(defaultOpt.textContent).toBe(`${AZURE_DEFAULT_REGION} (default)`);
    // Stored region preselects it.
    const restored = buildProviderRow(azure, "k", "japaneast").querySelector<HTMLSelectElement>("select.region")!;
    expect(restored.value).toBe("japaneast");
    // No dropdown for providers without regionOptions (none today besides azure).
    for (const def of PROVIDERS.filter((p) => p !== azure)) {
      if (!def.regionStorage) continue;
      expect(buildProviderRow(def, "k").querySelector(".region")!.tagName).not.toBe("SELECT");
    }
  });
});

describe("theme persistence", () => {
  it("round-trips a theme through storage", async () => {
    await saveStoredTheme(fakeStorage, "ocean");
    expect(storageData.data[THEME_STORAGE_KEY]).toBe("ocean");
    await expect(loadStoredTheme(fakeStorage)).resolves.toBe("ocean");
  });

  it("falls back to the active theme when unset or invalid", async () => {
    await expect(loadStoredTheme(fakeStorage)).resolves.toBe(ACTIVE_THEME);
    storageData.data[THEME_STORAGE_KEY] = "not-a-theme";
    await expect(loadStoredTheme(fakeStorage)).resolves.toBe(ACTIVE_THEME);
  });
});

describe("content-script theme init", () => {
  it("applies the stored theme on load (no CSS.highlights in jsdom)", async () => {
    vi.resetModules();
    storageData.data[THEME_STORAGE_KEY] = "berry";
    const { getTheme } = await import("../src/content/highlight");
    expect(getTheme()).toBe(ACTIVE_THEME);
    await import("../src/content/index");
    await tick();
    expect(getTheme()).toBe("berry");
  });

  it("keeps the default theme when nothing is stored", async () => {
    vi.resetModules();
    const { getTheme } = await import("../src/content/highlight");
    await import("../src/content/index");
    await tick();
    expect(getTheme()).toBe(ACTIVE_THEME);
  });
});
