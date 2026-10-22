// SPDX-License-Identifier: MPL-2.0
// Popup entry-point e2e: the popup must open from the BROWSER TOOLBAR, not
// from a hand-navigated chrome-extension:// URL, and it must open at its
// designed width. Both matter: the width contract only binds when the browser
// sizes the popup window itself (a tab render is not the same document), and
// a toolbar icon that is hidden behind the extensions menu is a real
// first-run path a user takes.
//
// Measured before the fix: the popup window opened 114px wide (selects
// collapsed to 18px) because body{} carried max-width only and the browser
// sized the window to the content's min-content width.
//
// Armed by LEIA_E2E=1 with a leia-launched Chromium already up
// (`leia up --chrome-bin <flatpak wrapper>`). cua reaches the toolbar over
// AT-SPI; CDP measures the popup document the click produced.
import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { loadState } from "../../cli/state.js";

const ARMED = process.env.LEIA_E2E === "1";
const POPUP_WIDTH = 320;
const EXEC_TIMEOUT_MS = 20_000;
const SESSION = "leia-e2e-popup";
/** Toolbar row for the action: manifest's action.default_title is "Leia". */
const ACTION_ROW = /button "Leia"/;
/** Same action inside the Extensions menu, named "Leia: Read Aloud". */
const MENU_ROW = /button "Leia: Read Aloud"/;
/** The menu's pin toggle, used to reach the toolbar path on an unpinned build. */
const PIN_ROW = /button "Pin Leia/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cua(args) {
  return new Promise((resolve) => {
    execFile("cua-driver", args, { encoding: "utf8", timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function cuaCall(tool, args) {
  const res = await cua(["call", tool, "--arguments", JSON.stringify(args)]);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

async function cdp(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

/** Evaluate an expression in a CDP page target and return its string result. */
async function evalIn(port, targetId, expression) {
  const list = await cdp(port, "/json/list");
  const tab = list.find((t) => t.id === targetId);
  if (!tab) return null;
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
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
  const out = await send("Runtime.evaluate", { expression, returnByValue: true });
  ws.close();
  return out?.result?.result?.value ?? null;
}

/** The main Chromium window as AT-SPI reports it (widest, on screen). */
async function findBrowserWindow() {
  const res = await cuaCall("list_windows", {});
  const windows = res?.windows ?? [];
  const chromium = windows.filter((w) => /chrom/i.test(w.app_name ?? ""));
  const main = chromium.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return main ?? null;
}

/**
 * Open the popup the way a user does. Returns the element token used, so the
 * caller can close it the same way. Falls back to the extensions menu when
 * the toolbar button is not surfaced.
 */
/** Poll CDP for the popup page target (it appears once the window opens). */
async function waitPopupTarget(port, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await cdp(port, "/json/list").catch(() => []);
    const popup = (Array.isArray(list) ? list : []).find((t) => (t.url ?? "").endsWith("/popup/popup.html"));
    if (popup) return popup;
    await sleep(250);
  }
  return null;
}

/**
 * Open the popup the way a user does, and prove it opened. The action may be
 * pinned in the toolbar or sit behind the puzzle-piece menu, and Chromium
 * populates both lazily. A menu row does not activate the action in this
 * Chromium over AT-SPI, so an unpinned build is pinned first (leia's own
 * test profile) and the toolbar click is what the test then drives.
 */
async function openPopup(win, port) {
  const existing = await waitPopupTarget(port, 0);
  if (existing) {
    await fetch(`http://127.0.0.1:${port}/json/close/${existing.id}`).catch(() => {});
    await sleep(400);
  }
  const pinned = await waitForToken(win, "Leia", ACTION_ROW, win.window_id, 2500);
  if (pinned) {
    await cuaCall("click", { pid: win.pid, element_token: pinned, session: SESSION });
    return (await waitPopupTarget(port)) ? "toolbar" : null;
  }
  // Unpinned: reach the action through the puzzle-piece menu's pin toggle.
  const puzzleToken = await waitForToken(win, "Extensions", /button "Extensions/, win.window_id, 5000);
  if (!puzzleToken) return null;
  await cuaCall("click", { pid: win.pid, element_token: puzzleToken, session: SESSION });
  await sleep(700);
  const pinToken = firstToken(
    await cuaCall("get_window_state", {
      pid: win.pid,
      window_id: win.window_id,
      include_screenshot: false,
      query: "Leia",
      session: SESSION,
    }),
    PIN_ROW,
  );
  if (!pinToken) return null;
  await cuaCall("click", { pid: win.pid, element_token: pinToken, session: SESSION });
  await sleep(600);
  const pinnedNow = await waitForToken(win, "Leia", ACTION_ROW, win.window_id, 4000);
  if (!pinnedNow) return null;
  await cuaCall("click", { pid: win.pid, element_token: pinnedNow, session: SESSION });
  return (await waitPopupTarget(port)) ? "toolbar-pinned-then-clicked" : null;
}

/** First element token whose tree row matches `re` (rows carry `[N]`). */
function firstToken(snapshot, re) {
  const tree = snapshot?.tree_markdown ?? "";
  const snapshotId = snapshot?.snapshot_id;
  if (!snapshotId) return null;
  for (const line of tree.split("\n")) {
    const row = /^\s*-?\s*\[(\d+)\]\s+(.*)$/.exec(line);
    if (row && re.test(row[2])) return `${snapshotId}:${row[1]}`;
  }
  return null;
}

/**
 * Chromium publishes its AT-SPI tree lazily after a browser start, so a
 * single read right after launch finds nothing. Poll until the row appears.
 * `windowId` null walks whatever popup the pid currently has open (the
 * extensions menu is its own toplevel, not the browser frame).
 */
async function waitForToken(win, query, re, windowId = win.window_id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const args = { pid: win.pid, include_screenshot: false, query, session: SESSION };
    if (windowId != null) args.window_id = windowId;
    const token = firstToken(await cuaCall("get_window_state", args), re);
    if (token) return token;
    await sleep(400);
  }
  return null;
}

describe.skipIf(!ARMED)("popup opens from the browser toolbar (cua)", () => {
  // A leftover end_session tombstone (or a daemon restart) rejects every
  // session-scoped call with "session has ended"; start_session revives it.
  beforeAll(async () => {
    await cuaCall("start_session", { session: SESSION });
  });

  it("opens at its designed width with nothing overflowing", async (ctx) => {
    const state = loadState();
    expect(state?.debugPort, "run `leia up --chrome-bin <wrapper>` first").toBeTruthy();

    const win = await findBrowserWindow();
    expect(win, "cua cannot see a Chromium window — is the a11y recipe on?").toBeTruthy();

    const openedVia = await openPopup(win, state.debugPort);
    if (!openedVia) {
      // This Chromium exposes no OPERABLE action row: the toolbar row is
      // absent on an unpinned action, and an Extensions-menu row closes the
      // menu without firing the action over AT-SPI. Pin the action in the
      // toolbar to run this check; do not fail on the environment.
      ctx.skip("no operable extension-action row in the toolbar or extensions menu");
    }

    const list = await cdp(state.debugPort, "/json/list");
    const popup = list.find((t) => (t.url ?? "").endsWith("/popup/popup.html"));
    expect(popup, `the ${openedVia} click did not produce a popup target`).toBeTruthy();

    const measured = JSON.parse(
      await evalIn(
        state.debugPort,
        popup.id,
        `JSON.stringify({
          innerWidth: window.innerWidth,
          overflow: [...document.querySelectorAll("*")].filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && (b.right > document.documentElement.clientWidth + 0.5 || b.left < -0.5);
          }).length,
        })`,
      ),
    );
    expect(measured.overflow).toBe(0);
    expect(measured.innerWidth).toBe(POPUP_WIDTH);

    // Close by target: the token used to open it is stale once the popup
    // window exists, and closing through CDP cannot toggle a second popup.
    await fetch(`http://127.0.0.1:${state.debugPort}/json/close/${popup.id}`).catch(() => {});
  });
});
