import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_PROFILES,
  DEGRADED_CAPS,
  LOCAL_PROFILES_STORAGE_KEY,
  type LocalProfile,
  type LocalProfileStorage,
  markProfileOffline,
  probeProfile,
  readLocalProfiles,
  validateBaseUrl,
  writeLocalProfiles,
} from "../src/audio/local-profiles";

// local-profiles imports the polyfill; storage is stubbed per test, but the
// module must load in node (mirrors settings.test.ts).
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
    },
  },
}));

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function rawResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError(`not json: ${body}`);
    },
    text: async () => body,
  } as unknown as Response;
}

const HEALTH_OK = (): Response => jsonResponse({ ok: true });
const CAPS_FULL = (): Response => jsonResponse({
  wordTiming: true,
  streaming: false,
  voices: [{ id: "v1", lang: "en", name: "V1" }],
  maxChars: 2500,
  formats: ["wav", "mp3"],
});

/** Single routed fetch stub: health/caps handlers chosen by path. */
function routedFetch(
  health: () => Response | Promise<Response>,
  caps: () => Response | Promise<Response>,
  calls: Array<{ url: string }>,
): typeof fetch {
  return (async (url: string): Promise<Response> => {
    calls.push({ url });
    if (url.endsWith("/leia/v1/health")) return health();
    if (url.endsWith("/leia/v1/capabilities")) return caps();
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("probeProfile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("health ok + full caps → online with parsed capabilities", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = routedFetch(HEALTH_OK, CAPS_FULL, calls);
    const r = await probeProfile("http://127.0.0.1:9001", fetchImpl);
    expect(r).toEqual({
      online: true,
      caps: { wordTiming: true, voices: [{ id: "v1", lang: "en", name: "V1" }] },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:9001/leia/v1/health",
      "http://127.0.0.1:9001/leia/v1/capabilities",
    ]);
  });

  it("health 200 with wrong body → offline", async () => {
    const r = await probeProfile("http://127.0.0.1:9002", routedFetch(() => jsonResponse({}), () => {
      throw new Error("caps must not be probed");
    }, []));
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health non-200 → offline without a caps probe", async () => {
    const r = await probeProfile("http://127.0.0.1:9004", routedFetch(() => jsonResponse({ ok: true }, 500), () => {
      throw new Error("caps must not be probed");
    }, []));
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health timeout (500ms abort) → offline", async () => {
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const p = probeProfile("http://127.0.0.1:9003", hangingFetch);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health fetch network reject → offline, never throws", async () => {
    const rejectingFetch = (async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await probeProfile("http://127.0.0.1:9005", rejectingFetch);
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("caps 404 → online with degraded defaults (sentence granularity)", async () => {
    const r = await probeProfile("http://127.0.0.1:9006", routedFetch(HEALTH_OK, () => jsonResponse({ error: "nope" }, 404), []));
    expect(r).toEqual({ online: true, caps: DEGRADED_CAPS });
  });

  it("caps malformed (200 non-JSON) → degraded defaults", async () => {
    const r = await probeProfile("http://127.0.0.1:9007", routedFetch(HEALTH_OK, () => rawResponse("server hiccup"), []));
    expect(r).toEqual({ online: true, caps: DEGRADED_CAPS });
  });

  it("caps with no usable voices → degraded defaults", async () => {
    const empty = await probeProfile("http://127.0.0.1:9008", routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [] }), []));
    expect(empty).toEqual({ online: true, caps: DEGRADED_CAPS });
    const junk = await probeProfile("http://127.0.0.1:9009", routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [{ id: 42, lang: "en" }] }), []));
    expect(junk).toEqual({ online: true, caps: DEGRADED_CAPS });
    const partial = await probeProfile("http://127.0.0.1:9012", routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [{ id: "a", lang: "en" }] }), []));
    expect(partial).toEqual({ online: true, caps: { wordTiming: true, voices: [{ id: "a", lang: "en", name: "a" }] } }); // name falls back to id
  });

  it("parses caps voices with missing names (name → id) and wordTiming non-boolean → false", async () => {
    const r = await probeProfile("http://127.0.0.1:9013", routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: "yes", voices: [{ id: "a", lang: "en", name: "A" }] }), []));
    expect(r).toEqual({ online: true, caps: { wordTiming: false, voices: [{ id: "a", lang: "en", name: "A" }] } });
  });

  it("caches results with a 30s TTL and re-probes when stale", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = routedFetch(HEALTH_OK, CAPS_FULL, calls);
    const base = "http://127.0.0.1:9010";

    await probeProfile(base, fetchImpl);
    expect(calls).toHaveLength(2);
    await probeProfile(base, fetchImpl); // fresh cache — no fetches
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(31_000);
    await probeProfile(base, fetchImpl); // stale → re-probe
    expect(calls).toHaveLength(4);
  });

  it("markProfileOffline pins an online profile to offline without a fetch", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = routedFetch(HEALTH_OK, CAPS_FULL, calls);
    const base = "http://127.0.0.1:9011";
    expect(await probeProfile(base, fetchImpl)).toMatchObject({ online: true });

    markProfileOffline(base);
    expect(await probeProfile(base, fetchImpl)).toEqual({ online: false, caps: DEGRADED_CAPS });
    expect(calls).toHaveLength(2); // cache served the offline result
  });
});

describe("validateBaseUrl", () => {
  it("accepts loopback hosts and normalizes (no path, no trailing slash)", () => {
    expect(validateBaseUrl("http://127.0.0.1:8880")).toBe("http://127.0.0.1:8880");
    expect(validateBaseUrl("http://127.0.0.1")).toBe("http://127.0.0.1");
    expect(validateBaseUrl("http://[::1]:8880")).toBe("http://[::1]:8880");
    expect(validateBaseUrl("http://localhost:8882")).toBe("http://localhost:8882");
    expect(validateBaseUrl("http://LOCALHOST:8080")).toBe("http://localhost:8080");
    expect(validateBaseUrl("http://127.0.0.1:8880/leia/v1/")).toBe("http://127.0.0.1:8880");
  });

  it("rejects non-loopback hosts, non-http schemes, and garbage", () => {
    for (const bad of [
      "https://example.com",
      "http://192.168.1.5",
      "http://10.0.0.1:8880",
      "https://127.0.0.1:8443", // https loopback — manifest grants http loopback only
      "ftp://127.0.0.1:21",
      "http://127.0.0.1.evil.com/",
      "http://localhost.evil.com/",
      "not a url",
      "",
    ]) {
      expect(validateBaseUrl(bad), bad).toBeNull();
    }
  });
});

describe("built-in profiles + storage", () => {
  it("BUILT_IN_PROFILES are the ADR-0006 kokoro/piper entries with install hints", () => {
    expect(BUILT_IN_PROFILES).toEqual([
      { id: "kokoro", name: "Kokoro", baseUrl: "http://127.0.0.1:8880", install: expect.any(String) },
      { id: "piper", name: "Piper", baseUrl: "http://127.0.0.1:8881", install: expect.any(String) },
    ]);
    for (const p of BUILT_IN_PROFILES) expect(p.install).toContain("docker");
  });

  it("custom profiles round-trip through storage (install is never persisted)", async () => {
    const storage = memoryStorage();
    const custom: LocalProfile[] = [
      { id: "mybox", name: "My Box", baseUrl: "http://localhost:9000/", install: "n/a" },
      { id: "mac", name: "Mac Mini", baseUrl: "http://127.0.0.1:9001" },
    ];
    await writeLocalProfiles(custom, storage);
    expect(storage.data.get(LOCAL_PROFILES_STORAGE_KEY)).toEqual([
      { id: "mybox", name: "My Box", baseUrl: "http://localhost:9000/" },
      { id: "mac", name: "Mac Mini", baseUrl: "http://127.0.0.1:9001" },
    ]);
    expect(await readLocalProfiles(storage)).toEqual([
      { id: "mybox", name: "My Box", baseUrl: "http://localhost:9000" }, // normalized on read
      { id: "mac", name: "Mac Mini", baseUrl: "http://127.0.0.1:9001" },
    ]);
  });

  it("read drops entries that fail shape or loopback checks", async () => {
    const storage = memoryStorage();
    storage.data.set(LOCAL_PROFILES_STORAGE_KEY, [
      { id: "ok", name: "OK", baseUrl: "http://127.0.0.1:9002" },
      { id: "evil", name: "Evil", baseUrl: "http://192.168.1.5:9002" },
      { id: "bad", name: "Bad", baseUrl: "not a url" },
      { id: "noname", baseUrl: "http://127.0.0.1:9003" },
      "garbage",
    ]);
    expect(await readLocalProfiles(storage)).toEqual([{ id: "ok", name: "OK", baseUrl: "http://127.0.0.1:9002" }]);
  });

  it("read tolerates missing/unreadable storage", async () => {
    expect(await readLocalProfiles(memoryStorage())).toEqual([]);
    const broken: LocalProfileStorage = {
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {},
    };
    expect(await readLocalProfiles(broken)).toEqual([]);
  });
});

function memoryStorage(): LocalProfileStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string): Promise<Record<string, unknown>> =>
      Object.fromEntries([...data].filter(([k]) => k === key)),
    set: async (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
  };
}