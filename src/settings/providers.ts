// SPDX-License-Identifier: MPL-2.0
/**
 * BYO-key provider settings (ADR-0003): the provider catalog, key masking,
 * and the provider-row DOM builder. Rendered on the options page; the popup
 * imports the catalog to keep the voice picker's keyless-family affordances
 * truthful. Pure builders are exported for tests/settings.test.ts.
 */
import { AZURE_DEFAULT_REGION, AZURE_REGIONS } from "../audio/engine-azure";

export interface ProviderDef {
  id: string;
  label: string;
  keyStorage: string;
  regionStorage?: string;
  /** Optional muted note under the row (e.g. mistral's Voices-API decision). */
  hint?: string;
  /** When set, the region renders as a dropdown (default preselected) instead of free text. */
  regionOptions?: { list: readonly string[]; default: string };
}

/** BYO-key provider catalog — storage keys per docs/ADR-0003 settings shape. */
export const PROVIDERS: ProviderDef[] = [
  { id: "minimax", label: "MiniMax", keyStorage: "leia:settings:minimaxKey" },
  { id: "elevenlabs", label: "ElevenLabs", keyStorage: "leia:settings:elevenlabsKey" },
  { id: "openai", label: "OpenAI", keyStorage: "leia:settings:openaiKey" },
  { id: "xai", label: "xAI", keyStorage: "leia:settings:xaiKey" },
  {
    id: "mistral",
    label: "Mistral",
    keyStorage: "leia:settings:mistralKey",
    hint: "Mistral voices are the saved voices on your account (create in the Mistral console / Le Chat voice library) — they load automatically in the picker.",
  },
  { id: "gemini", label: "Gemini", keyStorage: "leia:settings:geminiKey" },
  {
    id: "azure",
    label: "Azure",
    keyStorage: "leia:settings:azureKey",
    regionStorage: "leia:settings:azureRegion",
    regionOptions: { list: AZURE_REGIONS, default: AZURE_DEFAULT_REGION },
  },
];

/** Mask a stored key for display, keeping only the last 4 chars. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

/**
 * Picker group label for a provider that contributed no voices. Absence of
 * voices is not absence of a key (Mistral's getVoices returns [] on API
 * failure) — a saved-but-broken key must not read as "no key".
 */
export function keylessProviderLabel(def: ProviderDef, hasKey: boolean): string {
  return hasKey ? `${def.label} — key saved, no voices loaded` : `${def.label} — no key`;
}

/** Action line inside a keyless provider's disabled picker group. */
export function keylessProviderHint(hasKey: boolean): string {
  return hasKey ? "check the key — see Voice sources below" : "add an API key — see Voice sources below";
}

/**
 * One provider row: name + key state, masked key input with a reveal toggle
 * and a save button, plus a region field for providers that need one
 * (azure). Pure DOM — the options page wires the save behavior.
 */
export function buildProviderRow(def: ProviderDef, savedKey: string | null, savedRegion: string | null = null): HTMLElement {
  const row = document.createElement("div");
  row.className = "provider";
  row.dataset.provider = def.id;

  const head = document.createElement("div");
  head.className = "provider-head";
  const name = document.createElement("span");
  name.className = "provider-name";
  name.textContent = def.label;
  const state = document.createElement("span");
  state.className = savedKey ? "provider-state ok" : "provider-state";
  state.setAttribute("aria-live", "polite");
  state.textContent = savedKey ? `saved ${maskKey(savedKey)}` : "no key";
  head.append(name, state);

  const fields = document.createElement("div");
  fields.className = "provider-fields";
  const input = document.createElement("input");
  input.className = "key-input";
  input.type = "password";
  input.placeholder = savedKey ? "replace key" : "API key";
  input.setAttribute("aria-label", `${def.label} API key`);
  input.autocomplete = "off";
  input.spellcheck = false;
  if (savedKey) input.value = savedKey;
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "ghost reveal";
  reveal.textContent = "show";
  reveal.setAttribute("aria-label", `Show or hide the ${def.label} API key`);
  reveal.setAttribute("aria-pressed", "false");
  reveal.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    reveal.textContent = show ? "hide" : "show";
    reveal.setAttribute("aria-pressed", String(show));
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost save";
  save.textContent = "save";
  save.setAttribute("aria-label", `Save the ${def.label} API key`);
  fields.append(input, reveal, save);

  row.append(head, fields);
  if (def.hint) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = def.hint;
    row.append(hint);
  }
  if (def.regionStorage) {
    if (def.regionOptions) {
      // Curated region list: dropdown, most-common default preselected.
      const select = document.createElement("select");
      select.className = "region";
      select.setAttribute("aria-label", `${def.label} region`);
      for (const r of def.regionOptions.list) {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r === def.regionOptions.default ? `${r} (default)` : r;
        select.appendChild(opt);
      }
      select.value = savedRegion && def.regionOptions.list.includes(savedRegion) ? savedRegion : def.regionOptions.default;
      row.append(select);
    } else {
      const region = document.createElement("input");
      region.className = "region";
      region.type = "text";
      region.placeholder = "region (e.g. eastus)";
      region.setAttribute("aria-label", `${def.label} region`);
      region.autocomplete = "off";
      region.spellcheck = false;
      if (savedRegion) region.value = savedRegion;
      row.append(region);
    }
  }
  return row;
}
