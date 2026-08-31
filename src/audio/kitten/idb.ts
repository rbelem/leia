// SPDX-License-Identifier: MPL-2.0
/**
 * Minimal IndexedDB asset store for the kitten-local model cache (ticket 06).
 * One object store ("assets"), keyed by `${url}#${byteLength}` (see
 * assets.ts/cacheKey). Deliberately tiny: open + range-get + put + range-delete
 * is all the worker needs. Browser-only code paths — covered indirectly by the
 * worker, unit-tested via the pure halves in assets.ts.
 */

import { cacheKey, cacheRange } from "./assets";

const DB_NAME = "leia-kitten-cache";
const STORE = "assets";

function openAssetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

interface AssetRecord {
  bytes: ArrayBuffer;
  cachedAt: number;
}

async function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/** Every cached record for one asset URL (any byte length), oldest first. */
export async function idbGetRecords(url: string): Promise<ArrayBuffer[]> {
  const db = await openAssetDb();
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const records = await requestToPromise(store.getAll(cacheRange(url)) as IDBRequest<AssetRecord[]>);
    return records.map((r) => r.bytes);
  } finally {
    db.close();
  }
}

export async function idbPutAsset(url: string, byteLength: number, bytes: ArrayBuffer): Promise<void> {
  const db = await openAssetDb();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await requestToPromise(store.put({ bytes, cachedAt: Date.now() } satisfies AssetRecord, cacheKey(url, byteLength)));
  } finally {
    db.close();
  }
}

/** Drop every cached record for one asset URL (corrupted cache recovery). */
export async function idbDeleteAsset(url: string): Promise<void> {
  const db = await openAssetDb();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await requestToPromise(store.delete(cacheRange(url)));
  } finally {
    db.close();
  }
}
