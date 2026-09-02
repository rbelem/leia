// SPDX-License-Identifier: MPL-2.0
/**
 * Options page (settings home): local voice-server profiles (ADR-0006) and
 * BYO-key provider management (ADR-0003). A tab, not a popup — entering
 * keys and copying install commands survives window switches.
 *
 * Probing runs straight from this page (loopback host permissions are
 * mandatory in the manifest); profile config persists to
 * browser.storage.local. Background picks up added/removed servers the next
 * time the audio owner boots — the ponytail note in engine-local.ts tracks
 * live re-registration.
 */
import browser from "webextension-polyfill";
import {
  BUILT_IN_PROFILES,
  probeProfile,
  readLocalProfiles,
  validateBaseUrl,
  writeLocalProfiles,
  type LocalProfile,
} from "../audio/local-profiles";
import { PROVIDERS, buildProviderRow, maskKey } from "../settings/providers";
import {
  applyPreset,
  baseUrlProblem,
  buildServerRow,
  newCustomId,
  setServerProbe,
} from "../settings/local";

// --- Bootstrap: runs only inside the real options document ----------------

if (document.getElementById("providers")) {
  const providersEl = document.getElementById("providers") as HTMLDivElement;
  const builtinsEl = document.getElementById("builtin-servers") as HTMLDivElement;
  const customsEl = document.getElementById("custom-servers") as HTMLDivElement;
  const presetSelect = document.getElementById("custom-preset") as HTMLSelectElement;
  const nameInput = document.getElementById("custom-name") as HTMLInputElement;
  const urlInput = document.getElementById("custom-url") as HTMLInputElement;
  const hintEl = document.getElementById("custom-hint") as HTMLDivElement;
  const errorEl = document.getElementById("custom-error") as HTMLParagraphElement;
  const addBtn = document.getElementById("custom-add") as HTMLButtonElement;
  const reloadBtn = document.getElementById("reload-ext") as HTMLButtonElement;

  /** Render a server row already checking…, then settle it when the probe answers. */
  function renderServer(container: HTMLElement, profile: LocalProfile, removable: boolean): HTMLElement {
    const row = buildServerRow(profile, null, removable);
    container.appendChild(row);
    void probeProfile(profile.baseUrl).then((probe) => setServerProbe(row, probe));
    return row;
  }

  async function renderCustoms(): Promise<void> {
    const customs = await readLocalProfiles();
    customsEl.replaceChildren();
    for (const profile of customs) {
      const row = renderServer(customsEl, profile, true);
      row.querySelector<HTMLButtonElement>(".remove")!.addEventListener("click", () => {
        void removeCustom(profile.id);
      });
    }
  }

  async function removeCustom(id: string): Promise<void> {
    const customs = await readLocalProfiles();
    await writeLocalProfiles(customs.filter((p) => p.id !== id));
    await renderCustoms();
  }

  function showError(message: string | null): void {
    errorEl.hidden = message === null;
    errorEl.textContent = message ?? "";
    if (message === null) urlInput.removeAttribute("aria-invalid");
    else urlInput.setAttribute("aria-invalid", "true");
  }

  async function addCustom(): Promise<void> {
    const customs = await readLocalProfiles();
    const existing = [...BUILT_IN_PROFILES, ...customs].map((p) => p.baseUrl);
    const problem = baseUrlProblem(urlInput.value, existing);
    if (problem) {
      showError(problem);
      urlInput.focus();
      return;
    }
    showError(null);
    const profile: LocalProfile = {
      id: newCustomId(),
      name: nameInput.value.trim() || "Custom server",
      // Store the normalized address (no path/trailing slash), not raw input.
      baseUrl: validateBaseUrl(urlInput.value.trim())!,
    };
    await writeLocalProfiles([...customs, profile]);
    presetSelect.value = "";
    applyPreset(null, { name: nameInput, url: urlInput, hint: hintEl });
    await renderCustoms();
    nameInput.focus();
  }

  async function initProviders(): Promise<void> {
    const keys = PROVIDERS.flatMap((p) => (p.regionStorage ? [p.keyStorage, p.regionStorage] : [p.keyStorage]));
    const stored = (await browser.storage.local.get(keys)) as Record<string, unknown>;
    for (const def of PROVIDERS) {
      const savedKey = typeof stored[def.keyStorage] === "string" && stored[def.keyStorage] ? (stored[def.keyStorage] as string) : null;
      const savedRegion = def.regionStorage && typeof stored[def.regionStorage] === "string" && stored[def.regionStorage]
        ? (stored[def.regionStorage] as string)
        : null;
      const row = buildProviderRow(def, savedKey, savedRegion);
      const keyInput = row.querySelector<HTMLInputElement>(".key-input")!;
      const regionInput = row.querySelector<HTMLInputElement>(".region");
      const state = row.querySelector<HTMLElement>(".provider-state")!;
      const saveAll = async (): Promise<void> => {
        const key = keyInput.value.trim();
        const items: Record<string, unknown> = { [def.keyStorage]: key };
        if (def.regionStorage && regionInput) items[def.regionStorage] = regionInput.value.trim();
        await browser.storage.local.set(items);
        state.textContent = key ? `saved ${maskKey(key)}` : "no key";
        state.classList.toggle("ok", key.length > 0);
      };
      row.querySelector<HTMLButtonElement>(".save")!.addEventListener("click", () => void saveAll());
      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void saveAll();
      });
      providersEl.appendChild(row);
    }
  }

  for (const profile of BUILT_IN_PROFILES) {
    renderServer(builtinsEl, profile, false);
    const opt = document.createElement("option");
    opt.value = profile.id;
    opt.textContent = profile.name;
    presetSelect.appendChild(opt);
  }
  presetSelect.addEventListener("change", () => {
    const preset = BUILT_IN_PROFILES.find((p) => p.id === presetSelect.value) ?? null;
    applyPreset(preset, { name: nameInput, url: urlInput, hint: hintEl });
    showError(null);
  });
  addBtn.addEventListener("click", () => void addCustom());
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void addCustom();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void addCustom();
  });
  reloadBtn.addEventListener("click", () => browser.runtime.reload());

  void renderCustoms();
  void initProviders();
}
