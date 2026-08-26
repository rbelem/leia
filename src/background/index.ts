import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "./router";

browser.runtime.onMessage.addListener(async (msg: unknown): Promise<RouterReply | undefined> => {
  if (!isRouterMessage(msg)) return;
  if (msg.type === "leia:page-info") {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, replyType: "leia:page-info", error: "no active tab" };
      const info = await browser.tabs.sendMessage(tab.id, { type: "leia:page-info" });
      return { ok: true, replyType: "leia:page-info", data: info };
    } catch (err) {
      return { ok: false, replyType: "leia:page-info", error: String(err) };
    }
  }
  return routeMessage(msg) ?? undefined;
});