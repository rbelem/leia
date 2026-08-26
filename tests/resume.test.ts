/**
 * T16 resume-store tests: per-URL save/load/clear over an in-memory
 * storage.local double, URL normalization (hash / trailing slash), and the
 * 20-entry LRU cap.
 */
import { describe, expect, it, vi } from "vitest";
import { ResumeStore, normalizeUrl, resumeKey, type StorageAreaLike } from "../src/background/resume";

// The store defaults to browser.storage.local; the polyfill import needs a
// stub even though every test injects an explicit MemoryArea.
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  },
}));

class MemoryArea implements StorageAreaLike {
  private map = new Map<string, unknown>();
  async get(key?: string | null): Promise<Record<string, unknown>> {
    if (key == null) return Object.fromEntries(this.map);
    return this.map.has(key) ? { [key]: this.map.get(key) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.map.set(k, v);
  }
  async remove(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

const TOKENS = ["First sentence.", "Second sentence."].map((text) => ({ text }));
const SETTINGS = { voiceName: "Zira", rate: 2, engine: null };

describe("ResumeStore", () => {
  it("round-trips save/load/clear", async () => {
    const store = new ResumeStore(new MemoryArea());
    await store.save("https://example.com/a", { tokens: TOKENS, tokenPos: 1, settings: SETTINGS });

    const rec = await store.load("https://example.com/a");
    expect(rec).toMatchObject({ url: "https://example.com/a", tokenPos: 1, tokens: TOKENS });
    expect(rec!.settings).toEqual(SETTINGS);
    expect(typeof rec!.updatedAt).toBe("number");

    await store.clear("https://example.com/a");
    expect(await store.load("https://example.com/a")).toBeNull();
  });

  it("loads null for an unknown URL", async () => {
    const store = new ResumeStore(new MemoryArea());
    expect(await store.load("https://example.com/nope")).toBeNull();
  });

  it("normalizes URLs: hash stripped, trailing slash dropped, query kept", () => {
    expect(normalizeUrl("https://example.com/path/?q=1#frag")).toBe("https://example.com/path?q=1");
    expect(normalizeUrl("https://example.com/path#frag")).toBe("https://example.com/path");
    // Root slash is the root path, not a trailing slash — kept.
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("keys are derived from the normalized URL (same key across equivalent URLs)", () => {
    expect(resumeKey("https://example.com/a/?x=1#top")).toBe(resumeKey("https://example.com/a?x=1"));
  });

  it("save under one spelling loads under another (hash/trailing slash)", async () => {
    const area = new MemoryArea();
    const store = new ResumeStore(area);
    await store.save("https://example.com/path/?q=1#frag", { tokens: TOKENS, tokenPos: 0, settings: SETTINGS });
    expect(await store.load("https://example.com/path?q=1")).not.toBeNull();
    // And the stored record carries the normalized URL.
    expect(area.keys()).toEqual([resumeKey("https://example.com/path?q=1")]);
  });

  it("evicts the oldest entries past the 20-entry cap, newest survives", async () => {
    const area = new MemoryArea();
    const store = new ResumeStore(area);
    for (let i = 1; i <= 21; i++) {
      await store.save(`https://example.com/a${i}`, { tokens: TOKENS, tokenPos: 0, settings: SETTINGS });
    }
    const resumeKeys = area.keys().filter((k) => k.startsWith("leia:resume:"));
    expect(resumeKeys).toHaveLength(20);
    expect(await store.load("https://example.com/a1")).toBeNull(); // oldest evicted
    expect(await store.load("https://example.com/a21")).not.toBeNull();
  });

  it("re-saving an existing URL refreshes it without growing past the cap", async () => {
    const area = new MemoryArea();
    const store = new ResumeStore(area);
    for (let i = 1; i <= 21; i++) {
      await store.save(`https://example.com/a${i}`, { tokens: TOKENS, tokenPos: i - 1, settings: SETTINGS });
    }
    await store.save("https://example.com/a21", { tokens: TOKENS, tokenPos: 99, settings: SETTINGS });
    expect((await store.load("https://example.com/a21"))!.tokenPos).toBe(99);
    expect(area.keys().filter((k) => k.startsWith("leia:resume:"))).toHaveLength(20);
  });
});