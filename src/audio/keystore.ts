// SPDX-License-Identifier: MPL-2.0
/**
 * In-memory provider-key snapshot for extension contexts without
 * chrome.storage (some Chrome builds — observed in flatpak Chrome 152 — give
 * offscreen documents no storage API even with the storage permission). The
 * service worker reads storage.local itself and rides a fresh snapshot on
 * every forwarded `leia:audio:*` message; the offscreen audio doc applies it
 * here and the engine getKey closures read from it. Keys live only in the
 * memory of the same extension — never persisted anywhere else.
 */

/** One custom local voice-server profile ({id,name,baseUrl} — see local-profiles.ts). */
export interface KeystoreProfile {
  id: string;
  name: string;
  baseUrl: string;
}

export interface KeystoreSnapshot {
  keys: Record<string, string>;
  localProfiles?: KeystoreProfile[];
}

let snapshot: KeystoreSnapshot = { keys: {} };

/**
 * Apply (part of) a snapshot. Defensive by design: invalid fields are
 * dropped and keep the previous value, so a malformed message can never
 * break the audio path. Messages without a snapshot simply don't call this.
 */
export function setSnapshot(s: Partial<KeystoreSnapshot> | null | undefined): void {
  if (typeof s !== "object" || s === null) return;
  if (typeof s.keys === "object" && s.keys !== null) {
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.keys)) {
      if (typeof v === "string" && v.length > 0) keys[k] = v;
    }
    snapshot.keys = keys;
  }
  if (Array.isArray(s.localProfiles)) {
    const profiles: KeystoreProfile[] = [];
    for (const entry of s.localProfiles) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, name, baseUrl } = entry as Partial<KeystoreProfile>;
      if (typeof id === "string" && id.length > 0 && typeof name === "string" && typeof baseUrl === "string" && baseUrl.length > 0) {
        profiles.push({ id, name, baseUrl });
      }
    }
    snapshot.localProfiles = profiles;
  }
}

/** Per-engine getKey closure (same signature as a storage.local getter). */
export function readProviderKey(storageKey: string): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    try {
      const v = snapshot.keys[storageKey];
      return typeof v === "string" && v.length > 0 ? v : null;
    } catch {
      /* v8 ignore next -- property read on a plain object cannot throw */
      return null;
    }
  };
}

/** Custom local-server profiles from the last applied snapshot (empty if none). */
export function snapshotLocalProfiles(): KeystoreProfile[] {
  try {
    return snapshot.localProfiles ? [...snapshot.localProfiles] : [];
  } catch {
    /* v8 ignore next -- array copy of a plain snapshot value cannot throw */
    return [];
  }
}
