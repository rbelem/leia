// SPDX-License-Identifier: MPL-2.0
/**
 * Local voice-server profiles (ADR-0006, T11). Pure-data profile model:
 * a profile is { id, name, baseUrl, kind, model?, install } — capability set
 * is NEVER stored, it is discovered by probing. Trust is loopback-only
 * (127.0.0.1 / ::1 / localhost), keyless, non-fatal health probing with a
 * 500 ms abort and a 30 s result TTL.
 *
 * Two dialects:
 *  - "leia"   — the bespoke shim protocol (/leia/v1/health|capabilities|
 *               synthesize), implemented by the shims/ podman images.
 *  - "openai" — the OpenAI-compatible TTS API (/v1/models to probe,
 *               POST /v1/audio/speech to synthesize). This is what
 *               vLLM-Omni, LocalAI and Kokoro-FastAPI serve natively, so
 *               every open-weight TTS model those servers can host —
 *               VoxCPM2, Qwen3-TTS, Step Audio EditX, Voxtral TTS, … —
 *               plugs in without a shim.
 */
import browser from "webextension-polyfill";

export type LocalProfileKind = "leia" | "openai";

export interface LocalProfile {
  id: string;
  name: string;
  baseUrl: string;
  /** Wire dialect; defaults to "leia" for stored/custom entries. */
  kind?: LocalProfileKind;
  /** OpenAI-dialect `model` request field (vLLM validates it, LocalAI/Kokoro ignore it). */
  model?: string;
  /** One-line podman/pip hint for the settings UI (built-ins only). */
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

/**
 * Built-ins (ADR-0006, tickets 05/07): Kokoro-FastAPI works unedited on its
 * stock port; the piper/kittentts/neutts entries run the shims/ podman images
 * and their install hints mirror shims/README.md verbatim. edge proxies the
 * free Microsoft Edge Read-Aloud service — audio leaves the machine, so its
 * privacy class is provider despite being a local profile.
 *
 * The OpenAI-dialect entries (8885+) are served by vLLM-Omni's native
 * /v1/audio/speech — the highest-ranked open-weight models that ship a
 * standard server today (Elo per the Artificial Analysis Speech Arena,
 * September 2026). They are inert until the user starts the server.
 */
export const BUILT_IN_PROFILES: LocalProfile[] = [
  {
    id: "kokoro",
    name: "Kokoro",
    baseUrl: "http://127.0.0.1:8880",
    install: "podman run --rm -p 8880:8880 ghcr.io/hexgrad/kokoro-fastapi",
  },
  {
    id: "piper",
    name: "Piper",
    baseUrl: "http://127.0.0.1:8881",
    install: "podman run --rm -p 127.0.0.1:8881:8881 -v leia-shim-piper:/models leia-shim-piper",
  },
  {
    id: "kittentts",
    name: "Kittentts",
    baseUrl: "http://127.0.0.1:8882",
    install: "podman run --rm -p 127.0.0.1:8882:8882 -v leia-shim-kittentts:/root/.cache leia-shim-kittentts",
  },
  {
    id: "neutts",
    name: "Neutts",
    baseUrl: "http://127.0.0.1:8883",
    install: "podman run --rm -p 127.0.0.1:8883:8883 -e HF_TOKEN -v leia-shim-neutts:/root/.cache leia-shim-neutts",
  },
  {
    id: "edge",
    name: "Edge",
    baseUrl: "http://127.0.0.1:8884",
    install: "podman run --rm -p 127.0.0.1:8884:8884 leia-shim-edge",
  },
  {
    id: "voxcpm2",
    name: "VoxCPM2",
    baseUrl: "http://127.0.0.1:8885",
    kind: "openai",
    model: "openbmb/VoxCPM2",
    install: "vllm serve openbmb/VoxCPM2 --omni --port 8885",
  },
  {
    id: "qwen3-tts",
    name: "Qwen3 TTS",
    baseUrl: "http://127.0.0.1:8886",
    kind: "openai",
    model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    install: "vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --omni --port 8886",
  },
  {
    id: "step-audio-editx",
    name: "Step Audio EditX",
    baseUrl: "http://127.0.0.1:8887",
    kind: "openai",
    model: "stepfun-ai/Step-Audio-EditX",
    install: "vllm serve stepfun-ai/Step-Audio-EditX --omni --port 8887",
  },
  {
    id: "voxtral-tts",
    name: "Voxtral TTS",
    baseUrl: "http://127.0.0.1:8888",
    kind: "openai",
    model: "mistralai/Voxtral-4B-TTS-2603",
    install: "vllm serve mistralai/Voxtral-4B-TTS-2603 --omni --port 8888",
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
    [LOCAL_PROFILES_STORAGE_KEY]: profiles.map(({ id, name, baseUrl, kind, model }) => ({
      id,
      name,
      baseUrl,
      ...(kind === "openai" ? { kind, ...(model ? { model: model.trim() } : {}) } : {}),
    })),
  });
}

/**
 * Probe one profile: GET {base}/leia/v1/health (leia dialect) or
 * GET {base}/v1/models (openai dialect) with a 500 ms abort → caps probe on
 * success. 404/malformed caps or network failure degrade to defaults; the
 * probe itself never throws. Results are cached 30 s — stale entries
 * re-probe on the next call.
 */
export async function probeProfile(profile: LocalProfile, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const cached = probeCache.get(profile.baseUrl);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return { online: cached.online, caps: cached.caps };
  }
  const result = await doProbe(profile, fetchImpl);
  probeCache.set(profile.baseUrl, { ...result, at: Date.now() });
  return result;
}

/** Force a cached online result to offline NOW (speak() network failure path). */
export function markProfileOffline(base: string): void {
  probeCache.set(base, { online: false, caps: DEGRADED_CAPS, at: Date.now() });
}

async function doProbe(profile: LocalProfile, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const base = profile.baseUrl;
  try {
    const healthUrl = profile.kind === "openai" ? `${base}/v1/models` : `${base}/leia/v1/health`;
    const health = await fetchWithTimeout(healthUrl, fetchImpl);
    if (!health.ok) return { online: false, caps: DEGRADED_CAPS };
    let body: unknown = null;
    try {
      body = await health.json();
    } catch {
      return { online: false, caps: DEGRADED_CAPS }; // 200 with wrong body → offline
    }
    if (profile.kind === "openai") {
      // OpenAI /v1/models → { data: [{id, …}] }; anything else is not a
      // speaking OpenAI-compatible server.
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { online: false, caps: DEGRADED_CAPS };
      return { online: true, caps: await probeOpenAiCaps(base, fetchImpl) };
    }
    if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      return { online: false, caps: DEGRADED_CAPS };
    }
    return { online: true, caps: await probeCaps(base, fetchImpl) };
  } catch {
    return { online: false, caps: DEGRADED_CAPS }; // network reject / abort — non-fatal
  }
}

/**
 * OpenAI-dialect voices: GET {base}/v1/audio/voices — Kokoro-FastAPI answers
 * `{voices: ["af_heart", …]}`; vLLM-Omni and most single-model servers 404,
 * which degrades to the synthetic default voice. Word timing never comes
 * from the OpenAI speech API, so it is always false here.
 */
async function probeOpenAiCaps(base: string, fetchImpl: typeof fetch): Promise<LocalCapabilities> {
  try {
    const resp = await fetchWithTimeout(`${base}/v1/audio/voices`, fetchImpl);
    if (!resp.ok) return DEGRADED_CAPS;
    const data: unknown = await resp.json();
    const raw = (data as { voices?: unknown } | null)?.voices;
    if (!Array.isArray(raw)) return DEGRADED_CAPS;
    const voices: LocalVoice[] = [];
    for (const v of raw) {
      if (typeof v === "string" && v.length > 0) voices.push({ id: v, lang: "en", name: v });
    }
    if (voices.length === 0) return DEGRADED_CAPS;
    return { wordTiming: false, voices };
  } catch {
    return DEGRADED_CAPS;
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
  const { id, name, baseUrl, kind, model } = entry as {
    id?: unknown;
    name?: unknown;
    baseUrl?: unknown;
    kind?: unknown;
    model?: unknown;
  };
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || typeof baseUrl !== "string") {
    return null;
  }
  const valid = validateBaseUrl(baseUrl);
  if (!valid) return null;
  if (kind === "openai") {
    return {
      id,
      name,
      baseUrl: valid,
      kind,
      ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
    };
  }
  return { id, name, baseUrl: valid };
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