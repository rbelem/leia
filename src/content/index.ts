import browser from "webextension-polyfill";
import { isRouterMessage, routeMessage, type RouterReply } from "../background/router";
import { pageInfoFromDocument } from "./page-info";

browser.runtime.onMessage.addListener((msg: unknown): RouterReply | undefined => {
  if (!isRouterMessage(msg)) return undefined;
  if (msg.type === "leia:page-info") {
    return { ok: true, replyType: "leia:page-info", data: pageInfoFromDocument(document) };
  }
  return routeMessage(msg) ?? undefined;
});