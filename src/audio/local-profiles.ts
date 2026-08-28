// SPDX-License-Identifier: MPL-2.0
/**
 * Local voice-server profiles (ADR-0006, T11). Pure-data profile model:
 * a profile is { id, name, baseUrl, install } — capability set is NEVER
 * stored, it is discovered by probing. Trust is loopback-only
 * (127.0.0.1 / ::1 / localhost), keyless, non-fatal health probing with a
 * 500 ms abort and a 30 s result TTL.
 */
import browser from "webextension-polyfill";

export interface LocalProfile {
  id: string;
  name: string;
  baseUrl: string;
  /** One-line docker/pip hint for the settings UI (built-ins only). */
  install?: string;
}

export interface LocalVoice {
  id: string;
  lang: string;
  name: string;
}

export interface LocalCapabilities {
  wordTiming: boolean;
  voices: LocalVoice[];
}

export interface ProbeResult {
  online: boolean;
  caps: LocalCapabilities;
}

/** Stock Kokoro-FastAPI docker port; the published image works unedited. */
export const BUILT_IN_PROFILES: LocalProfile[] = [
  {
    id: "kokoro",
    name: "Kokoro",
    baseUrl: "http://127.0.0.1:8880",
    install: "docker run --rm -p 8880:8880 ghcr.io/hexgrad/kokoro-fastapi",
  },
  {
    id: "piper",
    name: "Piper",
    baseUrl: "http://127.0.0.1:8881",
    install: "docker run --rm -p 8881:8881 your-piper-leia-shim",
  },
];

export const DEGRADED_CAPS: LocalCapabilities = {
  wordTiming: false,
  voices: [{ id: "default", lang: "en", name: "Default" }],
};

/** Custom profiles are stored here ({id,name,baseUrl}[] — no install, no caps). */
export const LOCAL_PROFILES_STORAGE_KEY = "leia:settings:localProfiles";

/** Narrow storage surface — browser.storage.local satisfies it; tests stub it. */
export interface LocalProfileStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const PROBE_ABORT_MS = 500;
const PROBE_TTL_MS = 30_000;

const probeCache = new Map<string, { at: number } & ProbeResult>();

/**
 * Loopback trust gate. Returns the normalized base URL (no path, no trailing
 * slash) or null when the host is not 127.0.0.1 / ::1 / localhost or the
 * scheme is not http. Never throws.
 */
export function validateBaseUrl(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  const rawHost = u.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") return null;
  return `${u.protocol}//${u.host}`;
}

/** Read stored custom profiles; entries failing shape/loopback checks are dropped. */
export async function readLocalProfiles(storage: LocalProfileStorage = browser.storage.local): Promise<LocalProfile[]> {
  try {
    const got = await storage.get(LOCAL_PROFILES_STORAGE_KEY);
    const v = got[LOCAL_PROFILES_STORAGE_KEY];
    if (!Array.isArray(v)) return [];
    const out: LocalProfile[] = [];
    for (const entry of v) {
      const profile = normalizeCustomProfile(entry);
      if (profile) out.push(profile);
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist custom profiles (install is a built-in-only hint; never stored). */
export async function writeLocalProfiles(
  profiles: LocalProfile[],
  storage: LocalProfileStorage = browser.storage.local,
): Promise<void> {
  await storage.set({
    [LOCAL_PROFILES_STORAGE_KEY]: profiles.map(({ id, name, baseUrl }) => ({ id, name, baseUrl })),
  });
}

/**
 * Probe one profile: GET {base}/leia/v1/health (500 ms abort) → caps probe
 * on success. 404/malformed caps or network failure degrade to defaults;
 * the probe itself never throws. Results are cached 30 s — stale entries
 * re-probe on the next call.
 */
export async function probeProfile(base: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const cached = probeCache.get(base);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return { online: cached.online, caps: cached.caps };
  }
  const result = await doProbe(base, fetchImpl);
  probeCache.set(base, { ...result, at: Date.now() });
  return result;
}

/** Force a cached online result to offline NOW (speak() network failure path). */
export function markProfileOffline(base: string): void {
  probeCache.set(base, { online: false, caps: DEGRADED_CAPS, at: Date.now() });
}

async function doProbe(base: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    const health = await fetchWithTimeout(`${base}/leia/v1/health`, fetchImpl);
    if (!health.ok) return { online: false, caps: DEGRADED_CAPS };
    let body: unknown = null;
    try {
      body = await health.json();
    } catch {
      return { online: false, caps: DEGRADED_CAPS }; // 200 with wrong body → offline
    }
    if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      return { online: false, caps: DEGRADED_CAPS };
    }
    return { online: true, caps: await probeCaps(base, fetchImpl) };
  } catch {
    return { online: false, caps: DEGRADED_CAPS }; // network reject / abort — non-fatal
  }
}

async function probeCaps(base: string, fetchImpl: typeof fetch): Promise<LocalCapabilities> {
  try {
    const resp = await fetchWithTimeout(`${base}/leia/v1/capabilities`, fetchImpl);
    if (resp.status === 404) return DEGRADED_CAPS;
    const data: unknown = await resp.json();
    return parseCaps(data);
  } catch {
    return DEGRADED_CAPS;
  }
}

function parseCaps(data: unknown): LocalCapabilities {
  if (typeof data !== "object" || data === null) return DEGRADED_CAPS;
  const d = data as { wordTiming?: unknown; voices?: unknown };
  if (!Array.isArray(d.voices)) return DEGRADED_CAPS;
  const voices: LocalVoice[] = [];
  for (const v of d.voices) {
    if (typeof v !== "object" || v === null) continue;
    const { id, lang, name } = v as { id?: unknown; lang?: unknown; name?: unknown };
    if (typeof id !== "string" || typeof lang !== "string") continue;
    voices.push({ id, lang, name: typeof name === "string" ? name : id });
  }
  if (voices.length === 0) return DEGRADED_CAPS; // no usable voices → synthetic default
  return { wordTiming: d.wordTiming === true, voices };
}

function normalizeCustomProfile(entry: unknown): LocalProfile | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { id, name, baseUrl } = entry as { id?: unknown; name?: unknown; baseUrl?: unknown };
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || typeof baseUrl !== "string") {
    return null;
  }
  const valid = validateBaseUrl(baseUrl);
  return valid ? { id, name, baseUrl: valid } : null;
}

async function fetchWithTimeout(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_ABORT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}