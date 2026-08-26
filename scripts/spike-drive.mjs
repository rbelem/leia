// Open an extension page as a tab via CDP HTTP, then evaluate a probe in it.
// Usage: node drive-probe3.mjs <port> <extId> <type> [timeoutMs]
const port = process.argv[2];
const extId = process.argv[3];
const type = process.argv[4];
const timeoutMs = Number(process.argv[5] ?? 45000);
const pageUrl = `chrome-extension://${extId}/popup/popup.html`;

const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" });
const target = await r.json();
if (!target.webSocketDebuggerUrl) { console.error("NO_WS", JSON.stringify(target).slice(0, 300)); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
}

await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));
const out = await send("Runtime.evaluate", {
  expression: `(async () => {
    const res = await chrome.runtime.sendMessage({type: ${JSON.stringify(type)}});
    return JSON.stringify(res);
  })().catch(e => 'ERR:' + e.message)`,
  awaitPromise: true,
  returnByValue: true,
  timeout: timeoutMs,
});
console.log(JSON.stringify(out.result?.result?.value ?? out));
ws.close();
process.exit(out.result?.exceptionDetails ? 1 : 0);