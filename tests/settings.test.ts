// SPDX-License-Identifier: MPL-2.0
/**
 * Settings tests: theme persistence round-trip, content-script theme init
 * from storage, provider-key masking/row states, local-server row/preset/
 * summary builders (options page + popup footer), and capability disclosure
 * rendering.
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
  THEME_STORAGE_KEY,
  capabilityChips,
  familyLabel,
  loadStoredTheme,
  renderCapabilities,
  saveStoredTheme,
} from "../src/popup/popup";
import { PROVIDERS, buildProviderRow, keylessProviderHint, keylessProviderLabel, maskKey } from "../src/settings/providers";
import {
  applyPreset,
  baseUrlProblem,
  buildServerRow,
  localFamilyLabel,
  localProfileName,
  serverStatusText,
  setServerProbe,
  summarizeVoiceSources,
} from "../src/settings/local";
import { BUILT_IN_PROFILES, DEGRADED_CAPS } from "../src/audio/local-profiles";
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

  it("catalog covers the BYO-key providers with their storage keys", () => {
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
    const reveal = row.querySelector<HTMLButtonElement>(".reveal")!;
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    reveal.click();
    expect(input.type).toBe("text");
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
  });

  it("keyless picker label branches on key presence — no voices ≠ no key", () => {
    const mistral = PROVIDERS.find((p) => p.id === "mistral")!;
    expect(keylessProviderLabel(mistral, false)).toBe("Mistral — no key");
    expect(keylessProviderLabel(mistral, true)).toBe("Mistral — key saved, no voices loaded");
    expect(keylessProviderHint(false)).toContain("add an API key");
    expect(keylessProviderHint(true)).toContain("check the key");
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

describe("local server rows", () => {
  const kokoro = BUILT_IN_PROFILES.find((p) => p.id === "kokoro")!;

  it("status text: checking before the probe answers, then online/offline", () => {
    expect(serverStatusText(null)).toBe("checking…");
    expect(serverStatusText({ online: true, caps: DEGRADED_CAPS })).toBe("online");
    expect(serverStatusText({ online: false, caps: DEGRADED_CAPS })).toBe("offline");
  });

  it("built-in row shows address and the install hint verbatim, not removable", () => {
    const row = buildServerRow(kokoro, null);
    expect(row.querySelector(".provider-name")!.textContent).toBe("Kokoro");
    expect(row.querySelector(".provider-state")!.textContent).toBe("checking…");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(false);
    expect(row.querySelector(".provider-state")!.getAttribute("aria-live")).toBe("polite");
    expect(row.querySelector(".server-url")!.textContent).toBe("http://127.0.0.1:8880");
    expect(row.querySelector(".install-hint")!.textContent).toBe(kokoro.install);
    expect(row.querySelector<HTMLElement>(".install-hint")!.tabIndex).toBe(0);
    expect(row.querySelector(".remove")).toBeNull();
  });

  it("online probe marks the state ok; setServerProbe settles a checking row", () => {
    const row = buildServerRow(kokoro, null);
    setServerProbe(row, { online: true, caps: DEGRADED_CAPS });
    expect(row.querySelector(".provider-state")!.textContent).toBe("online");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(true);
    setServerProbe(row, { online: false, caps: DEGRADED_CAPS });
    expect(row.querySelector(".provider-state")!.textContent).toBe("offline");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(false);
  });

  it("custom rows are removable and carry no install hint", () => {
    const custom = { id: "custom-abc", name: "My server", baseUrl: "http://127.0.0.1:9000" };
    const row = buildServerRow(custom, null, true);
    expect(row.querySelector(".install-hint")).toBeNull();
    const remove = row.querySelector<HTMLButtonElement>(".remove")!;
    expect(remove.getAttribute("aria-label")).toBe("Remove My server");
  });
});

describe("add-a-server form", () => {
  function fields() {
    return {
      name: document.createElement("input"),
      url: document.createElement("input"),
      hint: document.createElement("div"),
    };
  }

  it("a preset fills name, address, and the install hint verbatim", () => {
    const piper = BUILT_IN_PROFILES.find((p) => p.id === "piper")!;
    const f = fields();
    applyPreset(piper, f);
    expect(f.name.value).toBe("Piper");
    expect(f.url.value).toBe("http://127.0.0.1:8881");
    expect(f.hint.hidden).toBe(false);
    expect(f.hint.textContent).toBe(piper.install);
  });

  it("clearing the preset empties the form and hides the hint", () => {
    const f = fields();
    applyPreset(BUILT_IN_PROFILES[0], f);
    applyPreset(null, f);
    expect(f.name.value).toBe("");
    expect(f.url.value).toBe("");
    expect(f.hint.hidden).toBe(true);
  });

  it("baseUrl validation: empty, non-loopback, and good loopback", () => {
    expect(baseUrlProblem("")).toBe("Enter the server's address.");
    expect(baseUrlProblem("http://192.168.1.10:8880")).toContain("127.0.0.1");
    expect(baseUrlProblem("https://127.0.0.1:8880")).toContain("http://");
    expect(baseUrlProblem("http://127.0.0.1:8880")).toBeNull();
    expect(baseUrlProblem("http://localhost:8882")).toBeNull();
  });

  it("baseUrl validation rejects an address already listed, normalized", () => {
    const existing = [...BUILT_IN_PROFILES.map((p) => p.baseUrl), "http://localhost:9999"];
    expect(baseUrlProblem("http://127.0.0.1:8880", existing)).toBe("This address is already listed.");
    // Normalization: path and trailing slash don't dodge the duplicate check.
    expect(baseUrlProblem("http://127.0.0.1:8880/", existing)).toBe("This address is already listed.");
    expect(baseUrlProblem("http://localhost:9999/some/path", existing)).toBe("This address is already listed.");
    expect(baseUrlProblem("http://127.0.0.1:8885", existing)).toBeNull();
  });
});

describe("voice-source summary and labels", () => {
  it("summarizes keys and online servers for the popup footer", () => {
    expect(summarizeVoiceSources(0, [])).toBe("no API keys saved · no local servers online");
    expect(summarizeVoiceSources(1, ["Kokoro"])).toBe("1 API key saved · Kokoro online");
    expect(summarizeVoiceSources(3, ["Kokoro", "Piper"])).toBe("3 API keys saved · Kokoro, Piper online");
  });

  it("labels local families from the built-in catalog, customs, or the id", () => {
    expect(localFamilyLabel("local-kokoro")).toBe("Kokoro (local)");
    expect(localFamilyLabel("local-custom-abc", new Map([["custom-abc", "My server"]]))).toBe("My server (local)");
    expect(localFamilyLabel("local-mystery")).toBe("Mystery (local)");
    expect(localFamilyLabel("openai")).toBeNull();
    // familyLabel consults the same mapping before falling back to the id.
    expect(familyLabel("local-piper")).toBe("Piper (local)");
    expect(familyLabel("web-speech")).toBe("Web Speech");
  });

  it("localProfileName: custom map, then built-in catalog, then capitalized id", () => {
    expect(localProfileName("kokoro")).toBe("Kokoro");
    expect(localProfileName("custom-abc", new Map([["custom-abc", "My server"]]))).toBe("My server");
    expect(localProfileName("mystery")).toBe("Mystery");
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
