// SPDX-License-Identifier: MPL-2.0
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
import { isRouterMessage, type RouterMessage, type RouterReply } from "../background/router";
import type { SessionStatus } from "../reader/session";
import type { EngineCapabilities, VoiceInfo } from "../reader/contract";
import { AZURE_DEFAULT_REGION, AZURE_REGIONS } from "../audio/engine-azure";
import { ACTIVE_THEME, THEME_IDS, THEMES, type ThemeId } from "../content/themes";
import {
  CONTROLS_IN_PAGE_KEY,
  LOADING_TIMEOUT_MS,
  canSeekBack,
  canSeekForward,
  controlsInPage,
  loadingKindForAction,
  nextToken,
  playAction,
  playLabel,
  prevToken,
  shouldClearLoading,
  type LoadingKind,
} from "../controls";

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3];

export const THEME_STORAGE_KEY = "leia:settings:theme";

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
    hint: "Mistral voices are managed via Mistral's Voices API (saved profiles) — this engine uses its default voice.",
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

export interface FamilyInfo {
  family: string;
  capabilities: EngineCapabilities;
}

const FAMILY_LABELS: Record<string, string> = {
  "web-speech": "Web Speech",
  minimax: "MiniMax",
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  xai: "xAI",
  mistral: "Mistral",
  gemini: "Gemini",
  azure: "Azure",
  "kitten-local": "Kitten (local)",
};

/**
 * Per-family disclosure notes rendered under the voice picker (ADR-0003
 * capability disclosure). The kitten note exists so the one-time ~25 MB
 * model download is never discovered by silence (ticket 06).
 */
export const FAMILY_HINTS: Record<string, string> = {
  "kitten-local":
    "Runs on-device in this browser. The ~25 MB voice model downloads once on first use, then works offline.",
};

export function familyHint(id: string): string | null {
  return FAMILY_HINTS[id] ?? null;
}

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
  container.replaceChildren();
  if (!caps) return;
  for (const label of capabilityChips(caps)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = label;
    container.appendChild(chip);
  }
}

/** Show/hide the family disclosure note under the voice picker. */
export function renderFamilyHint(container: HTMLElement, hint: string | null): void {
  container.hidden = hint === null;
  container.textContent = hint ?? "";
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
  input.setAttribute("aria-label", `${def.label} API key`);
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

// --- Bootstrap: runs only inside the real popup document -----------------

if (document.getElementById("voice")) {
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const readerErrorEl = document.getElementById("reader-error") as HTMLDivElement;
  const playbackControls = document.getElementById("playback-controls") as HTMLDivElement;
  const playBtn = document.getElementById("pp-play") as HTMLButtonElement;
  const stopBtn = document.getElementById("pp-stop") as HTMLButtonElement;
  const backBtn = document.getElementById("pp-back") as HTMLButtonElement;
  const fwdBtn = document.getElementById("pp-fwd") as HTMLButtonElement;
  const openInPageBtn = document.getElementById("open-in-page") as HTMLButtonElement;
  const resumeRow = document.getElementById("resume-row") as HTMLDivElement;
  const resumeLabel = document.getElementById("resume-label") as HTMLSpanElement;
  const resumeClearBtn = document.getElementById("resume-clear") as HTMLButtonElement;
  const voiceSelect = document.getElementById("voice") as HTMLSelectElement;
  const previewBtn = document.getElementById("preview-voice") as HTMLButtonElement;
  const previewNote = document.getElementById("preview-note") as HTMLDivElement;
  const speedSelect = document.getElementById("speed") as HTMLSelectElement;
  const capsEl = document.getElementById("capabilities") as HTMLDivElement;
  const familyEl = document.getElementById("family-hint") as HTMLDivElement;
  const swatchesEl = document.getElementById("theme-swatches") as HTMLDivElement;
  const providersEl = document.getElementById("providers") as HTMLDivElement;

  const send = (msg: RouterMessage): Promise<unknown> =>
    browser.runtime.sendMessage(msg).catch((err) => ({ error: String(err) }));

  let currentStatus: SessionStatus | null = null;
  let voicesByFamily = new Map<string, VoiceInfo[]>();
  let familyCaps = new Map<string, EngineCapabilities>();
  /** Play-button pending state — see the note in floating-bar/index.ts. */
  let loading: LoadingKind | null = null;
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;

  function beginLoading(kind: LoadingKind): void {
    loading = kind;
    if (loadingTimer) clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      if (loading && shouldClearLoading({ type: "timeout" })) clearLoading();
    }, LOADING_TIMEOUT_MS);
    renderReader();
  }

  function clearLoading(): void {
    loading = null;
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    renderReader();
  }

  function updateCapabilities(): void {
    const chosen = [...voicesByFamily.values()].flat().find((v) => v.name === voiceSelect.value);
    const family = chosen?.family ?? currentStatus?.settings.engine ?? "web-speech";
    renderCapabilities(capsEl, familyCaps.get(family) ?? null);
    renderFamilyHint(familyEl, familyHint(family));
  }

  /** Status line + T17 error + transport buttons, from currentStatus. */
  function renderReader(): void {
    const s = currentStatus;
    if (s) {
      const fam = s.settings.engine;
      const famSuffix = fam && fam !== "web-speech" ? ` · ${fam}` : "";
      statusEl.textContent =
        s.state === "stopped"
          ? "no active session"
          : `${s.state} · sentence ${Math.min(s.tokenPos + 1, s.tokenCount)}/${s.tokenCount}${famSuffix}`;
      speedSelect.value = String(s.settings.rate);
    } else {
      statusEl.textContent = "no active session";
    }
    // T17 — surface engine failures instead of a silent pause.
    if (s?.lastError) {
      readerErrorEl.textContent = `engine error — ${s.lastError}`;
      readerErrorEl.hidden = false;
    } else {
      readerErrorEl.hidden = true;
      if (loading) statusEl.textContent = `${loading}…`;
    }
    const state = s?.state ?? "stopped";
    if (loading) {
      playBtn.disabled = true;
      playBtn.classList.add("loading");
      playBtn.setAttribute("aria-busy", "true");
      playBtn.setAttribute("aria-label", loading);
      playBtn.textContent = "";
      const spin = document.createElement("span");
      spin.className = "pp-spin";
      spin.setAttribute("aria-hidden", "true");
      playBtn.append(spin, `${loading}…`);
    } else {
      playBtn.disabled = false;
      playBtn.classList.remove("loading");
      playBtn.removeAttribute("aria-busy");
      playBtn.textContent = playLabel(state);
      playBtn.setAttribute("aria-label", playLabel(state));
    }
    stopBtn.disabled = state === "stopped";
    backBtn.disabled = !s || !canSeekBack(s);
    fwdBtn.disabled = !s || !canSeekForward(s);
  }

  /** Controls live in the popup only while the in-page bar is closed. */
  function applySurface(inPage: boolean): void {
    playbackControls.hidden = inPage;
  }

  async function refresh(): Promise<void> {
    const [statusReply, voicesReply, familiesReply] = await Promise.all([
      send({ type: "leia:reader:status" }),
      send({ type: "leia:reader:voices" }),
      send({ type: "leia:audio:families" }),
    ]);
    const status = (statusReply as RouterReply | undefined)?.data as SessionStatus | undefined;
    currentStatus = status ?? null;
    renderReader();

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

    voiceSelect.replaceChildren(new Option("(default voice)", ""));
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

  /** Apply a control reply's status locally — the popup gets no broadcast. */
  function applyReplyStatus(reply: RouterReply | undefined): void {
    const s = reply?.data as SessionStatus | undefined;
    if (s) {
      currentStatus = s;
      renderReader();
    }
  }

  playBtn.addEventListener("click", async () => {
    const action = playAction(currentStatus?.state ?? "stopped");
    const kind = loadingKindForAction(action);
    if (kind) beginLoading(kind);
    if (action === "start") {
      // Same as the old "Read selection in active tab": background captures
      // the active tab's selection (or page) itself.
      const reply = (await send({ type: "leia:reader:start" })) as RouterReply | undefined;
      if (reply?.ok) applyReplyStatus(reply);
      else {
        clearLoading();
        statusEl.textContent = `failed: ${String(reply?.error ?? "unknown")}`;
      }
      return;
    }
    const reply = (await send({ type: action === "pause" ? "leia:reader:pause" : "leia:reader:resume" })) as
      | RouterReply
      | undefined;
    if (reply && shouldClearLoading({ type: "reply", ok: reply.ok })) {
      clearLoading();
      if (!reply.ok) statusEl.textContent = `failed: ${String(reply.error ?? "unknown")}`;
      return;
    }
    applyReplyStatus(reply);
  });

  stopBtn.addEventListener("click", async () => {
    applyReplyStatus((await send({ type: "leia:reader:stop" })) as RouterReply | undefined);
  });

  backBtn.addEventListener("click", async () => {
    if (currentStatus && canSeekBack(currentStatus)) {
      applyReplyStatus(
        (await send({ type: "leia:reader:seek", token: prevToken(currentStatus.tokenPos) })) as RouterReply | undefined,
      );
    }
  });

  fwdBtn.addEventListener("click", async () => {
    if (currentStatus && canSeekForward(currentStatus)) {
      applyReplyStatus(
        (await send({ type: "leia:reader:seek", token: nextToken(currentStatus.tokenPos, currentStatus.tokenCount) })) as
          | RouterReply
          | undefined,
      );
    }
  });

  // Remount the in-page bar; it hides this section via the same flag.
  openInPageBtn.addEventListener("click", async () => {
    await browser.storage.local.set({ [CONTROLS_IN_PAGE_KEY]: true });
    applySurface(true);
  });

  void browser.storage.local.get(CONTROLS_IN_PAGE_KEY).then((got) => {
    applySurface(controlsInPage(got[CONTROLS_IN_PAGE_KEY]));
  });

  voiceSelect.addEventListener("change", () => {
    const voiceName = voiceSelect.value || null;
    // Background derives + pins the voice's family itself (self-heals a
    // restarted hub); the popup no longer guesses engines here.
    void send({ type: "leia:reader:prefs", voiceName });
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

  /** Live session signals mirrored from background (runtime.sendMessage). */
  function applyBroadcast(msg: RouterMessage): void {
    if (msg.type === "leia:highlight:set") {
      if (loading && shouldClearLoading({ type: "highlight" })) clearLoading();
      return;
    }
    if (msg.type === "leia:session:error") {
      if (loading && shouldClearLoading({ type: "error" })) clearLoading();
      return;
    }
    if (msg.type === "leia:session:state") {
      const s = (msg as unknown as { status: SessionStatus }).status;
      currentStatus = s;
      if (loading && shouldClearLoading({ type: "state", state: s.state })) clearLoading();
      renderReader();
    }
  }

  // The first highlight is the truthful "audio started" that ends the Play
  // pending state; state messages keep the transport fresh while open.
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (!isRouterMessage(msg)) return;
    applyBroadcast(msg);
  });

  void refresh();
  void initThemes();
  void initProviders();
}
