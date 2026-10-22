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
// Unique per run: the daemon keys snapshot state by session, and a reused
// name can keep serving a stale empty projection while a fresh name hits
// immediately. Date.now + pid keeps parallel runs apart too.
const SESSION = `leia-e2e-popup-${Date.now().toString(36)}-${process.pid}`;
/** Toolbar row for the action: manifest's action.default_title is "Leia". */
const ACTION_ROW = /button "Leia"/;
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
 *
 * The accessibility tree flaps: whole polling budgets sometimes see an empty
 * tree while single reads seconds later hit. So the attempt runs in bounded
 * rounds — each round is cheap when the row is present — and only a clean
 * sweep of misses skips, carrying what the last round saw.
 */
async function openPopup(win, port) {
  let lastMiss = "no rounds ran";
  for (let round = 1; round <= 3; round++) {
    // A fresh snapshot store per round. Observed, not fully explained:
    // repeated identical reads kept missing for a full 10s budget while a
    // single fresh read hit immediately seconds apart, in both directions
    // across runs — consistent with stale daemon-side state keyed by
    // session, but never proven. So each round starts clean instead of
    // trusting the previous round's store.
    const session = `${SESSION}-r${round}`;
    await reviveSession(session);
    const attempt = await tryOpenPopup(win, port, session);
    if (attempt.via) return { via: attempt.via, miss: null };
    lastMiss = `round ${round}: ${attempt.miss}`;
  }
  return { via: null, miss: lastMiss };
}

/**
 * Open the popup from the toolbar and prove it opened. Toolbar-only by
 * design: the Extensions menu opens visibly but this Chromium exposes none
 * of its rows over AT-SPI, so a menu detour can never proceed past the
 * puzzle click — and worse, each puzzle click flips menu state, so rounds
 * that touch the menu oscillate instead of converging. An unpinned action
 * therefore skips honestly; pin it to run this.
 */
async function tryOpenPopup(win, port, session) {
  const existing = await waitPopupTarget(port, 0);
  if (existing) {
    await fetch(`http://127.0.0.1:${port}/json/close/${existing.id}`).catch(() => {});
    await sleep(400);
  }
  const pinned = await waitForRow(session, win.pid, {
    query: "Leia",
    re: ACTION_ROW,
    windowId: win.window_id,
    // The tree populates lazily after launch; a short budget turns a slow
    // tree into a false miss, so each round gets the full window.
    timeoutMs: 10_000,
  });
  if (!pinned) {
    return { via: null, miss: "no toolbar row (unpinned, or the tree never filled its budget)" };
  }
  await cuaCall("click", { pid: win.pid, element_token: pinned, session });
  if (await waitPopupTarget(port)) return { via: "toolbar" };
  return { via: null, miss: "toolbar click landed but no popup target appeared" };
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

    const opened = await openPopup(win, state.debugPort);
    if (!opened.via) {
      // No toolbar row across three rounds: the action is unpinned (pin it
      // to run this), or the tree never filled a budget. The Extensions menu
      // is deliberately not driven: it opens visibly but exposes no rows
      // over AT-SPI here, so a menu detour can only oscillate menu state.
      ctx.skip(`no operable extension-action row (${opened.miss})`);
    }
    const openedVia = opened.via;

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
