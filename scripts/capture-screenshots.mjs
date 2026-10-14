// SPDX-License-Identifier: MPL-2.0
// Captures store screenshots from the LIVE extension (leia-ctl `up` + a dev
// build). Drive CDP over the debug port recorded in leia-ctl state.
//
// Why the overlay step: Chromium 152's CDP capture paths (captureScreenshot,
// screencast) skip CSS Custom Highlight paint, though real rendering paints
// it (verified: `chromium --screenshot` renders the wash, CDP does not).
// So before each frame we read the LIVE highlight ranges + theme rule from
// the running extension and mirror them onto temporary absolutely-positioned
// divs. Colors, ranges, and scroll position come from the running session;
// the page reloads afterwards to discard the mirrors. What the capture shows
// is the state a user sees, through a capture path that can render it.
//
//   node cli/index.js up --chrome-bin <chromium>   (LEIA_STATE_DIR as needed)
//   node cli/index.js open-fixture
//   node scripts/capture-screenshots.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE = process.env.LEIA_STATE_DIR
  ? join(process.env.LEIA_STATE_DIR, "state.json")
  : join("/tmp", "opencode", "leia-ctl", "state.json");
const OUT_DIR = join(import.meta.dirname, "..", "store", "screenshots");
const WIDTH = 1280;
const HEIGHT = 800;
const ENGINE = "kitten-local"; // on-device engine; works on hosts without system TTS

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.url = url;
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws.close();
  }
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result?.value;
}

const runtimeMsg = (cdp, msg) =>
  evalInPage(cdp, `new Promise(res => chrome.runtime.sendMessage(${JSON.stringify(msg)}, r => res(r)))`);

async function capture(cdp, outPath) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log(`captured ${outPath}`);
}

// Mirror the live leia-sentence / leia-word highlight ranges + theme rule
// into DOM divs, using the colors from the extension's injected style.
const MIRROR_HL = `(() => {
  const style = document.getElementById("leia-highlight-style")?.textContent ?? "";
  const wash = style.match(/::highlight\\(leia-sentence\\)[^}]*background-color:\\s*([^;]+);/)?.[1]?.trim() ?? "rgba(251,191,36,0.42)";
  const ink = style.match(/::highlight\\(leia-sentence\\)[^}]*color:\\s*([^;]+);/)?.[1]?.trim() ?? "#573a00";
  const line = style.match(/::highlight\\(leia-word\\)[^}]*text-decoration:\\s*([^;]+);/)?.[1]?.trim() ?? "2px underline";
  const box = document.createElement("div");
  box.id = "leia-shot-mirror";
  box.style.cssText = "position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none";
  const rectsOf = (range) => [...range.getClientRects()].map(r => ({ l: r.left, t: r.top, w: r.width, h: r.height }));
  const paint = (registry, fn) => {
    const h = CSS.highlights && registry ? CSS.highlights.get(registry) : null;
    if (!h) return;
    for (const range of h) for (const r of rectsOf(range)) fn(r);
  };
  paint("leia-sentence", (r) => {
    const d = document.createElement("div");
    d.style.cssText = \`position:absolute;left:\${r.l + scrollX}px;top:\${r.t + scrollY}px;width:\${r.w}px;height:\${r.h}px;background:\${wash}\`;
    box.appendChild(d);
  });
  paint("leia-word", (r) => {
    const m = line.match(/(\\d+)px/);
    const t = m ? Number(m[1]) : 2;
    const d = document.createElement("div");
    d.style.cssText = \`position:absolute;left:\${r.l + scrollX}px;top:\${r.t + scrollY + r.h - t}px;width:\${r.w}px;height:\${t}px;background:\${ink}\`;
    box.appendChild(d);
  });
  document.body.appendChild(box);
  return wash;
})()`;

async function readerStatus(cdp) {
  const reply = await runtimeMsg(cdp, { type: "leia:reader:status" });
  return reply?.data ?? reply;
}

async function main() {
  // Modes:
  //   (no args)  fixture hero shot + voice-picker options shot
  //   <url> <name.png>  live highlight shot on any article
  const [url, outName] = process.argv.slice(2);
  if (url && outName) return captureArticleAt(url, outName);

  const { debugPort, extensionId } = JSON.parse(readFileSync(STATE, "utf8"));
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const harness = targets.find((t) => t.type === "page" && t.url.includes("harness.html"));
  const fixture = targets.find((t) => t.type === "page" && t.url.includes("article.html"));
  if (!harness || !fixture) {
    throw new Error(`targets not found: harness=${!!harness} fixture=${!!fixture}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const ctl = new Cdp(harness.webSocketDebuggerUrl);
  await ctl.connect();

  // The reader captures the ACTIVE tab's scope at start, so the fixture tab
  // must be the active one (earlier capture runs may have opened other tabs).
  await fetch(`http://127.0.0.1:${debugPort}/json/activate/${fixture.id}`);
  await sleep(400);

  // Clean slate: reload discards any earlier mirror + red test style, then
  // pin the engine and restart so the highlight march is live.
  const page = new Cdp(fixture.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Page.enable");
  await evalInPage(page, "location.reload()").catch(() => {});
  await sleep(2500);
  await runtimeMsg(ctl, { type: "leia:reader:prefs", engine: ENGINE });
  await runtimeMsg(ctl, { type: "leia:reader:stop" });
  await sleep(400);
  await runtimeMsg(ctl, { type: "leia:reader:start" });

  // Wait for the highlight to march. Per-token synthesis takes seconds, so
  // poll up to 60s; a playing session at any position is a valid frame.
  let pos = -1;
  let state = "unknown";
  for (let i = 0; i < 120; i++) {
    const st = await readerStatus(ctl);
    pos = st?.tokenPos ?? -1;
    state = st?.state ?? "unknown";
    if (pos >= 3) break;
    if (i % 4 === 0) console.log(`waiting: state=${state} tokenPos=${pos}`);
    if (state === "stopped") break;
    await sleep(500);
  }
  console.log(`session: state=${state} tokenPos=${pos}/25 engine=${ENGINE}`);
  if (pos < 1) throw new Error("session never produced a highlight");

  await setViewportAndCapture(page, ctl, join(OUT_DIR, "article-highlight-1280x800.png"));

  // Options page: the voice-engine picker with capability disclosure.
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?chrome-extension://${extensionId}/options/options.html`, { method: "PUT" });
  const optTarget = await res.json();
  await sleep(2000);
  const options = new Cdp(optTarget.webSocketDebuggerUrl);
  await options.connect();
  await options.send("Page.enable");
  await capture(options, join(OUT_DIR, "voice-picker-1280x800.png"));
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${optTarget.id}`);

  ctl.close();
  page.close();
  options.close();
  console.log("done");
}

async function setViewportAndCapture(page, ctl, outPath) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(600);
  const wash = await evalInPage(page, MIRROR_HL);
  console.log(`mirror applied (wash ${wash})`);
  await sleep(300);
  await capture(page, outPath);
  await evalInPage(page, "document.getElementById(\"leia-shot-mirror\")?.remove()");
}

// One live-highlight shot on an arbitrary article URL.
async function captureArticleAt(url, outName) {
  const { debugPort } = JSON.parse(readFileSync(STATE, "utf8"));
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const harness = targets.find((t) => t.type === "page" && t.url.includes("harness.html"));
  if (!harness) throw new Error("harness target not found — run leia up first");
  mkdirSync(OUT_DIR, { recursive: true });

  const ctl = new Cdp(harness.webSocketDebuggerUrl);
  await ctl.connect();
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = await res.json();
  await sleep(6000); // article load + content script + Readability
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Page.enable");

  await runtimeMsg(ctl, { type: "leia:reader:prefs", engine: ENGINE });
  await runtimeMsg(ctl, { type: "leia:reader:stop" });
  await sleep(400);
  await runtimeMsg(ctl, { type: "leia:reader:start" });

  let pos = -1;
  let state = "unknown";
  for (let i = 0; i < 120; i++) {
    const st = await readerStatus(ctl);
    pos = st?.tokenPos ?? -1;
    state = st?.state ?? "unknown";
    if (pos >= 3) break;
    if (i % 8 === 0) console.log(`waiting: state=${state} tokenPos=${pos}`);
    if (state === "stopped") break;
    await sleep(500);
  }
  console.log(`session: state=${state} tokenPos=${pos} on ${url}`);
  if (pos < 1) throw new Error("session never produced a highlight");

  await setViewportAndCapture(page, ctl, join(OUT_DIR, outName));
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  ctl.close();
  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
