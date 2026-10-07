// SPDX-License-Identifier: MPL-2.0
/**
 * cua-driver adapter — the SINGLE choke point for cua usage in this repo
 * (issue #22, council §4: cua may not be imported anywhere else; a grep for
 * `cua-driver` outside this file + its test is the enforcement).
 *
 * All cua invocations are one-shot CLI calls (`cua-driver call <tool>
 * --arguments '<json>'`), service-backed by the running daemon. Session
 * discipline: every call passes one named session (`leia-e2e-perm`) — element
 * tokens die across snapshots, so every click re-observes first.
 *
 * Tool-shape notes (probed live against cua-driver 0.33.2 on KWin 6.7.5,
 * 2026-10-07 — see docs/cua-e2e.md):
 *  - `get_window_state` requires `pid` AND `window_id` (pid alone answers
 *    "No windows found … Provide window_id"), so bubble discovery polls
 *    `list_windows {pid}` and the tree snapshot targets the found window.
 *  - The `session` argument scopes the daemon's snapshot store: it must be
 *    passed to BOTH `get_window_state` and `click`, or the click refuses with
 *    `stale_element_token` ("pid has no current snapshot").
 *  - A refused click exits 0 with `status: "refused"` +
 *    `refusal.code: "stale_element_token"`; a delivered click returns
 *    `route: "accessibility"` (AT-SPI Action press, background, no focus
 *    steal). Coordinates are prohibited by design (council §8).
 */
import { execFile } from "node:child_process";

export class CuaUnavailableError extends Error {
  kind = "cua-unavailable";
}
export class BubbleNeverAppearedError extends Error {
  kind = "bubble-never-appeared";
}
export class StaleTokenExhaustedError extends Error {
  kind = "stale-token-exhausted";
}
export class ClickedNotGrantedError extends Error {
  kind = "clicked-not-granted";
}

export const CUA_PIN = /^0\.33\./; // council §6: pin 0.33.x (0.34.0 exists; re-check KWin capabilities before bumping)
export const SMOKE_PROBE_MS = 2000; // council §6: 2s startup smoke
export const BUBBLE_TIMEOUT_MS = 5000; // bubble materialization
export const OBSERVE_SETTLE_MS = 500; // chromium lazy tree — settle, then re-snapshot
export const STALE_TOKEN_RETRIES = 3; // a refused token => re-observe, never retry-click blind
export const POLL_MS = 250;
export const CUA_SESSION = "leia-e2e-perm";
export const BUBBLE_TITLE_RE = /has requested additional permissions/;
export const ALLOW_BUTTON_RE = /^Allow$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One `cua-driver` invocation; resolves { code, stdout, stderr }. */
function cuaCli(args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile("cua-driver", args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? err?.message ?? "" });
    });
  });
}

/** One `cua-driver call <tool> --arguments <json>`; resolves parsed JSON or null on failure. */
async function cuaCall(tool, args) {
  const { code, stdout, stderr } = await cuaCli(["call", tool, "--arguments", JSON.stringify(args)]);
  if (code !== 0) {
    if (process.env.LEIA_E2E_DEBUG) {
      console.log(`[cua.mjs][debug] ${tool} exit ${code}: ${stderr.slice(0, 300)}`);
    }
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    if (process.env.LEIA_E2E_DEBUG) {
      console.log(`[cua.mjs][debug] ${tool} unparseable stdout: ${stdout.slice(0, 300)}`);
    }
    return null;
  }
}

/** True when the session bus carries the at-spi ScreenReaderEnabled property. */
function hasSessionBus() {
  return new Promise((resolve) => {
    execFile(
      "busctl",
      ["--user", "get-property", "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Status", "ScreenReaderEnabled"],
      { encoding: "utf8", timeout: 5_000 },
      (err) => resolve(!err),
    );
  });
}

/** True when the daemon answers a cheap window listing (service-backed). */
async function daemonAnswers() {
  const res = await cuaCall("list_windows", {});
  if (res !== null) return true;
  return (await cuaCli(["list_windows"])).code === 0;
}

/** Resolve the cua version string, or null when the CLI is missing/broken. */
async function cuaVersion() {
  const version = await cuaCli(["--version"]);
  const match = version.stdout.match(/cua-driver (\d+\.\d+\.\d+)/);
  if (version.code !== 0 || !match) return null;
  return match[1];
}

/**
 * Preflight (fail fast, actionable — council addendum 1 order: version pin →
 * session bus → daemon). `telemetry disable` runs between pin and bus checks,
 * best-effort: content-free telemetry is on by default (investigation §4).
 * Throws CuaUnavailableError — the e2e maps that to loud-skip locally /
 * hard red in CI (LEIA_E2E contract, docs/cua-e2e.md).
 */
export async function ensureCuaRecipe(env = process.env) {
  const found = await cuaVersion();
  if (!found) {
    throw new CuaUnavailableError(
      "cua-driver not found on PATH — install it (devbox global / cua-driver update) and re-run; see docs/cua-e2e.md",
    );
  }
  if (!CUA_PIN.test(found)) {
    throw new CuaUnavailableError(
      `cua-driver ${found} found — this e2e pins 0.33.x (issue #22); upgrade the pin deliberately ` +
        "(0.34.0 changed Wayland capabilities; re-check KWin foreign-toplevel support first)",
    );
  }
  await cuaCli(["telemetry", "disable"]); // idempotent, best-effort

  if (!(await hasSessionBus())) {
    throw new CuaUnavailableError(
      "no session bus / at-spi2-core — run under dbus-run-session (CI) or a graphical session; see docs/cua-e2e.md",
    );
  }
  if (!(await daemonAnswers())) {
    throw new CuaUnavailableError(
      "cua daemon not answering — `cua-driver serve` (desktop) or fix dbus-run-session wrapping (CI); see docs/cua-e2e.md",
    );
  }
  // Own the named session explicitly: a leftover `end_session` tombstone (or
  // a daemon restart) would otherwise reject every session-scoped snapshot
  // with "session has ended". start_session is idempotent and revives.
  const started = await cuaCall("start_session", { session: CUA_SESSION });
  if (started === null) {
    throw new CuaUnavailableError(
      `cua daemon refused to start session "${CUA_SESSION}" — daemon too old? this e2e needs 0.33.x; see docs/cua-e2e.md`,
    );
  }
}

/**
 * Council §6 startup smoke: cua must see the browser window in the AT-SPI
 * tree within SMOKE_PROBE_MS. This is the registry-wedge tripwire (the spike
 * found org.a11y.atspi.Registry unreachable — daemon serves cached apps, new
 * apps never register). Timeout throws CuaUnavailableError with a checklist,
 * never a bare 30s timeout elsewhere.
 */
export async function smokeProbe(browserPid) {
  const deadline = Date.now() + SMOKE_PROBE_MS;
  while (Date.now() < deadline) {
    const res = await cuaCall("list_windows", { pid: browserPid });
    if (res && Array.isArray(res.windows) && res.windows.length > 0) return res.windows;
    await sleep(POLL_MS);
  }
  throw new CuaUnavailableError(
    `cua cannot see the browser window (pid ${browserPid}) within ${SMOKE_PROBE_MS}ms. Checklist: ` +
      "(1) recipe flag ScreenReaderEnabled set BEFORE spawn? (2) --force-renderer-accessibility present? " +
      "(3) at-spi2-core installed? (4) AT-SPI registry wedged (org.a11y.atspi.Registry missing — " +
      "`systemctl --user restart at-spi-dbus-bus.service`, else session relogin). See docs/cua-e2e.md",
  );
}

/**
 * Poll for the permissions bubble window of `browserPid`, then settle and
 * re-snapshot (chromium's a11y tree materializes lazily — investigation §4;
 * the first snapshot after the window appears can be empty, so snapshots
 * repeat on a short bounded budget until the tree fills). Resolves
 * { windowId, elements, title }. Timeout -> BubbleNeverAppearedError
 * (taxonomy: timing or dirty profile — the e2e always spawns a fresh
 * profile, so a previously-granted origin is not the explanation there).
 */
export async function observeBubbleWindow(browserPid) {
  const deadline = Date.now() + BUBBLE_TIMEOUT_MS;
  let windowId = null;
  let title = "";
  while (Date.now() < deadline) {
    const res = await cuaCall("list_windows", { pid: browserPid });
    const hit = res?.windows?.find((w) => BUBBLE_TITLE_RE.test(w.title ?? ""));
    if (hit) {
      windowId = hit.window_id;
      title = hit.title ?? "";
      break;
    }
    await sleep(POLL_MS);
  }
  if (windowId === null) {
    throw new BubbleNeverAppearedError(
      `no permissions bubble window within ${BUBBLE_TIMEOUT_MS}ms (pid ${browserPid}) — ` +
        "was the save click a real CDP gesture? is the profile fresh (a granted origin never re-prompts)?",
    );
  }
  // Settle + re-snapshot discipline: let the bubble tree materialize.
  await sleep(OBSERVE_SETTLE_MS);
  let elements = [];
  const treeDeadline = Date.now() + OBSERVE_SETTLE_MS * 3;
  while (Date.now() < treeDeadline) {
    const state = await cuaCall("get_window_state", { pid: browserPid, window_id: windowId, session: CUA_SESSION });
    elements = state?.elements ?? [];
    if (elements.length > 0) break;
    if (process.env.LEIA_E2E_DEBUG) {
      console.log(`[cua.mjs][debug] empty tree for window ${windowId}; raw:`, JSON.stringify(state)?.slice(0, 400));
    }
    await sleep(POLL_MS);
  }
  return { windowId, title, elements };
}

/**
 * Click the bubble's Allow button — the ONLY click path (AT-SPI Action press
 * via element_token; coordinates prohibited, council §8). Bounded retry:
 * every attempt re-observes first (tokens die across snapshots), a
 * stale_element_token refusal just loops, anything else throws. Exhaustion
 * -> StaleTokenExhaustedError (env-flake class). Grant verification is NOT
 * this function's job — the test asserts ground truth (council §3).
 */
export async function clickAllow(browserPid) {
  let lastTransient = "";
  for (let attempt = 1; attempt <= STALE_TOKEN_RETRIES; attempt++) {
    const { windowId, elements } = await observeBubbleWindow(browserPid);
    const allow = elements.find(
      (el) =>
        el.role === "button" &&
        ALLOW_BUTTON_RE.test(el.label ?? "") &&
        Array.isArray(el.actions) &&
        el.actions.includes("press"),
    );
    if (!allow) {
      throw new BubbleNeverAppearedError(
        `bubble ${windowId} has no Allow button with a press action (${elements.length} elements) — ` +
          "bubble content wrong = product bug surface",
      );
    }
    const res = await cuaCall("click", { pid: browserPid, element_token: allow.element_token, session: CUA_SESSION });
    if (res === null) {
      lastTransient = "cua click invocation failed";
      continue; // transient CLI/daemon hiccup — re-observe and retry within budget
    }
    if (res.refusal?.code === "stale_element_token") {
      lastTransient = "stale_element_token";
      continue; // re-observe, never retry the dead token
    }
    if (res.route === "accessibility") return res;
    throw new Error(`cua click refused: ${JSON.stringify(res.refusal ?? res)}`);
  }
  throw new StaleTokenExhaustedError(
    `click did not land after ${STALE_TOKEN_RETRIES} re-observed attempts (last: ${lastTransient}) — env flake class`,
  );
}

/** Best-effort session teardown so the daemon's snapshot store does not leak. */
export async function endSession() {
  await cuaCall("end_session", { session: CUA_SESSION });
}
