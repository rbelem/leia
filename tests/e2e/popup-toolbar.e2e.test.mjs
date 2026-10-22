// SPDX-License-Identifier: MPL-2.0
// Popup entry-point e2e: the popup must open from the BROWSER TOOLBAR, not
// from a hand-navigated chrome-extension:// URL, and it must open at its
// designed width. Both matter. The width contract only binds when the browser
// sizes the popup window itself, and an icon behind the extensions menu is a
// real first-run path a user takes.
//
// Measured before the fix: the popup window opened 114px wide (selects
// collapsed to 18px) because body weighed max-width only, so the browser
// sized the window to the content's min-content width.
//
// Armed by LEIA_E2E=1 with a leia-launched Chromium already up
// (`leia up --chrome-bin <flatpak wrapper>`). cua reaches the toolbar over
// AT-SPI; CDP measures the popup document the click produced.
import { beforeAll, describe, expect, it } from "vitest";
import { loadState } from "../../cli/state.js";
import { cuaCall, findBrowserWindows, reviveSession, waitForRow } from "./cua.mjs";

const ARMED = process.env.LEIA_E2E === "1";
const POPUP_WIDTH = 320;
const SESSION = "leia-e2e-popup";
/** Toolbar row for the action: manifest's action.default_title is "Leia". */
const ACTION_ROW = /button "Leia"/;
/** The menu's pin toggle, used to reach the toolbar path on an unpinned build. */
const PIN_ROW = /button "Pin Leia/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Open the popup the way a user does, and prove it opened. An unpinned action
 * activates from the toolbar once pinned; a menu row does not fire the action
 * over AT-SPI in this Chromium, so the menu is used only to pin.
 */
async function openPopup(win, port) {
  const existing = await waitPopupTarget(port, 0);
  if (existing) {
    await fetch(`http://127.0.0.1:${port}/json/close/${existing.id}`).catch(() => {});
    await sleep(400);
  }
  const pinned = await waitForRow(SESSION, win.pid, {
    query: "Leia",
    re: ACTION_ROW,
    windowId: win.window_id,
    timeoutMs: 2500,
  });
  if (pinned) {
    await cuaCall("click", { pid: win.pid, element_token: pinned, session: SESSION });
    return (await waitPopupTarget(port)) ? "toolbar" : null;
  }
  const puzzle = await waitForRow(SESSION, win.pid, {
    query: "Extensions",
    re: /button "Extensions/,
    windowId: win.window_id,
    timeoutMs: 5000,
  });
  if (!puzzle) return null;
  await cuaCall("click", { pid: win.pid, element_token: puzzle, session: SESSION });
  await sleep(700);
  const pin = await waitForRow(SESSION, win.pid, { query: "Leia", re: PIN_ROW, timeoutMs: 2000 });
  if (!pin) return null;
  await cuaCall("click", { pid: win.pid, element_token: pin, session: SESSION });
  await sleep(600);
  const pinnedNow = await waitForRow(SESSION, win.pid, {
    query: "Leia",
    re: ACTION_ROW,
    windowId: win.window_id,
    timeoutMs: 4000,
  });
  if (!pinnedNow) return null;
  await cuaCall("click", { pid: win.pid, element_token: pinnedNow, session: SESSION });
  return (await waitPopupTarget(port)) ? "toolbar-pinned-then-clicked" : null;
}

describe.skipIf(!ARMED)("popup opens from the browser toolbar (cua)", () => {
  // A leftover end_session tombstone (or a daemon restart) rejects every
  // session-scoped call; reviveSession clears it.
  beforeAll(async () => {
    await reviveSession(SESSION);
  });

  it("opens at its designed width with nothing overflowing", async (ctx) => {
    const state = loadState();
    expect(state?.debugPort, "run `leia up --chrome-bin <wrapper>` first").toBeTruthy();

    const win = (await findBrowserWindows())[0];
    expect(win, "cua cannot see a Chromium window — is the a11y recipe on?").toBeTruthy();

    const openedVia = await openPopup(win, state.debugPort);
    if (!openedVia) {
      // No operable action row: the action is unpinned and this Chromium does
      // not fire it from the Extensions menu over AT-SPI. Pin it to run this.
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
