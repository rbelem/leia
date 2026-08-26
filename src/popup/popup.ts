import browser from "webextension-polyfill";
import type { PageInfo } from "../content/page-info";
import type { RouterMessage, RouterReply } from "../background/router";

const output = document.getElementById("output") as HTMLPreElement;
const log = (line: string): void => {
  output.textContent += line + "\n";
};

document.getElementById("ping")!.addEventListener("click", async () => {
  const reply = (await browser.runtime.sendMessage({ type: "ping" } satisfies RouterMessage)) as
    RouterReply | undefined;
  log("ping → " + JSON.stringify(reply));
});

document.getElementById("page-info")!.addEventListener("click", async () => {
  try {
    const reply = (await browser.runtime.sendMessage({ type: "leia:page-info" } satisfies RouterMessage)) as
      RouterReply | undefined;
    const info = reply?.data as PageInfo | undefined;
    log("page-info → " + (info ? `${info.title} — ${info.url} (${info.textLength} chars)` : JSON.stringify(reply)));
  } catch (err) {
    log("page-info error: " + String(err));
  }
});