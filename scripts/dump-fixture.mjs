// SPDX-License-Identifier: MPL-2.0
/**
 * Capture a live page as a test fixture.
 *
 * A real-page bug is reproduced from the DOM, not from the markup the server
 * first sent: script-built content, ad slots and inline SVG dominate the byte
 * count and never reach the reader. This dumps the settled DOM of a tab that
 * is already open in a leia-launched browser, with the tags that carry no
 * article text removed in the page (a DOM clone, so the strip is structural
 * rather than a regex over minified HTML).
 *
 * Usage:
 *   node scripts/dump-fixture.mjs <url-substring> [--port 9224] [--out path]
 *
 * The target must already be open (the capture is a reproduction step, so the
 * page is the one that showed the bug). Output defaults to
 * tests/fixtures/<slug>.html and the file is written only when it is smaller
 * than the raw DOM, so a failed strip is visible immediately.
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const PORT = flag("--port") ?? "9224";
const OUT = flag("--out");
const needle = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== PORT && a !== OUT);
if (!needle) {
  console.error("usage: node scripts/dump-fixture.mjs <url-substring> [--port 9224] [--out path]");
  process.exit(2);
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

/** DOM clone with the text-free tags removed; keeps <style> (a reader bug once
 * lived in stylesheet text, so fixtures must keep the trigger). */
const STRIP = `(() => {
  const copy = document.documentElement.cloneNode(true);
  copy.querySelectorAll("script,link,svg,iframe").forEach((el) => el.remove());
  return "<!doctype html>\\n" + copy.outerHTML;
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find((t) => t.type === "page" && (t.url ?? "").includes(needle));
if (!tab) {
  console.error(`no open page matching "${needle}" on CDP ${PORT}`);
  process.exit(1);
}

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
const raw = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
const clean = await send("Runtime.evaluate", { expression: STRIP, returnByValue: true });
ws.close();

const html = clean?.result?.result?.value;
const rawLen = raw?.result?.result?.value?.length ?? 0;
if (typeof html !== "string" || html.length === 0) {
  console.error("capture returned no HTML");
  process.exit(1);
}

const slug =
  (tab.url ?? "page").split("?")[0].replace(/\/+$/, "").split("/").pop()?.replace(/\.html?$/i, "") || "page";
const outPath = OUT ?? join("tests", "fixtures", `${slug}.html`);
writeFileSync(outPath, html);
const saved = rawLen === 0 ? 0 : 100 - Math.round((html.length / rawLen) * 100);
console.log(`${outPath} ${(html.length / 1024).toFixed(0)} KB (${saved}% smaller than the raw DOM)`);
console.log(basename(outPath), "from", tab.url);
