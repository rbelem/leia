// SPDX-License-Identifier: MPL-2.0
/**
 * Real-path permission-grant e2e (issue #22): CDP drives the options-page
 * Save (trusted gesture), cua-driver clicks the NATIVE Allow bubble over
 * AT-SPI, ground truth is chrome.permissions.contains === true AND the key
 * persisted to chrome.storage.local — never "click returned 0" (council §3).
 *
 * Arming (council §7): LEIA_E2E=1. Unarmed local runs skip loudly; an armed
 * run hard-fails on env problems (CuaUnavailableError) — never a silent skip,
 * never a bare timeout. CI contract:
 *   xvfb-run -a dbus-run-session -- bash -c 'LEIA_E2E=1 npm run test:e2e'
 * (docs/cua-e2e.md carries the rationale + package checklist).
 *
 * Isolation: own throwaway chromium on LEIA_E2E_PORT (default 9226 — never
 * :9224/:9333, the shared dev stack), fresh profile per run (a previously
 * granted origin never re-prompts, so the bubble would never appear). The
 * test passes --force-renderer-accessibility itself: it must not depend on
 * the cli/chrome.js guard being patched (design §3.2). Teardown kills the
 * whole spawn'd process group — a half-dead chromium leaves at-spi children
 * behind (spike hazard #3).
 *
 * Failure taxonomy (council §3/§6, docs/cua-e2e.md §taxonomy):
 *   CuaUnavailable        env (recipe/registry) -> loud skip locally / red in CI
 *   BubbleNeverAppeared   timing / product      -> one wholesale retry, then red
 *   StaleTokenExhausted   env flake             -> adapter absorbs, then red
 *   ClickedNotGranted     PRODUCT BUG           -> red immediately, never retried
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BubbleNeverAppearedError,
  ClickedNotGrantedError,
  StaleTokenExhaustedError,
  clickAllow,
  endSession,
  ensureCuaRecipe,
  observeBubbleWindow,
  smokeProbe,
} from "./cua.mjs";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const ARMED = process.env.LEIA_E2E === "1";
const REPO = new URL("../..", import.meta.url).pathname;
const E2E_PORT = Number(process.env.LEIA_E2E_PORT ?? 9226);
const OPENAI_ORIGIN = "https://api.openai.com/*";
const KEY_STORAGE = "leia:settings:openaiKey";
const WHOLESALE_RETRIES = 1; // council: observe->click->verify retried at most once

if (!ARMED) {
  console.log(
    "[permission-grant.e2e] SKIPPED — native permission e2e is disarmed. To run it on a desktop with " +
      "chromium + cua-driver 0.33.x + at-spi2-core on a session bus: `LEIA_E2E=1 npm run test:e2e`. " +
      "See docs/cua-e2e.md (recipe, one-bus rule, CI contract).",
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** One CDP socket with its own sequence counter. */
function makeCdp(ws) {
  let seq = 0;
  return function send(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const on = (data) => {
        const m = JSON.parse(data.toString());
        if (m.id === id) {
          ws.off("message", on);
          m.error ? reject(new Error(`CDP ${method}: ${m.error.message}`)) : resolve(m.result);
        }
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${E2E_PORT}/json`);
  return res.json();
}

async function openTab(url) {
  const res = await fetch(`http://127.0.0.1:${E2E_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}

async function discoverExtensionId() {
  for (let i = 0; i < 40; i++) {
    const sw = (await targets()).find(
      (t) => t.type === "service_worker" && t.url?.endsWith("/background/index.js"),
    );
    if (sw) return new URL(sw.url).hostname;
    await sleep(250);
  }
  throw new Error("leia service worker target never appeared — was dist/chrome loaded? see docs/cua-e2e.md");
}

/** The MV3 service worker goes dormant; a runtime ping wakes it, then its /json target reappears. */
async function serviceWorkerSocket(pageSend) {
  await pageSend("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((res) => chrome.runtime.sendMessage({ type: "ping" }, (r) => res(r ?? null)))`,
  }).catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    const sw = (await targets()).find(
      (t) => t.type === "service_worker" && t.url?.endsWith("/background/index.js"),
    );
    if (sw) return makeCdp(await cdpConnect(sw.webSocketDebuggerUrl));
    await sleep(250);
  }
  throw new Error("service worker target never reappeared after wake ping");
}

async function killProcessGroup(pid) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, signal);
    } catch {}
    try {
      process.kill(pid, signal);
    } catch {}
    if (signal === "SIGKILL") return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // exited
      }
      await sleep(100);
    }
  }
}

describe.skipIf(!ARMED)("permission grant e2e (cua-driver)", () => {
  let profile;
  let child;
  let browserPid;
  let pageWs;
  let pageSend;
  let sentinel;

  beforeAll(async () => {
    // Step 1: dist must exist; build it if missing (design §3.3 step 1).
    const dist = join(REPO, "dist", "chrome");
    if (!existsSync(join(dist, "manifest.json"))) {
      spawnSync("npm", ["run", "build", "--", "--dev"], { cwd: REPO, stdio: "inherit" });
    }
    if (!existsSync(join(dist, "manifest.json"))) {
      throw new Error(`dist/chrome missing — run \`npm run build -- --dev\` first`);
    }

    // Step 2: own throwaway chromium (fresh profile, recipe arg passed by US).
    profile = mkdtempSync(join("/tmp/opencode", "leia-e2e-chrome-"));
    child = spawn(
      process.env.CHROME || "chromium",
      [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--remote-debugging-port=${E2E_PORT}`,
        "--force-renderer-accessibility",
        `--load-extension=${dist}`,
        "about:blank",
      ],
      // detached: the browser is its own process group, so teardown can kill
      // the whole group (crashpad/renderers/at-spi children included).
      { stdio: "ignore", detached: true },
    );
    child.unref();
    browserPid = child.pid;
    for (let i = 0; i < 40; i++) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${E2E_PORT}/json/version`)).json();
        if (v.Browser) break;
      } catch {}
      await sleep(250);
    }
    const version = await fetch(`http://127.0.0.1:${E2E_PORT}/json/version`).then((r) => r.json());
    expect(version.Browser).toBeTruthy();

    // Steps 3-4: cua preflight + the registry-wedge smoke probe.
    await ensureCuaRecipe();
    const windows = await smokeProbe(browserPid);
    console.log(`[permission-grant.e2e] smoke probe: cua sees ${windows.length} window(s) for pid ${browserPid}`);

    // Steps 5-6: real extension id + real options page (manifest path options/options.html).
    const extId = await discoverExtensionId();
    const opened = await openTab(`chrome-extension://${extId}/options/options.html`);
    await sleep(1000);
    const pageTarget = (await targets()).find((t) => t.url?.includes("/options/options.html"));
    if (!pageTarget?.webSocketDebuggerUrl) throw new Error("options page target not found after open");
    pageWs = await cdpConnect(pageTarget.webSocketDebuggerUrl);
    pageSend = makeCdp(pageWs);
    sentinel = `leia-e2e-${Date.now()}`;
  }, 60_000);

  it("grants api.openai.com when the native Allow bubble is clicked", async () => {
    // Step 7: drive the REAL save flow — sentinel into the OpenAI row's key
    // input, save button scrolled into view, REAL CDP click (trusted gesture;
    // element.click() would not surface the native bubble).
    const rect = await pageSend("Runtime.evaluate", {
      returnByValue: true,
      expression: `(function(){
        const row = document.querySelector('[data-provider="openai"]');
        if (!row) return { error: "no openai provider row rendered" };
        const input = row.querySelector(".key-input");
        const save = row.querySelector(".save");
        if (!input || !save) return { error: "key input / save button missing" };
        input.value = ${JSON.stringify(sentinel)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        save.scrollIntoView({ block: "center" });
        const r = save.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
    });
    expect(rect.result.value.error).toBeUndefined();
    await sleep(300); // let the scroll/layout settle before reading coords
    const coords = await pageSend("Runtime.evaluate", {
      returnByValue: true,
      expression: `(function(){
        const save = document.querySelector('[data-provider="openai"] .save');
        const r = save.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, inViewport: r.top >= 0 && r.bottom <= innerHeight };
      })()`,
    });
    const { x, y } = coords.result.value;
    expect(coords.result.value.inViewport).toBe(true);
    await pageSend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await pageSend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // Steps 8-11 with the council retry budget: ONE wholesale retry around
    // observe->click->verify; verification failures never retry (product bug
    // class — a granted origin would make the retry's bubble never appear).
    let lastError;
    for (let attempt = 0; attempt <= WHOLESALE_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[permission-grant.e2e] wholesale retry ${attempt}/${WHOLESALE_RETRIES} after: ${lastError?.message ?? "?"}`);
        await pageSend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await pageSend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      }
      try {
        // Step 8: the bubble exists and names the origin.
        const bubble = await observeBubbleWindow(browserPid);
        const bubbleText = bubble.elements.map((el) => el.label ?? "").join(" ");
        expect(bubbleText).toContain("api.openai.com");

        // Step 9: cua clicks Allow over AT-SPI (the ONLY sanctioned click path).
        const click = await clickAllow(browserPid);
        expect(click.route).toBe("accessibility");
        console.log(`[permission-grant.e2e] Allow clicked: ${click.summary}`);

        // Ground truth A: the grant is real (service worker context).
        const swSend = await serviceWorkerSocket(pageSend);
        const perm = await swSend("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `new Promise((res) => chrome.permissions.contains({ origins: [${JSON.stringify(OPENAI_ORIGIN)}] }, (g) => res(g)))`,
        });
        if (perm.result.value !== true) {
          throw new ClickedNotGrantedError(
            `Allow clicked (${click.summary}) but permissions.contains(${OPENAI_ORIGIN}) = ${perm.result.value} — ` +
              "PRODUCT BUG, filing against the options save flow (council taxonomy)",
          );
        }

        // Ground truth B: the key persisted even though the bubble
        // interrupted the gesture (save precedes the grant request,
        // src/options/options.ts saveAll).
        const stored = await pageSend("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `new Promise((res) => chrome.storage.local.get(${JSON.stringify(KEY_STORAGE)}, (v) => res(v[${JSON.stringify(KEY_STORAGE)}])))`,
        });
        expect(stored.result.value).toBe(sentinel);

        console.log(
          `[permission-grant.e2e] GROUND TRUTH: permissions.contains(${OPENAI_ORIGIN}) = true; ` +
            `${KEY_STORAGE} persisted (sentinel masked)`,
        );
        return; // passed
      } catch (err) {
        const retryable =
          err instanceof BubbleNeverAppearedError || err instanceof StaleTokenExhaustedError;
        if (!retryable || attempt === WHOLESALE_RETRIES) throw err;
        lastError = err;
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (child?.pid) await killProcessGroup(child.pid);
    await sleep(750); // renderers finish dying; the profile stops churning
    if (profile) {
      for (let i = 0; i < 3; i++) {
        try {
          rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(500);
        }
      }
    }
    try {
      pageWs?.close();
    } catch {}
    await endSession();
  }, 30_000);
});
