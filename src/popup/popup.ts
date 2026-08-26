/**
 * Popup (toolbar action, T14): playback controls, family-grouped voice
 * picker with per-family capability disclosure (ADR-0003), highlight-theme
 * swatches, and BYO-key provider management.
 *
 * The pure/DOM builders (capabilityChips, renderCapabilities, maskKey,
 * buildProviderRow, theme storage helpers) are exported for
 * tests/settings.test.ts; the wiring bootstrap at the bottom only runs when
 * the popup DOM is present.
 */
import browser from "webextension-polyfill";
import type { RouterMessage, RouterReply } from "../background/router";
import type { SessionStatus } from "../reader/session";
import type { EngineCapabilities, VoiceInfo } from "../reader/contract";
import { ACTIVE_THEME, THEME_IDS, THEMES, type ThemeId } from "../content/themes";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];

export const THEME_STORAGE_KEY = "leia:settings:theme";

export interface ProviderDef {
  id: string;
  label: string;
  keyStorage: string;
  regionStorage?: string;
}

/** BYO-key provider catalog — storage keys per docs/ADR-0003 settings shape. */
export const PROVIDERS: ProviderDef[] = [
  { id: "minimax", label: "MiniMax", keyStorage: "leia:settings:minimaxKey" },
  { id: "elevenlabs", label: "ElevenLabs", keyStorage: "leia:settings:elevenlabsKey" },
  { id: "openai", label: "OpenAI", keyStorage: "leia:settings:openaiKey" },
  { id: "azure", label: "Azure", keyStorage: "leia:settings:azureKey", regionStorage: "leia:settings:azureRegion" },
];

export interface FamilyInfo {
  family: string;
  capabilities: EngineCapabilities;
}

const FAMILY_LABELS: Record<string, string> = {
  "web-speech": "Web Speech",
  minimax: "MiniMax",
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  azure: "Azure",
};

export function familyLabel(id: string): string {
  return FAMILY_LABELS[id] ?? id;
}

/** Disclosure chip labels for a family's capabilities (ADR-0003). */
export function capabilityChips(caps: EngineCapabilities): string[] {
  return [
    caps.costClass,
    caps.privacyClass,
    caps.wordTiming ? "word timing" : "estimated word timing",
    ...(caps.streaming ? ["streaming"] : []),
  ];
}

export function renderCapabilities(container: HTMLElement, caps: EngineCapabilities | null): void {
  container.innerHTML = "";
  if (!caps) return;
  for (const label of capabilityChips(caps)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = label;
    container.appendChild(chip);
  }
}

/** Mask a stored key for display, keeping only the last 4 chars. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

export function isThemeId(x: unknown): x is ThemeId {
  return typeof x === "string" && (THEME_IDS as string[]).includes(x);
}

interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadStoredTheme(storage: StorageLike): Promise<ThemeId> {
  const got = await storage.get(THEME_STORAGE_KEY);
  const t = got[THEME_STORAGE_KEY];
  return isThemeId(t) ? t : ACTIVE_THEME;
}

export function saveStoredTheme(storage: StorageLike, id: ThemeId): Promise<void> {
  return storage.set({ [THEME_STORAGE_KEY]: id });
}

/**
 * One provider row: name + key state, masked key input with a reveal toggle
 * and a save button, plus a region field for providers that need one
 * (azure). Pure DOM — the bootstrap wires the save behavior.
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
  state.textContent = savedKey ? `saved ${maskKey(savedKey)}` : "no key";
  head.append(name, state);

  const fields = document.createElement("div");
  fields.className = "provider-fields";
  const input = document.createElement("input");
  input.className = "key-input";
  input.type = "password";
  input.placeholder = savedKey ? "replace key" : "API key";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (savedKey) input.value = savedKey;
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "ghost reveal";
  reveal.textContent = "show";
  reveal.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    reveal.textContent = show ? "hide" : "show";
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost save";
  save.textContent = "save";
  fields.append(input, reveal, save);

  row.append(head, fields);
  if (def.regionStorage) {
    const region = document.createElement("input");
    region.className = "region";
    region.type = "text";
    region.placeholder = "region (e.g. eastus)";
    region.autocomplete = "off";
    region.spellcheck = false;
    if (savedRegion) region.value = savedRegion;
    row.append(region);
  }
  return row;
}

// --- Bootstrap: runs only inside the real popup document -----------------

if (document.getElementById("voice")) {
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const readerErrorEl = document.getElementById("reader-error") as HTMLDivElement;
  const resumeRow = document.getElementById("resume-row") as HTMLDivElement;
  const resumeLabel = document.getElementById("resume-label") as HTMLSpanElement;
  const resumeClearBtn = document.getElementById("resume-clear") as HTMLButtonElement;
  const voiceSelect = document.getElementById("voice") as HTMLSelectElement;
  const previewBtn = document.getElementById("preview-voice") as HTMLButtonElement;
  const previewNote = document.getElementById("preview-note") as HTMLDivElement;
  const speedSelect = document.getElementById("speed") as HTMLSelectElement;
  const capsEl = document.getElementById("capabilities") as HTMLDivElement;
  const swatchesEl = document.getElementById("theme-swatches") as HTMLDivElement;
  const providersEl = document.getElementById("providers") as HTMLDivElement;

  const send = (msg: RouterMessage): Promise<unknown> =>
    browser.runtime.sendMessage(msg).catch((err) => ({ error: String(err) }));

  let currentStatus: SessionStatus | null = null;
  let voicesByFamily = new Map<string, VoiceInfo[]>();
  let familyCaps = new Map<string, EngineCapabilities>();

  function updateCapabilities(): void {
    const chosen = [...voicesByFamily.values()].flat().find((v) => v.name === voiceSelect.value);
    const family = chosen?.family ?? currentStatus?.settings.engine ?? "web-speech";
    renderCapabilities(capsEl, familyCaps.get(family) ?? null);
  }

  async function refresh(): Promise<void> {
    const [statusReply, voicesReply, familiesReply] = await Promise.all([
      send({ type: "leia:reader:status" }),
      send({ type: "leia:reader:voices" }),
      send({ type: "leia:audio:families" }),
    ]);
    const status = (statusReply as RouterReply | undefined)?.data as SessionStatus | undefined;
    currentStatus = status ?? null;
    if (status) {
      const fam = status.settings.engine;
      const famSuffix = fam && fam !== "web-speech" ? ` · ${fam}` : "";
      statusEl.textContent =
        status.state === "stopped"
          ? "no active session"
          : `${status.state} · ${Math.min(status.tokenPos + 1, status.tokenCount)}/${status.tokenCount}${famSuffix}`;
      speedSelect.value = String(status.settings.rate);
    }
    // T17 — surface engine failures instead of a silent pause.
    if (status?.lastError) {
      readerErrorEl.textContent = `engine error — ${status.lastError}`;
      readerErrorEl.hidden = false;
    } else {
      readerErrorEl.hidden = true;
    }

    const voices = ((voicesReply as RouterReply | undefined)?.data as VoiceInfo[] | undefined) ?? [];
    voicesByFamily = new Map<string, VoiceInfo[]>();
    for (const v of voices) {
      const list = voicesByFamily.get(v.family) ?? [];
      list.push(v);
      voicesByFamily.set(v.family, list);
    }

    familyCaps = new Map(
      (((familiesReply as RouterReply | undefined)?.data as FamilyInfo[] | undefined) ?? []).map(
        (f) => [f.family, f.capabilities],
      ),
    );

    voiceSelect.innerHTML = '<option value="">(default voice)</option>';
    for (const [family, list] of voicesByFamily) {
      const group = document.createElement("optgroup");
      group.label = familyLabel(family);
      for (const v of list) {
        const opt = document.createElement("option");
        opt.value = v.name;
        opt.dataset.family = family;
        opt.textContent = `${v.name} (${v.lang})`;
        group.appendChild(opt);
      }
      voiceSelect.appendChild(group);
    }
    // Keyless provider families contribute no voices (hub skips them), but
    // stay visible in the picker with an affordance pointing at Providers.
    for (const p of PROVIDERS) {
      if (voicesByFamily.has(p.id)) continue;
      const group = document.createElement("optgroup");
      group.label = `${p.label} — no key`;
      group.disabled = true;
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.textContent = "add an API key in Providers below";
      group.appendChild(opt);
      voiceSelect.appendChild(group);
    }
    voiceSelect.value = status?.settings.voiceName ?? "";
    previewBtn.disabled = !voiceSelect.value;
    updateCapabilities();
    void refreshResume();
  }

  /**
   * T16 resume hint for the ACTIVE tab: "Continue from sentence N" + clear.
   * Reads the record through the background relay (the store stays behind
   * background). Skips silently when the tab URL is unavailable.
   */
  async function refreshResume(): Promise<void> {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.url !== "string") {
        resumeRow.hidden = true;
        return;
      }
      const reply = (await send({ type: "leia:reader:resume-info", url: tab.url })) as RouterReply | undefined;
      const info = reply?.ok
        ? (reply.data as { url: string; tokenPos: number; tokenCount: number } | null | undefined)
        : null;
      if (!info) {
        resumeRow.hidden = true;
        return;
      }
      resumeLabel.textContent = `Continue from sentence ${info.tokenPos + 1}`;
      resumeRow.hidden = false;
    } catch {
      resumeRow.hidden = true;
    }
  }

  function markTheme(selected: ThemeId): void {
    for (const btn of swatchesEl.querySelectorAll<HTMLButtonElement>(".swatch")) {
      btn.setAttribute("aria-checked", String(btn.dataset.theme === selected));
    }
  }

  async function pickTheme(id: ThemeId): Promise<void> {
    markTheme(id);
    await saveStoredTheme(browser.storage.local, id);
    await send({ type: "leia:theme:set", theme: id });
  }

  async function initThemes(): Promise<void> {
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      const light = theme.variants.find((v) => v.band === "light");
      const dark = theme.variants.find((v) => v.band === "dark");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch";
      btn.dataset.theme = id;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      const chip = document.createElement("span");
      chip.className = "swatch-chip";
      const lightBg = light?.background ?? "transparent";
      const darkBg = dark?.background ?? "transparent";
      chip.style.background = `linear-gradient(135deg, ${lightBg} 50%, ${darkBg} 50%)`;
      const label = document.createElement("span");
      label.className = "swatch-label";
      label.textContent = theme.label;
      btn.append(chip, label);
      btn.addEventListener("click", () => void pickTheme(id));
      swatchesEl.appendChild(btn);
    }
    markTheme(await loadStoredTheme(browser.storage.local));
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
        void refresh(); // newly-keyed families now contribute voices
      };
      row.querySelector<HTMLButtonElement>(".save")!.addEventListener("click", () => void saveAll());
      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void saveAll();
      });
      providersEl.appendChild(row);
    }
  }

  document.getElementById("read-selection")!.addEventListener("click", async () => {
    const reply = (await send({ type: "leia:reader:start" })) as RouterReply | undefined;
    statusEl.textContent = reply?.ok
      ? `reading — ${String((reply.data as SessionStatus | undefined)?.tokenCount ?? "?")} sentences`
      : `failed: ${String(reply?.error ?? "unknown")}`;
  });

  voiceSelect.addEventListener("change", () => {
    const voiceName = voiceSelect.value || null;
    const prefs: { voiceName: string | null; engine?: string | null } = { voiceName };
    if (voiceName) {
      // Switching families requires routing prefs: send the voice's family
      // when it differs from the session's current engine setting.
      const chosen = [...voicesByFamily.values()].flat().find((v) => v.name === voiceName);
      if (chosen && chosen.family !== currentStatus?.settings.engine) prefs.engine = chosen.family;
    }
    void send({ type: "leia:reader:prefs", ...prefs });
    previewBtn.disabled = !voiceName;
    updateCapabilities();
  });

  previewBtn.addEventListener("click", async () => {
    const voiceName = voiceSelect.value || null;
    if (!voiceName) return;
    const opt = voiceSelect.selectedOptions[0] as HTMLOptionElement | undefined;
    const reply = (await send({
      type: "leia:reader:preview",
      voiceName,
      family: opt?.dataset.family,
    })) as RouterReply | undefined;
    if (!reply?.ok) {
      // Keyless provider family (or engine failure): flash a grounded hint.
      previewNote.textContent = "no key — add an API key in Providers below";
      previewNote.hidden = false;
      setTimeout(() => {
        previewNote.hidden = true;
      }, 4000);
    }
  });

  resumeClearBtn.addEventListener("click", async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.url === "string") {
        await send({ type: "leia:reader:resume-clear", url: tab.url });
      }
    } finally {
      resumeRow.hidden = true;
    }
  });

  speedSelect.addEventListener("change", () => {
    void send({ type: "leia:reader:prefs", rate: Number(speedSelect.value) });
  });

  for (const v of SPEED_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = `${v}×`;
    speedSelect.appendChild(opt);
  }

  void refresh();
  void initThemes();
  void initProviders();
}
