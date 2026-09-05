// SPDX-License-Identifier: MPL-2.0
/**
 * Direct tests for the kitten IndexedDB asset store (src/audio/kitten/idb.ts)
 * — previously 0% (browser-only, only indirectly touched by the worker).
 * jsdom has no indexedDB, so a deterministic in-memory double implements the
 * one surface idb.ts uses: open (+upgrade), transaction → objectStore
 * getAll/put/delete, request onsuccess/onerror, db.close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey } from "../src/audio/kitten/assets";
import { idbDeleteAsset, idbGetRecords, idbPutAsset } from "../src/audio/kitten/idb";

// assets.cacheRange bounds keys via IDBKeyRange — jsdom lacks it; stub the
// one shape used (same approach as tests/engine-kitten.test.ts). Re-stubbed
// per test: afterEach's unstubAllGlobals would otherwise drop it.
const stubKeyRange = (): void => {
  vi.stubGlobal("IDBKeyRange", {
    bound: (lo: string, hi: string) => ({
      lower: lo,
      upper: hi,
      includes: (k: string) => k >= lo && k <= hi,
    }),
  });
};

interface AssetRecord {
  bytes: ArrayBuffer;
  cachedAt: number;
}

/** One IDBRequest double: result/error delivered async (microtask). */
class FakeRequest<T> {
  onsuccess: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  error: Error | null = null;
  result: T;
  constructor(result: T, private fail = false, requestError: Error | null = null) {
    this.result = result;
    queueMicrotask(() => {
      if (this.fail) {
        this.error = requestError;
        this.onerror?.();
      } else {
        this.onsuccess?.();
      }
    });
  }
}

class FakeDb {
  store = new Map<string, AssetRecord>();
  closed = 0;
  /** Make the open request fail (error === null exercises the fallback message). */
  failOpen = false;
  /** Make every store request fail. */
  failRequests = false;
  /** Concrete error object for the failing requests (null → fallback message). */
  requestError: Error | null = null;
  /** objectStoreNames at open time; start without the store to exercise the upgrade path. */
  hasStore = false;

  objectStoreNames = {
    contains: (): boolean => this.hasStore,
  };

  createObjectStore(name: string): unknown {
    expect(name).toBe("assets");
    this.hasStore = true;
    return {};
  }

  transaction(_name: string, _mode: "readonly" | "readwrite") {
    const db = this;
    return {
      objectStore() {
        return {
          getAll(range: { includes: (k: string) => boolean }) {
            const records = [...db.store.entries()]
              .filter(([k]) => range.includes(k))
              .map(([, v]) => v);
            return new FakeRequest(records, db.failRequests, db.requestError);
          },
          put(record: AssetRecord, key: string) {
            if (!db.failRequests) db.store.set(key, record);
            return new FakeRequest(key, db.failRequests, db.requestError);
          },
          delete(range: { includes: (k: string) => boolean }) {
            if (!db.failRequests) for (const k of [...db.store.keys()]) if (range.includes(k)) db.store.delete(k);
            return new FakeRequest(undefined, db.failRequests, db.requestError);
          },
        };
      },
    };
  }

  close(): void {
    this.closed += 1;
  }
}

interface OpenRequest {
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  error: Error | null;
  result: FakeDb;
}

let db: FakeDb;
let openCalls: number;

beforeEach(() => {
  stubKeyRange();
  db = new FakeDb();
  openCalls = 0;
  vi.stubGlobal("indexedDB", {
    open(_name: string, _version: number): OpenRequest {
      openCalls += 1;
      const req: OpenRequest = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        error: null,
        result: db,
      };
      queueMicrotask(() => {
        if (db.failOpen) {
          req.error = null; // exercises the `?? new Error(...)` fallback
          req.onerror?.();
          return;
        }
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_A = "https://assets.test/model.onnx";
const bytes = (n: number): ArrayBuffer => new Uint8Array(n).buffer;

describe("kitten idb asset store", () => {
  it("puts a record under url#byteLength and gets it back for that URL only", async () => {
    const buf = bytes(11);
    await idbPutAsset(URL_A, 11, buf);
    expect([...db.store.keys()]).toEqual([cacheKey(URL_A, 11)]);
    expect(db.store.get(cacheKey(URL_A, 11))!.bytes).toBe(buf);
    expect(typeof db.store.get(cacheKey(URL_A, 11))!.cachedAt).toBe("number");

    expect(await idbGetRecords(URL_A)).toEqual([buf]);
    expect(await idbGetRecords("https://assets.test/other.onnx")).toEqual([]);
  });

  it("keeps every byte-length variant of one URL, oldest first, and deletes them all", async () => {
    const b1 = bytes(1);
    const b2 = bytes(2);
    await idbPutAsset(URL_A, 1, b1);
    await idbPutAsset(URL_A, 2, b2);
    await idbPutAsset("https://assets.test/keep.onnx", 3, bytes(3));

    expect(await idbGetRecords(URL_A)).toEqual([b1, b2]);

    await idbDeleteAsset(URL_A);
    expect(await idbGetRecords(URL_A)).toEqual([]);
    expect(await idbGetRecords("https://assets.test/keep.onnx")).toHaveLength(1); // untouched
  });

  it("runs the upgrade path when the object store does not exist yet", async () => {
    expect(db.hasStore).toBe(false);
    await idbPutAsset(URL_A, 4, bytes(4));
    expect(db.hasStore).toBe(true); // onupgradeneeded created it
    // Second open sees the store — upgrade path skips createObjectStore.
    await idbGetRecords(URL_A);
    expect(openCalls).toBe(2);
  });

  it("closes the database after every operation, even when a request fails", async () => {
    await idbGetRecords(URL_A);
    await idbPutAsset(URL_A, 5, bytes(5));
    await idbDeleteAsset(URL_A);
    expect(db.closed).toBe(3);
  });

  it("rejects with the fallback message when the open request errors without one", async () => {
    db.failOpen = true;
    await expect(idbGetRecords(URL_A)).rejects.toThrow("indexedDB open failed");
    await expect(idbPutAsset(URL_A, 6, bytes(6))).rejects.toThrow("indexedDB open failed");
    expect(openCalls).toBe(2);
  });

  it("rejects when a store request errors (with and without a request error object)", async () => {
    db.hasStore = true; // skip upgrade so the failing request is getAll itself
    db.failRequests = true;
    await expect(idbGetRecords(URL_A)).rejects.toThrow("indexedDB request failed");
    await expect(idbPutAsset(URL_A, 7, bytes(7))).rejects.toThrow("indexedDB request failed");
    await expect(idbDeleteAsset(URL_A)).rejects.toThrow("indexedDB request failed");
    expect([...db.store.keys()]).toEqual([]); // put/delete rolled back

    db.requestError = new Error("quota exceeded");
    await expect(idbPutAsset(URL_A, 7, bytes(7))).rejects.toThrow("quota exceeded");
  });
});
