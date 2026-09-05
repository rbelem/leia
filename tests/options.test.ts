// SPDX-License-Identifier: MPL-2.0
/**
 * Options page bootstrap coverage: builtin server rows with probe settle,
 * BYO-key provider rows (save via click/Enter, region dropdown), the
 * add-a-custom-server form (validation, duplicates, presets, remove), and
 * the extension reload button. Probes run against a rejecting fetch —
 * no local servers exist in tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_PROFILES } from "../src/audio/local-profiles";
import { AZURE_DEFAULT_REGION, AZURE_REGIONS } from "../src/audio/engine-azure";

const h = vi.hoisted(() => ({
  storage: {} as Record<string, unknown>,
  reloadCalls: 0,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      reload: () => {
        h.reloadCalls += 1;
      },
    },
    storage: {
      local: {
        get: async (key: string | string[]) =>
          Array.isArray(key)
            ? Object.fromEntries(key.map((k) => [k, h.storage[k]]))
            : { [key]: h.storage[key] },
        set: async (items: Record<string, unknown>) => {
          Object.assign(h.storage, items);
        },
      },
    },
  },
}));

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

const q = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function buildOptionsDom(): void {
  document.body.innerHTML = `
    <div id="providers"></div>
    <div id="builtin-servers"></div>
    <div id="custom-servers"></div>
    <select id="custom-preset"></select>
    <input id="custom-name" />
    <input id="custom-url" />
    <div id="custom-hint" hidden></div>
    <p id="custom-error" hidden></p>
    <button id="custom-add"></button>
    <button id="reload-ext"></button>`;
}

async function loadOptions(): Promise<void> {
  vi.resetModules();
  await import("../src/options/options");
  await settle();
}

const providerRow = (id: string): HTMLElement =>
  q("providers").querySelector<HTMLElement>(`[data-provider="${id}"]`)!;

beforeEach(() => {
  for (const k of Object.keys(h.storage)) delete h.storage[k];
  h.reloadCalls = 0;
  buildOptionsDom();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no local server in tests");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial render", () => {
  it("renders builtin server rows that settle offline, presets, and provider rows", async () => {
    await loadOptions();

    const builtins = [...q("builtin-servers").querySelectorAll<HTMLElement>(".server")];
    expect(builtins).toHaveLength(BUILT_IN_PROFILES.length);
    expect(builtins[0]!.querySelector(".provider-name")!.textContent).toBe("Kokoro");
    expect(builtins[0]!.querySelector(".install-hint")!.textContent).toBe(BUILT_IN_PROFILES[0]!.install);
    expect(builtins[0]!.querySelector(".remove")).toBeNull();
    // Every probe failed (fetch rejects) → rows settle offline.
    for (const row of builtins) {
      expect(row.querySelector(".provider-state")!.textContent).toBe("offline");
      expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(false);
    }

    const preset = q<HTMLSelectElement>("custom-preset");
    expect([...preset.options].map((o) => o.value)).toEqual(BUILT_IN_PROFILES.map((p) => p.id));

    const rows = [...q("providers").querySelectorAll<HTMLElement>(".provider")];
    expect(rows).toHaveLength(7);
    expect(providerRow("minimax").querySelector(".provider-state")!.textContent).toBe("no key");
    // Azure renders its region as a dropdown with the default preselected.
    const azure = providerRow("azure").querySelector<HTMLSelectElement>("select.region")!;
    expect([...azure.options].map((o) => o.value)).toEqual([...AZURE_REGIONS]);
    expect(azure.value).toBe(AZURE_DEFAULT_REGION);
    expect(q("custom-servers").children).toHaveLength(0);
  });

  it("restores saved keys and the stored azure region", async () => {
    h.storage["leia:settings:minimaxKey"] = "sk-abcd1234";
    h.storage["leia:settings:azureRegion"] = "japaneast";
    await loadOptions();

    const minimax = providerRow("minimax");
    expect(minimax.querySelector(".provider-state")!.textContent).toBe("saved ••••1234");
    expect(minimax.querySelector(".provider-state")!.classList.contains("ok")).toBe(true);
    expect(minimax.querySelector<HTMLInputElement>(".key-input")!.value).toBe("sk-abcd1234");
    expect(providerRow("azure").querySelector<HTMLSelectElement>("select.region")!.value).toBe("japaneast");
  });
});

describe("provider key saving", () => {
  it("saves via the button, masks the state, and stores the region alongside", async () => {
    await loadOptions();

    const minimaxInput = providerRow("minimax").querySelector<HTMLInputElement>(".key-input")!;
    minimaxInput.value = "  sk-zz99  ";
    providerRow("minimax").querySelector<HTMLButtonElement>(".save")!.click();
    await settle();
    expect(h.storage["leia:settings:minimaxKey"]).toBe("sk-zz99");
    expect(providerRow("minimax").querySelector(".provider-state")!.textContent).toBe("saved ••••zz99");

    const azure = providerRow("azure");
    azure.querySelector<HTMLInputElement>(".key-input")!.value = "az-key-7777";
    azure.querySelector<HTMLSelectElement>("select.region")!.value = "eastus";
    azure.querySelector<HTMLButtonElement>(".save")!.click();
    await settle();
    expect(h.storage["leia:settings:azureKey"]).toBe("az-key-7777");
    expect(h.storage["leia:settings:azureRegion"]).toBe("eastus");
    expect(azure.querySelector(".provider-state")!.textContent).toBe("saved ••••7777");
  });

  it("saving an empty key records the no-key state", async () => {
    h.storage["leia:settings:openaiKey"] = "sk-old1234";
    await loadOptions();

    const row = providerRow("openai");
    row.querySelector<HTMLInputElement>(".key-input")!.value = "   ";
    row.querySelector<HTMLButtonElement>(".save")!.click();
    await settle();
    expect(h.storage["leia:settings:openaiKey"]).toBe("");
    expect(row.querySelector(".provider-state")!.textContent).toBe("no key");
    expect(row.querySelector(".provider-state")!.classList.contains("ok")).toBe(false);
  });

  it("Enter in the key input saves", async () => {
    await loadOptions();
    const input = providerRow("gemini").querySelector<HTMLInputElement>(".key-input")!;
    input.value = "g-key-4321";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(h.storage["leia:settings:geminiKey"]).toBe("g-key-4321");
  });
});

describe("add-a-custom-server form", () => {
  const customProfiles = (): unknown[] => h.storage["leia:settings:localProfiles"] as unknown[];

  it("rejects an empty or non-loopback address with an inline error", async () => {
    await loadOptions();

    q<HTMLButtonElement>("custom-add").click();
    await settle();
    expect(q("custom-error").hidden).toBe(false);
    expect(q("custom-error").textContent).toBe("Enter the server's address.");
    expect(q<HTMLInputElement>("custom-url").getAttribute("aria-invalid")).toBe("true");

    q<HTMLInputElement>("custom-url").value = "http://192.168.1.10:8880";
    q<HTMLButtonElement>("custom-add").click();
    await settle();
    expect(q("custom-error").textContent).toContain("Only http:// addresses on 127.0.0.1");
    expect(customProfiles()).toBeUndefined();
  });

  it("rejects an address already listed", async () => {
    await loadOptions();
    q<HTMLInputElement>("custom-url").value = "http://127.0.0.1:8880";
    q<HTMLButtonElement>("custom-add").click();
    await settle();
    expect(q("custom-error").textContent).toBe("This address is already listed.");
  });

  it("adds a valid custom server, normalizes the address, and re-renders", async () => {
    await loadOptions();
    q<HTMLInputElement>("custom-name").value = "  My Box  ";
    q<HTMLInputElement>("custom-url").value = "http://localhost:9001/some/path/";
    q<HTMLButtonElement>("custom-add").click();
    await settle();

    expect(customProfiles()).toEqual([
      { id: expect.stringMatching(/^custom-/), name: "My Box", baseUrl: "http://localhost:9001" },
    ]);
    expect(q("custom-error").hidden).toBe(true);
    expect(q<HTMLInputElement>("custom-url").getAttribute("aria-invalid")).toBeNull();
    // Form reset after a successful add.
    expect(q<HTMLInputElement>("custom-name").value).toBe("");
    expect(q<HTMLInputElement>("custom-url").value).toBe("");
    expect(q("custom-hint").hidden).toBe(true);
    expect(document.activeElement).toBe(q<HTMLInputElement>("custom-name"));
    // The new row is rendered removable and probes offline.
    const row = q("custom-servers").querySelector<HTMLElement>(".server")!;
    expect(row.querySelector(".provider-name")!.textContent).toBe("My Box");
    expect(row.querySelector(".server-url")!.textContent).toBe("http://localhost:9001");
    expect(row.querySelector(".remove")!.getAttribute("aria-label")).toBe("Remove My Box");
    expect(row.querySelector(".provider-state")!.textContent).toBe("offline");
  });

  it("falls back to a generic name and removes stored customs from the row button", async () => {
    await loadOptions();

    q<HTMLInputElement>("custom-url").value = "http://localhost:9002";
    q<HTMLButtonElement>("custom-add").click();
    await settle();
    expect(q("custom-servers").querySelector(".provider-name")!.textContent).toBe("Custom server");

    q("custom-servers").querySelector<HTMLButtonElement>(".remove")!.click();
    await settle();
    expect(customProfiles()).toEqual([]);
    expect(q("custom-servers").children).toHaveLength(0);
  });

  it("Enter in the url or name field adds the server", async () => {
    await loadOptions();

    q<HTMLInputElement>("custom-url").value = "http://localhost:9003";
    q<HTMLInputElement>("custom-url").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(customProfiles()).toHaveLength(1);

    q<HTMLInputElement>("custom-name").value = "Second";
    q<HTMLInputElement>("custom-url").value = "http://localhost:9004";
    q<HTMLInputElement>("custom-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(customProfiles()).toHaveLength(2);
  });
});

describe("presets and reload", () => {
  it("selecting a preset fills the form with the install hint; clearing empties it", async () => {
    await loadOptions();
    const preset = q<HTMLSelectElement>("custom-preset");
    const piper = BUILT_IN_PROFILES.find((p) => p.id === "piper")!;

    preset.value = "piper";
    preset.dispatchEvent(new Event("change"));
    expect(q<HTMLInputElement>("custom-name").value).toBe("Piper");
    expect(q<HTMLInputElement>("custom-url").value).toBe(piper.baseUrl);
    expect(q("custom-hint").hidden).toBe(false);
    expect(q("custom-hint").textContent).toBe(piper.install);
    expect(q("custom-error").hidden).toBe(true);

    preset.value = "";
    preset.dispatchEvent(new Event("change"));
    expect(q<HTMLInputElement>("custom-name").value).toBe("");
    expect(q<HTMLInputElement>("custom-url").value).toBe("");
    expect(q("custom-hint").hidden).toBe(true);
  });

  it("a validation error is cleared when a preset is chosen", async () => {
    await loadOptions();
    q<HTMLButtonElement>("custom-add").click();
    await settle();
    expect(q("custom-error").hidden).toBe(false);

    const preset = q<HTMLSelectElement>("custom-preset");
    preset.value = "kokoro";
    preset.dispatchEvent(new Event("change"));
    expect(q("custom-error").hidden).toBe(true);
    expect(q<HTMLInputElement>("custom-url").getAttribute("aria-invalid")).toBeNull();
  });

  it("reload-ext reloads the extension", async () => {
    await loadOptions();
    q<HTMLButtonElement>("reload-ext").click();
    expect(h.reloadCalls).toBe(1);
  });

  it("booting without the options DOM is a no-op", async () => {
    document.body.innerHTML = "";
    vi.resetModules();
    await import("../src/options/options");
    await settle();
    expect(h.reloadCalls).toBe(0);
  });

  it("non-Enter keydowns in the form fields do not add a server or save keys", async () => {
    await loadOptions();
    q<HTMLInputElement>("custom-url").value = "http://localhost:9005";
    q<HTMLInputElement>("custom-name").value = "Nope";
    for (const id of ["custom-url", "custom-name"]) {
      q<HTMLInputElement>(id).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    }
    providerRow("minimax").querySelector<HTMLInputElement>(".key-input")!.value = "nope-key";
    providerRow("minimax")
      .querySelector<HTMLInputElement>(".key-input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(h.storage["leia:settings:localProfiles"]).toBeUndefined();
    expect(h.storage["leia:settings:minimaxKey"]).toBeUndefined();
  });
});
