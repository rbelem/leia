// SPDX-License-Identifier: MPL-2.0
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
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9001" }, fetchImpl);
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
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9002" }, routedFetch(() => jsonResponse({}), () => {
      throw new Error("caps must not be probed");
    }, []));
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health non-200 → offline without a caps probe", async () => {
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9004" }, routedFetch(() => jsonResponse({ ok: true }, 500), () => {
      throw new Error("caps must not be probed");
    }, []));
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health timeout (500ms abort) → offline", async () => {
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const p = probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9003" }, hangingFetch);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("health fetch network reject → offline, never throws", async () => {
    const rejectingFetch = (async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9005" }, rejectingFetch);
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("caps 404 → online with degraded defaults (sentence granularity)", async () => {
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9006" }, routedFetch(HEALTH_OK, () => jsonResponse({ error: "nope" }, 404), []));
    expect(r).toEqual({ online: true, caps: DEGRADED_CAPS });
  });

  it("caps malformed (200 non-JSON) → degraded defaults", async () => {
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9007" }, routedFetch(HEALTH_OK, () => rawResponse("server hiccup"), []));
    expect(r).toEqual({ online: true, caps: DEGRADED_CAPS });
  });

  it("caps with no usable voices → degraded defaults", async () => {
    const empty = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9008" }, routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [] }), []));
    expect(empty).toEqual({ online: true, caps: DEGRADED_CAPS });
    const junk = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9009" }, routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [{ id: 42, lang: "en" }] }), []));
    expect(junk).toEqual({ online: true, caps: DEGRADED_CAPS });
    const partial = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9012" }, routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: [{ id: "a", lang: "en" }] }), []));
    expect(partial).toEqual({ online: true, caps: { wordTiming: true, voices: [{ id: "a", lang: "en", name: "a" }] } }); // name falls back to id
  });

  it("parses caps voices with missing names (name → id) and wordTiming non-boolean → false", async () => {
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9013" }, routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: "yes", voices: [{ id: "a", lang: "en", name: "A" }] }), []));
    expect(r).toEqual({ online: true, caps: { wordTiming: false, voices: [{ id: "a", lang: "en", name: "A" }] } });
  });

  it("caches results with a 30s TTL and re-probes when stale", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = routedFetch(HEALTH_OK, CAPS_FULL, calls);
    const base = "http://127.0.0.1:9010";

    await probeProfile({ id: "t", name: "T", baseUrl: base }, fetchImpl);
    expect(calls).toHaveLength(2);
    await probeProfile({ id: "t", name: "T", baseUrl: base }, fetchImpl); // fresh cache — no fetches
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(31_000);
    await probeProfile({ id: "t", name: "T", baseUrl: base }, fetchImpl); // stale → re-probe
    expect(calls).toHaveLength(4);
  });

  it("markProfileOffline pins an online profile to offline without a fetch", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = routedFetch(HEALTH_OK, CAPS_FULL, calls);
    const base = "http://127.0.0.1:9011";
    expect(await probeProfile({ id: "t", name: "T", baseUrl: base }, fetchImpl)).toMatchObject({ online: true });

    markProfileOffline(base);
    expect(await probeProfile({ id: "t", name: "T", baseUrl: base }, fetchImpl)).toEqual({ online: false, caps: DEGRADED_CAPS });
    expect(calls).toHaveLength(2); // cache served the offline result
  });

  // --- error-path gap coverage (doProbe L169 / probeCaps L186-187 / parseCaps L192-202) ---

  it("health 200 whose json() throws → offline, caps never probed", async () => {
    const throwingJson = (): Response =>
      ({ ok: true, status: 200, json: async () => { throw new Error("body stream reset"); } } as unknown as Response);
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9101" },
      routedFetch(throwingJson, () => { throw new Error("caps must not be probed"); }, []),
    );
    expect(r).toEqual({ online: false, caps: DEGRADED_CAPS }); // probe never throws
  });

  it("caps fetch network reject → still online with degraded defaults, never throws", async () => {
    // Health succeeded, so the profile is reachable; the caps probe failing
    // degrades capabilities without flipping online off.
    const r = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9102" },
      routedFetch(HEALTH_OK, () => Promise.reject(new Error("ECONNRESET")), []),
    );
    expect(r).toEqual({ online: true, caps: DEGRADED_CAPS });
  });

  it("caps 200 with non-object / voices-not-array / non-object-entry bodies → degraded defaults", async () => {
    const scalar = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9103" },
      routedFetch(HEALTH_OK, () => jsonResponse("nope"), []),
    );
    expect(scalar).toEqual({ online: true, caps: DEGRADED_CAPS }); // parseCaps: non-object

    const nonArray = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9104" },
      routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: { a: 1 } }), []),
    );
    expect(nonArray).toEqual({ online: true, caps: DEGRADED_CAPS }); // parseCaps: voices not an array

    const garbageEntries = await probeProfile({ id: "t", name: "T", baseUrl: "http://127.0.0.1:9105" },
      routedFetch(HEALTH_OK, () => jsonResponse({ wordTiming: true, voices: ["garbage", null] }), []),
    );
    expect(garbageEntries).toEqual({ online: true, caps: DEGRADED_CAPS }); // entries skipped → 0 voices
  });
});

describe("probeProfile — openai dialect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Routed stub for the OpenAI dialect: /v1/models then /v1/audio/voices. */
  function openAiFetch(
    models: () => Response | Promise<Response>,
    voices: () => Response | Promise<Response>,
    calls: Array<{ url: string }> = [],
  ): typeof fetch {
    return (async (url: string): Promise<Response> => {
      calls.push({ url });
      if (url.endsWith("/v1/models")) return models();
      if (url.endsWith("/v1/audio/voices")) return voices();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  /** Unique port per test — probe results are cached by baseUrl for 30 s. */
  function voxProfileAt(port: number): LocalProfile {
    return { id: "vox", name: "Vox", baseUrl: `http://127.0.0.1:${port}`, kind: "openai", model: "openbmb/VoxCPM2" };
  }

  it("models OK + voice list → online, string voices parsed, wordTiming false", async () => {
    const calls: Array<{ url: string }> = [];
    const r = await probeProfile(
      voxProfileAt(9201),
      openAiFetch(
        () => jsonResponse({ object: "list", data: [{ id: "openbmb/VoxCPM2" }] }),
        () => jsonResponse({ voices: ["female", "male"] }),
        calls,
      ),
    );
    expect(r.online).toBe(true);
    expect(r.caps).toEqual({
      wordTiming: false,
      voices: [
        { id: "female", lang: "en", name: "female" },
        { id: "male", lang: "en", name: "male" },
      ],
    });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:9201/v1/models", "http://127.0.0.1:9201/v1/audio/voices"]);
  });

  it("models 404 / non-array data / network failure → offline, degraded caps", async () => {
    const notFound = await probeProfile(
      voxProfileAt(9202),
      openAiFetch(() => jsonResponse({}, 404), () => jsonResponse({ voices: [] })),
    );
    expect(notFound).toEqual({ online: false, caps: DEGRADED_CAPS });

    const wrongShape = await probeProfile(
      voxProfileAt(9203),
      openAiFetch(() => jsonResponse({ data: "nope" }), () => jsonResponse({})),
    );
    expect(wrongShape).toEqual({ online: false, caps: DEGRADED_CAPS });

    const rejecting = (async (): Promise<Response> => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    const netFail = await probeProfile(voxProfileAt(9204), rejecting);
    expect(netFail).toEqual({ online: false, caps: DEGRADED_CAPS });
  });

  it("voices endpoint 404 or junk → online with degraded default voice", async () => {
    const noVoices = await probeProfile(
      voxProfileAt(9205),
      openAiFetch(() => jsonResponse({ data: [{ id: "m" }] }), () => jsonResponse({}, 404)),
    );
    expect(noVoices).toEqual({ online: true, caps: DEGRADED_CAPS });

    const junkVoices = await probeProfile(
      voxProfileAt(9206),
      openAiFetch(() => jsonResponse({ data: [{ id: "m" }] }), () => jsonResponse({ voices: [42, null, ""] })),
    );
    expect(junkVoices).toEqual({ online: true, caps: DEGRADED_CAPS });
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
  it("BUILT_IN_PROFILES are the five ADR-0006 shims plus the four OpenAI-dialect open-weight servers", () => {
    expect(BUILT_IN_PROFILES).toEqual([
      { id: "kokoro", name: "Kokoro", baseUrl: "http://127.0.0.1:8880", install: expect.any(String) },
      { id: "piper", name: "Piper", baseUrl: "http://127.0.0.1:8881", install: expect.any(String) },
      { id: "kittentts", name: "Kittentts", baseUrl: "http://127.0.0.1:8882", install: expect.any(String) },
      { id: "neutts", name: "Neutts", baseUrl: "http://127.0.0.1:8883", install: expect.any(String) },
      { id: "edge", name: "Edge", baseUrl: "http://127.0.0.1:8884", install: expect.any(String) },
      { id: "voxcpm2", name: "VoxCPM2", baseUrl: "http://127.0.0.1:8885", kind: "openai", model: "openbmb/VoxCPM2", install: expect.any(String) },
      { id: "qwen3-tts", name: "Qwen3 TTS", baseUrl: "http://127.0.0.1:8886", kind: "openai", model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", install: expect.any(String) },
      { id: "step-audio-editx", name: "Step Audio EditX", baseUrl: "http://127.0.0.1:8887", kind: "openai", model: "stepfun-ai/Step-Audio-EditX", install: expect.any(String) },
      { id: "voxtral-tts", name: "Voxtral TTS", baseUrl: "http://127.0.0.1:8888", kind: "openai", model: "mistralai/Voxtral-4B-TTS-2603", install: expect.any(String) },
    ]);
  });

  it("shim built-ins use podman; OpenAI-dialect built-ins use vllm serve with their model id", () => {
    const byId = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));
    for (const id of ["kokoro", "piper", "kittentts", "neutts", "edge"]) {
      expect(byId.get(id)?.install).toContain("podman");
    }
    for (const p of BUILT_IN_PROFILES.filter((x) => x.kind === "openai")) {
      expect(p.install).toContain(`vllm serve ${p.model}`);
      expect(p.install).toContain(p.baseUrl.split(":").pop()!);
    }
  });

  it("shim built-ins carry the exact podman run lines from shims/README.md", () => {
    const byId = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));
    expect(byId.get("piper")?.install).toBe(
      "podman run --rm -p 127.0.0.1:8881:8881 -v leia-shim-piper:/models leia-shim-piper",
    );
    expect(byId.get("kittentts")?.install).toBe(
      "podman run --rm -p 127.0.0.1:8882:8882 -v leia-shim-kittentts:/root/.cache leia-shim-kittentts",
    );
    expect(byId.get("neutts")?.install).toBe(
      "podman run --rm -p 127.0.0.1:8883:8883 -e HF_TOKEN -v leia-shim-neutts:/root/.cache leia-shim-neutts",
    );
    expect(byId.get("edge")?.install).toBe("podman run --rm -p 127.0.0.1:8884:8884 leia-shim-edge");
    // shim hints: host-side port matches the profile's baseUrl port
    // (kokoro is the stock published image — no host bind prefix — and the
    // OpenAI-dialect entries use `vllm serve --port`, so both are excluded)
    for (const p of BUILT_IN_PROFILES.filter((x) => x.id !== "kokoro" && x.kind !== "openai")) {
      const port = new URL(p.baseUrl).port;
      expect(p.install, p.id).toMatch(new RegExp(`-p [^ ]*:${port}:${port} `));
    }
  });

  it("shim built-in baseUrls pass loopback validation", () => {
    for (const p of BUILT_IN_PROFILES) expect(validateBaseUrl(p.baseUrl)).toBe(p.baseUrl);
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

  it("OpenAI-dialect customs persist kind and model; leia customs persist neither", async () => {
    const storage = memoryStorage();
    const custom: LocalProfile[] = [
      { id: "vox", name: "Vox", baseUrl: "http://127.0.0.1:9000", kind: "openai", model: " openbmb/VoxCPM2 " },
      { id: "nomodel", name: "No Model", baseUrl: "http://127.0.0.1:9001", kind: "openai" },
      { id: "shim", name: "Shim", baseUrl: "http://127.0.0.1:9002", kind: "leia" },
    ];
    await writeLocalProfiles(custom, storage);
    expect(storage.data.get(LOCAL_PROFILES_STORAGE_KEY)).toEqual([
      { id: "vox", name: "Vox", baseUrl: "http://127.0.0.1:9000", kind: "openai", model: "openbmb/VoxCPM2" },
      { id: "nomodel", name: "No Model", baseUrl: "http://127.0.0.1:9001", kind: "openai" },
      { id: "shim", name: "Shim", baseUrl: "http://127.0.0.1:9002" },
    ]);
    expect(await readLocalProfiles(storage)).toEqual([
      { id: "vox", name: "Vox", baseUrl: "http://127.0.0.1:9000", kind: "openai", model: "openbmb/VoxCPM2" },
      { id: "nomodel", name: "No Model", baseUrl: "http://127.0.0.1:9001", kind: "openai" },
      { id: "shim", name: "Shim", baseUrl: "http://127.0.0.1:9002" },
    ]);
  });

  it("read keeps OpenAI-dialect entries and drops junk model fields", async () => {
    const storage = memoryStorage();
    storage.data.set(LOCAL_PROFILES_STORAGE_KEY, [
      { id: "vox", name: "Vox", baseUrl: "http://127.0.0.1:9010", kind: "openai", model: "m/v1" },
      { id: "badmodel", name: "BadModel", baseUrl: "http://127.0.0.1:9011", kind: "openai", model: 42 },
      { id: "badkind", name: "BadKind", baseUrl: "http://127.0.0.1:9012", kind: "grpc" },
    ]);
    expect(await readLocalProfiles(storage)).toEqual([
      { id: "vox", name: "Vox", baseUrl: "http://127.0.0.1:9010", kind: "openai", model: "m/v1" },
      { id: "badmodel", name: "BadModel", baseUrl: "http://127.0.0.1:9011", kind: "openai" },
      { id: "badkind", name: "BadKind", baseUrl: "http://127.0.0.1:9012" },
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