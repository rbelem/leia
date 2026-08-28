// SPDX-License-Identifier: MPL-2.0
/**
 * Per-URL reading-position store (T16/T17). Resume records live in
 * browser.storage.local (survives the transient storage.session backing the
 * single global ReaderSession) so a reader's position is preserved per
 * article, independent of which tab last owned the global session.
 *
 * Key: `leia:resume:` + encodeURIComponent(normalizedUrl), where the
 * normalized URL drops the fragment (not content) and a trailing slash
 * (`https://a/b/` === `https://a/b`) while keeping origin+path+query.
 *
 * The background is the only reader of this store (popup goes through a
 * relay), so the storage shape stays behind one module.
 */
import browser from "webextension-polyfill";
import type { SessionSettings, TokenText } from "../reader/session";

export interface ResumeRecord {
  tokens: TokenText[];
  tokenPos: number;
  settings: SessionSettings;
  updatedAt: number;
  /** Normalized URL the record is keyed by. */
  url: string;
}

export const RESUME_PREFIX = "leia:resume:";

// ponytail: fixed LRU cap; revisit if users keep 20+ concurrent articles.
const MAX_ENTRIES = 20;

/** storage.local surface resume.ts touches; injectable for tests. */
export interface StorageAreaLike {
  get(key?: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function resumeKey(url: string): string {
  return RESUME_PREFIX + encodeURIComponent(normalizeUrl(url));
}

export class ResumeStore {
  constructor(private readonly storage: StorageAreaLike = browser.storage.local) {}

  async save(url: string, record: Omit<ResumeRecord, "url" | "updatedAt">): Promise<void> {
    const normalized = normalizeUrl(url);
    const entry: ResumeRecord = { ...record, url: normalized, updatedAt: Date.now() };
    await this.storage.set({ [resumeKey(normalized)]: entry });
    // LRU cap: evict the oldest records past MAX_ENTRIES. Ties (same-ms
    // writes) evict in insertion order — Object.keys is stable for
    // non-numeric string keys and sort() is stable.
    const all = await this.storage.get();
    const keys = Object.keys(all).filter((k) => k.startsWith(RESUME_PREFIX));
    const excess = keys.length - MAX_ENTRIES;
    if (excess <= 0) return;
    const evict = keys
      .map((k) => ({ k, at: (all[k] as ResumeRecord).updatedAt }))
      .sort((a, b) => a.at - b.at)
      .slice(0, excess)
      .map((e) => e.k);
    await this.storage.remove(evict);
  }

  async load(url: string): Promise<ResumeRecord | null> {
    const key = resumeKey(url);
    const got = await this.storage.get(key);
    return (got[key] as ResumeRecord | undefined) ?? null;
  }

  async clear(url: string): Promise<void> {
    await this.storage.remove(resumeKey(url));
  }
}