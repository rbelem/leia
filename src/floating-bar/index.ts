import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "../background/router";

const BAR_ID = "leia-floating-bar-placeholder";

/** Placeholder for the product floating bar: a fixed pill, nothing more in T1. */
function ensureBar(): HTMLElement {
  const existing = document.getElementById(BAR_ID);
  if (existing) return existing;

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.textContent = "Leia — floating bar placeholder";
  bar.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
    "padding:8px 14px;border-radius:999px;background:#1f2937;color:#f9fafb;" +
    "font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgb(0 0 0 / .35);" +
    "user-select:none;";
  document.documentElement.appendChild(bar);
  return bar;
}

browser.runtime.onMessage.addListener((msg: unknown): RouterReply | undefined => {
  if (!isRouterMessage(msg)) return undefined;
  if (msg.type === "leia:bar-status") {
    return { ok: true, replyType: "leia:bar-status", data: { mounted: true, id: BAR_ID } };
  }
  return routeMessage(msg) ?? undefined;
});

ensureBar();