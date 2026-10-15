// Shared CDP dashboard driver for the store submission runbooks.
//
// One artifact behind store/publishing/*.md "Driving ... over CDP" sections.
// Every command targets a tab by URL substring (--tab) or id prefix
// (--tab id:<prefix>). Every CDP response carries a timeout so a hung
// renderer fails loudly instead of hanging forever.
//
// Usage:
//   node scripts/cdp-drive.mjs [--cdp <url>] --tab <match> <command> [args]
// Commands:
//   ping                       title + url (the preflight: run first)
//   tabs                       list open page tabs (id + url)
//   eval <js>                   print the expression value
//   shot <out.png>              capture a screenshot
//   find <regex>                print clickable matches (text, tag, x, y)
//   click <regex> [index]       trusted-click the smallest matching box
//   clickxy <x> <y>             trusted-click raw coordinates
//   fillxy <x> <y> <text>       click, select all, type (for plain inputs)
//   fillactive <text>           set the focused element via its native
//                              setter (for Angular/shadow components where
//                              typed keys land nowhere; verify the dialog
//                              visually before filling stacked dialogs)
//   setfiles <input#> <file...> set files on the nth input[type=file]
//   upclick <regex> <file...>   click a file-button by text, satisfy the
//                              file chooser via interception (never opens a
//                              native dialog). This Chrome build has no
//                              Page.handleFileChooser; the backend-node
//                              resolve path below is the one that works.
//   nav <url>                   Page.navigate (in-page location.href hangs)
//   reload                      Page.reload the tab
//
// Never click a file button without upclick: the native file dialog it
// opens is unreachable from CDP or any Wayland automation here.
const DEFAULT_CDP = "http://127.0.0.1:9222";
const RESPONSE_TIMEOUT_MS = 20000;

const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const takeFlag = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
};
const cdpBase = takeFlag("--cdp", DEFAULT_CDP).replace(/\/$/, "");
const tabMatch = takeFlag("--tab", "");
if (!tabMatch) fail("missing --tab <url-substring|id:prefix>");
const [command, ...rest] = args;
if (!command)
  fail(
    "missing command (ping, tabs, eval, shot, find, click, clickxy, fillxy, fillactive, setfiles, upclick, nav, reload)",
  );

const targets = await (await fetch(`${cdpBase}/json/list`)).json();
const isId = tabMatch.startsWith("id:");
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (isId ? t.id.startsWith(tabMatch.slice(3)) : t.url.includes(tabMatch)),
);
if (!page) fail(`no page tab matching ${tabMatch}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("websocket open failed"));
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === "Page.fileChooserOpened") {
    chooserEvent = m.params;
  }
};
let chooserEvent = null;
const send = (method, params = {}, timeoutMs = RESPONSE_TIMEOUT_MS) =>
  new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(
        new Error(`${method} timed out after ${timeoutMs}ms (hung renderer?)`),
      );
    }, timeoutMs);
    pending.set(mid, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const unwrap = (r) => r.result ?? r;
const evalJs = async (expr, timeoutMs) => {
  const r = await send(
    "Runtime.evaluate",
    {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeoutMs,
  );
  if (r.result?.exceptionDetails) {
    fail(
      `evaluate threw: ${(r.result.exceptionDetails.exception?.description || "exception").slice(0, 200)}`,
    );
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (v) =>
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));

// Shadow-piercing element search shared by find and click.
const FIND_SRC = `(reSource) => {
  const re = new RegExp(reSource);
  const out = [];
  const walk = (root) => {
    for (const e of root.querySelectorAll("*")) {
      if (e.shadowRoot) walk(e.shadowRoot);
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      let t = "";
      try {
        t = (e.innerText || "").trim();
      } catch {}
      if (!t || t.length > 80 || !re.test(t)) continue;
      const style = getComputedStyle(e);
      if (style.display === "none" || style.visibility === "hidden") continue;
      out.push({
        t: t.slice(0, 60),
        tag: e.tagName,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        area: Math.round(r.width * r.height),
      });
    }
  };
  walk(document);
  return out;
}`;

const findMatches = async (reSource) => {
  const fn = await evalJs(`(${FIND_SRC})(${JSON.stringify(reSource)})`);
  if (!Array.isArray(fn)) fail("find returned no list");
  return fn;
};
const trustedClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
};

const close = () => {
  ws.close();
  process.exit(0);
};

switch (command) {
  case "ping": {
    const title = await evalJs("document.title + ' | ' + location.href", 12000);
    out(title);
    break;
  }
  case "tabs": {
    out(
      targets
        .filter((t) => t.type === "page")
        .map((t) => ({ id: t.id, url: t.url })),
    );
    break;
  }
  case "eval": {
    out(await evalJs(rest.join(" ")));
    break;
  }
  case "shot": {
    const dest = rest[0];
    if (!dest) fail("shot needs an output path");
    await send("Page.enable");
    const shot = unwrap(
      await send("Page.captureScreenshot", { format: "png" }),
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(dest, Buffer.from(shot.data, "base64"));
    out(`wrote ${dest}`);
    break;
  }
  case "find": {
    out(await findMatches(rest[0] ?? ""));
    break;
  }
  case "click":
  case "clickxy": {
    let x, y, label;
    if (command === "clickxy") {
      x = Number(rest[0]);
      y = Number(rest[1]);
      label = `${x},${y}`;
    } else {
      const matches = await findMatches(rest[0] ?? "");
      if (matches.length === 0) fail(`no match for ${rest[0]}`);
      let el;
      if (rest[1] === undefined) {
        el = [...matches].sort((a, b) => a.area - b.area)[0];
      } else {
        el = matches[Number(rest[1])];
        if (!el)
          fail(
            `no match for ${rest[0]} at index ${rest[1]} (${matches.length} matches)`,
          );
      }
      const same = matches
        .filter((m) => m.t === el.t)
        .sort((a, b) => a.area - b.area);
      ({ x, y } = same[0]);
      label = same[0].t;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y))
      fail("bad click coordinates");
    await trustedClick(x, y);
    out(`clicked ${label}`);
    break;
  }
  case "fillxy": {
    const [xs, ys, ...textParts] = rest;
    const x = Number(xs);
    const y = Number(ys);
    const text = textParts.join(" ");
    if (!Number.isFinite(x) || !Number.isFinite(y))
      fail("fillxy needs x y text");
    await trustedClick(x, y);
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    if (text) await send("Input.insertText", { text });
    out(`filled ${JSON.stringify(text)}`);
    break;
  }
  case "fillactive": {
    const text = rest.join(" ");
    const done = await evalJs(`(() => {
      const findActive = (root) => {
        if (root.activeElement && (root.activeElement.tagName === "INPUT" || root.activeElement.tagName === "TEXTAREA")) return root.activeElement;
        for (const e of root.querySelectorAll("*")) {
          if (e.shadowRoot) {
            const r = findActive(e.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      const target = findActive(document);
      if (!target) return "no-focused-input";
      const proto = target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, ${JSON.stringify(text)});
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return "set:" + target.value.length;
    })()`);
    out(done);
    break;
  }
  case "setfiles": {
    const [indexS, ...files] = rest;
    const index = Number(indexS);
    if (!Number.isInteger(index) || files.length === 0)
      fail("setfiles needs an input index and at least one file");
    await send("DOM.enable");
    const doc = unwrap(await send("DOM.getDocument", { depth: -1 }));
    const found = unwrap(
      await send("DOM.querySelectorAll", {
        nodeId: doc.root.nodeId,
        selector: "input[type=file]",
      }),
    );
    if (found.nodeIds.length <= index)
      fail(`only ${found.nodeIds.length} file inputs present`);
    unwrap(
      await send("DOM.setFileInputFiles", {
        files,
        nodeId: found.nodeIds[index],
      }),
    );
    out(`input ${index} <- ${files.length} file(s)`);
    break;
  }
  case "upclick": {
    const [reSource, ...files] = rest;
    if (!reSource || files.length === 0)
      fail("upclick needs a button regex and at least one file");
    await send("Page.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const clicked = await evalJs(`(() => {
        const btns = [];
        const walk = (root) => {
          for (const e of root.querySelectorAll("*")) {
            let t = "";
            try {
              t = (e.innerText || "").trim();
            } catch {}
            if (t && new RegExp(${JSON.stringify(reSource)}).test(t)) btns.push(e);
            if (e.shadowRoot) walk(e.shadowRoot);
          }
        };
        walk(document);
        const small = btns
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 4 && r.height > 4)
          .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
        if (!small.length) return "no-button";
        small[0].e.click();
        return "clicked";
      })()`);
      if (clicked !== "clicked") fail(`upclick: ${clicked}`);
      for (let i = 0; i < 20 && !chooserEvent; i++) await sleep(250);
      if (!chooserEvent?.backendNodeId) fail("upclick: no file chooser opened");
      await send("DOM.enable");
      await send("DOM.getDocument", { depth: -1 });
      const push = unwrap(
        await send("DOM.pushNodesByBackendIdsToFrontend", {
          backendNodeIds: [chooserEvent.backendNodeId],
        }),
      );
      if (!push.nodeIds?.length) fail("upclick: backend node did not resolve");
      unwrap(
        await send("DOM.setFileInputFiles", { files, nodeId: push.nodeIds[0] }),
      );
      out(`chooser <- ${files.length} file(s)`);
    } finally {
      await send("Page.setInterceptFileChooserDialog", {
        enabled: false,
      }).catch(() => {});
    }
    break;
  }
  case "nav": {
    const url = rest[0];
    if (!url) fail("nav needs a url");
    const r = await send("Page.navigate", { url });
    out(r.errorText ? `navigate error: ${r.errorText}` : "navigated");
    break;
  }
  case "reload": {
    await send("Page.reload");
    out("reloaded");
    break;
  }
  default:
    fail(`unknown command ${command}`);
}
close();
