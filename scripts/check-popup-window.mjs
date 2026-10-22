// SPDX-License-Identifier: MPL-2.0
/**
 * Assert that the popup OPENS as a popup window at its designed width.
 *
 * The static contract test in tests/popup-layout-contract.test.ts guards the
 * CSS rule. This guards the observable it produces: a browser sizes an
 * extension popup window to the document's content width, so only a real
 * popup shows whether the panel opens at 320 or collapses. Measured live
 * before the fix: 114px wide, voice select at 18px, one element overflowing.
 *
 * Proven to work headless (Chromium 152, --headless=new, --load-extension,
 * chrome.action.openPopup() with a user gesture), so it needs no desktop, no
 * cua, and no display.
 *
 * Usage: node scripts/check-popup-window.mjs
 * Exit 0: the popup opened at EXPECTED_WIDTH with nothing overflowing.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_WIDTH = 320;
const PORT = Number(process.env.POPUP_CHECK_PORT ?? 9445);
const DIST = join(process.cwd(), "dist", "chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CHROME_BIN wins (CI passes the setup-chrome chrome-path output); else the usual names. */
function chromeBinary() {
  const explicit = process.env.CHROME_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const name of ["google-chrome", "chrome", "chromium", "chromium-browser"]) {
    try {
      execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
      return name;
    } catch {
      // not on PATH, try the next name
    }
  }
  return null;
}

const bin = chromeBinary();
if (!bin) {
  console.error("no Chrome/Chromium binary found — set CHROME_BIN");
  process.exit(2);
}
let browserVersion = "unknown";
try {
  browserVersion = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
} catch {
  // version is context, not load-bearing
}
console.log(`browser: ${bin} (${browserVersion})`);
if (/^Google Chrome\b/.test(browserVersion)) {
  console.error(
    "refusing to run against branded Google Chrome: it ignores --load-extension, " +
      "so the extension under test would never load. Use unbranded Chromium " +
      "(CI installs a pinned Chromium snapshot and passes it as CHROME_BIN).",
  );
  process.exit(2);
}
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("dist/chrome missing — run `npm run build` first");
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), "leia-popup-check-"));
// The browser's stderr is the only witness when CDP never answers (missing
// system libraries on a fresh runner, a crashing profile dir). Keep it and
// print the tail on every early exit instead of failing blind.
const childLog = join(tmpdir(), `leia-popup-check-${process.pid}.log`);
const logFd = openSync(childLog, "w");
const child = spawn(bin, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  // Newer Chrome blocks unpacked loads without this; older builds ignore
  // unknown flags, so it is safe unconditionally.
  "--enable-unsafe-extension-debugging",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`,
  "about:blank",
], { stdio: ["ignore", "ignore", logFd] });
child.on("error", () => {});
child.on("exit", () => {});

/** Kill the browser and fail, showing what it said before dying. */
function fail(message) {
  let tail = "";
  try {
    const lines = readFileSync(childLog, "utf8").trim().split("\n");
    tail = lines.slice(-15).join("\n");
  } catch {
    tail = "(no browser log captured)";
  }
  child.kill();
  console.error(message);
  if (tail) console.error(`--- browser stderr (tail) ---\n${tail}`);
  process.exit(1);
}

const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
};

let ready = null;
for (let i = 0; i < 60; i++) {
  const targets = await list();
  const page = targets.find((t) => t.type === "page");
  if (page) {
    ready = targets;
    break;
  }
  await sleep(250);
}
if (!ready) {
  fail("browser never answered CDP");
}

// Leia is MV3, so its id rides the service_worker target — but a fresh
// profile also registers component-extension service workers, so matching any
// service_worker grabs the wrong id (observed in CI: an options page that
// 404s as chrome-error://). Match the worker path the manifest declares.
let extensionId = null;
let swPath = null;
try {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  swPath = manifest?.background?.service_worker ?? null;
} catch {
  swPath = null;
}
for (let i = 0; i < 120 && !extensionId; i++) {
  const targets = await list();
  const sw = targets.find(
    (t) =>
      t.type === "service_worker" &&
      (t.url ?? "").startsWith("chrome-extension://") &&
      (!swPath || (t.url ?? "").endsWith(`/${swPath}`)),
  );
  if (sw) extensionId = new URL(sw.url).host;
  else await sleep(250);
}
if (!extensionId) {
  const targets = await list();
  const anySw = targets.some((t) => t.type === "service_worker");
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // version is best-effort context, not load-bearing
  }
  fail(
    `could not discover the unpacked extension id after 30s (browser: ${version}) — is dist/chrome loadable? ` +
      `Targets seen: ${JSON.stringify(targets.map((t) => `${t.type}:${(t.url ?? "").slice(0, 60)}`))}` +
      (anySw
        ? " (the browser runs extensions, but not this one: branded Google Chrome ignores --load-extension — use unbranded Chromium)"
        : ""),
  );
}
// Open an extension page so chrome.action is callable. The APIs are injected
// asynchronously, so poll for the surface instead of assuming a delay.
const pageTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extensionId}/options/options.html`, { method: "PUT" })).json();
await sleep(1200);

async function evaluate(target, expression, extra = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, ...extra });
  ws.close();
  return out?.result?.result?.value;
}

let actionReady = false;
for (let i = 0; i < 20 && !actionReady; i++) {
  actionReady = (await evaluate(pageTarget, `typeof chrome?.action?.openPopup === "function"`)) === true;
  if (!actionReady) await sleep(250);
}
if (!actionReady) {
  const surface = await evaluate(
    pageTarget,
    `JSON.stringify({ href: location.href, hasChrome: typeof chrome, hasAction: typeof chrome?.action, openPopup: typeof chrome?.action?.openPopup })`,
  ).catch(() => "evaluate failed");
  fail(`chrome.action.openPopup never became callable. url=${pageTarget.url} surface=${surface}`);
}

const opened = await evaluate(
  pageTarget,
  `(async () => {
    try {
      if (!chrome.action?.openPopup) return "no chrome.action.openPopup";
      await chrome.action.openPopup();
      return "ok";
    } catch (e) { return "threw: " + String(e).slice(0, 120); }
  })()`,
  { awaitPromise: true, userGesture: true },
);

let popup = null;
for (let i = 0; i < 20 && !popup; i++) {
  popup = (await list()).find((t) => (t.url ?? "").endsWith("/popup/popup.html"));
  if (!popup) await sleep(250);
}

const measured = popup
  ? JSON.parse(
      await evaluate(
        popup,
        `JSON.stringify({
          innerWidth: window.innerWidth,
          overflow: [...document.querySelectorAll("*")].filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && (b.right > document.documentElement.clientWidth + 0.5 || b.left < -0.5);
          }).length,
        })`,
      ),
    )
  : null;

child.kill();
if (!popup) {
  fail(`popup did not open (chrome.action.openPopup -> ${opened})`);
}
const ok = measured.innerWidth === EXPECTED_WIDTH && measured.overflow === 0;
console.log(
  `popup window: innerWidth=${measured.innerWidth} (expected ${EXPECTED_WIDTH}) overflow=${measured.overflow}`,
);
process.exit(ok ? 0 : 1);
