// SPDX-License-Identifier: MPL-2.0
/**
 * Settings-surface helpers for local voice-server profiles (ADR-0006).
 * Pure DOM builders + small pure helpers shared by the options page (full
 * management: built-in status rows, custom add/remove) and the popup
 * (footer summary, picker labels). Probing stays in local-profiles.ts —
 * these builders only render a ProbeResult they are handed.
 */
import { BUILT_IN_PROFILES, validateBaseUrl, type LocalProfile, type ProbeResult } from "../audio/local-profiles";

/** A row's probe state; null means the probe has not answered yet. */
export type ServerProbe = ProbeResult | null;

/** One-word status for a server row. */
export function serverStatusText(probe: ServerProbe): string {
  if (probe === null) return "checking…";
  return probe.online ? "online" : "offline";
}

/**
 * One server row: name + loopback address + probe status, the install hint
 * verbatim for built-ins, and a remove button when removable (customs).
 * Pure DOM — the options page wires remove and probes.
 */
export function buildServerRow(profile: LocalProfile, probe: ServerProbe, removable = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "provider server";
  row.dataset.server = profile.id;

  const head = document.createElement("div");
  head.className = "provider-head";
  const name = document.createElement("span");
  name.className = "provider-name";
  name.textContent = profile.name;
  const state = document.createElement("span");
  state.className = probe?.online ? "provider-state ok" : "provider-state";
  state.setAttribute("aria-live", "polite");
  state.textContent = serverStatusText(probe);
  head.append(name, state);

  const url = document.createElement("div");
  url.className = "server-url";
  url.textContent = profile.baseUrl;

  row.append(head, url);
  if (profile.install) {
    const hint = document.createElement("div");
    hint.className = "install-hint";
    // Focusable so the user-select:all command is copyable from the keyboard.
    hint.tabIndex = 0;
    hint.textContent = profile.install;
    row.append(hint);
  }
  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost remove";
    remove.textContent = "remove";
    remove.setAttribute("aria-label", `Remove ${profile.name}`);
    row.append(remove);
  }
  return row;
}

/** Update a row's probe state in place after a probe answers. */
export function setServerProbe(row: HTMLElement, probe: ServerProbe): void {
  const state = row.querySelector<HTMLElement>(".provider-state");
  if (!state) return;
  state.classList.toggle("ok", probe?.online === true);
  state.textContent = serverStatusText(probe);
}

export interface PresetFields {
  name: HTMLInputElement;
  url: HTMLInputElement;
  hint: HTMLElement;
}

/**
 * Fill the add-a-server form from a built-in preset — address plus the
 * install hint verbatim — or clear it back to a blank custom entry.
 */
export function applyPreset(profile: LocalProfile | null, fields: PresetFields): void {
  fields.name.value = profile?.name ?? "";
  fields.url.value = profile?.baseUrl ?? "";
  fields.hint.hidden = !profile?.install;
  fields.hint.textContent = profile?.install ?? "";
}

/** Storage id for a user-added server (its engine family is `local-<id>`). */
export function newCustomId(): string {
  return `custom-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Problem with a baseUrl entry, or null when it is usable. `existing` is the
 * normalized baseUrls already listed (built-ins + customs) — a duplicate
 * address would shadow the earlier profile.
 */
export function baseUrlProblem(raw: string, existing?: readonly string[]): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Enter the server's address.";
  const normalized = validateBaseUrl(trimmed);
  if (normalized === null) {
    return "Only http:// addresses on 127.0.0.1, ::1, or localhost can be used.";
  }
  if (existing?.includes(normalized)) return "This address is already listed.";
  return null;
}

/** One-glance footer line for the popup's Voice sources section. */
export function summarizeVoiceSources(savedKeys: number, onlineLocal: string[]): string {
  const keys = savedKeys === 0 ? "no API keys saved" : `${savedKeys} API key${savedKeys === 1 ? "" : "s"} saved`;
  const local = onlineLocal.length === 0 ? "no local servers online" : `${onlineLocal.join(", ")} online`;
  return `${keys} · ${local}`;
}

/**
 * Display name for a profile id: customs resolve via a caller-passed id →
 * name map (storage read), built-ins come from the catalog, unknown ids fall
 * back to the capitalized id.
 */
export function localProfileName(id: string, customNames?: ReadonlyMap<string, string>): string {
  const known = customNames?.get(id) ?? BUILT_IN_PROFILES.find((p) => p.id === id)?.name;
  return known ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Picker label for a local engine family: "local-kokoro" → "Kokoro (local)".
 * Returns null for non-local families.
 */
export function localFamilyLabel(family: string, customNames?: ReadonlyMap<string, string>): string | null {
  if (!family.startsWith("local-")) return null;
  return `${localProfileName(family.slice("local-".length), customNames)} (local)`;
}
