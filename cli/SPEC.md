# leia-ctl — validated design spec

Status: DESIGN VALIDATED (both transports proven on real browsers). Ready to build.

## Goal
Make every aspect of the Leia extension callable from a CLI/REPL so it can be
tested end-to-end. "Every aspect" = reader transport, voice/prefs, live reader
status stream, engine seek, theme, content-scope reading, options config (local
voice servers + provider keys), and the probe surface.

## Architecture
- **In-extension harness page** (`src/harness/`): an extension-context page that
  opens a local WebSocket to the Node CLI. It (a) forwards CLI commands to
  `chrome.runtime.sendMessage` / `browser.runtime.sendMessage`, and (b) observes
  background broadcasts (`leia:session:state`, `leia:audio:event`,
  `leia:highlight:set`, `leia:theme:set`) via `runtime.onMessage` and pushes them
  back as live `{type:'event'}` WS messages.
- **Node CLI** (`cli/`): a subcommand engine (`leia <cmd>`), a REPL on top
  (`leia repl`), and `--json`/`--wait` assertion mode. One engine, three fronts.
- **BrowserAdapter interface**: Chrome = CDP (CLI-spawned), Firefox = firefox-devtools
  MCP (marionette/BiDi, attach-only to a browser already running).
- **Packaging**: dev-only build variant; production bundles stay clean.
- **Transport security**: loopback bind + `--token` handshake (token on by default).

## Browser specifics
### Chrome (CDP) — PROVEN
- Spawn `chromium`/`chrome` with `--load-extension=dist/chrome --remote-debugging-port=<p> --user-data-dir=<temp> --no-first-run`.
- Discover extension id from the service-worker target whose URL ends with
  `/background/index.js` (NOT a bundled Hangouts background_page).
- Open `chrome-extension://<id>/harness/harness.html` via `PUT /json/new`.
- Drive via CDP `Runtime.evaluate` on the harness page (may attach, or let the
  page's own WS carry commands; both proven).

### Firefox (geckodriver / WebDriver classic) — PROVEN
- Firefox cannot be spawned via the flatpak build (user-namespace EPERM). Instead the
  adapter drives a **geckodriver** process that launches/holds Firefox and exposes
  the WebDriver-classic HTTP API (the same mechanism the firefox-devtools-MCP uses
  under the hood).
- **geckodriver is required** (on PATH or via `GECKODRIVER`/`--geckodriver-path`). A
  known-good binary lives at `/tmp/geckodriver` (0.37.1) in this dev env; the
  firefox-devtools-MCP also bundles one.
- The Firefox binary is supplied via `moz:firefoxOptions.binary` — this env uses the
  Nix `playwright-firefox` build:
  `/nix/store/nvqkhvdw9xqk948rq5rx8nwb5rwmkzry-playwright-firefox/firefox/firefox`.
- **Why geckodriver, NOT raw BiDi**: Firefox permits only ONE active WebDriver
  session per instance. A raw `session.new` on an instance that already holds one is
  rejected ("Maximum number of active sessions"), and a transient CLI process strands
  the session it created. geckodriver correctly creates a session and `DELETE /session`
  frees it, so each CLI run owns + releases the session cleanly.
- **Sequence (proven live)**: `POST /session` (geckodriver launches Firefox with the
  chrome binary + `-headless`) → `POST /session/<id>/moz/addon/install` (temporary)
  → discover the extension UUID from the `moz:profile` capability's
  `storage/default/moz-extension+++<uuid>^userContextId` dir → `POST /session/<id>/url`
  to navigate the harness page (`moz-extension://<uuid>/harness/harness.html?ws=...`)
  → commands/events flow over the harness's WS bridge → `DELETE /session` on teardown.
- geckodriver's WebDriver-classic path is PROVEN to navigate a `moz-extension://` URL
  AND execute `browser.runtime.sendMessage` in the extension page (verified live).
- The `moz:profile` capability exposes the temp profile, from which the extension
  UUID is discoverable (it changes per install).

## Required manifest change (both browsers)
Add `connect-src` (exact loopback origins, NO port wildcards) to
`content_security_policy.extension_pages` so the harness page's loopback WS opens:
```
script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; default-src 'self';
connect-src 'self' ws://127.0.0.1:9333 ws://localhost:9333 http://127.0.0.1:9333 http://localhost:9333
```
(Source: `src/manifest.json`; the build script appends `; upgrade-insecure-requests`
for Firefox.)

**CRITICAL — `upgrade-insecure-requests` breaks the harness WS.** Firefox's
extension-pages CSP carries `upgrade-insecure-requests`, which re-writes the harness's
`ws://127.0.0.1:9333` to `wss://` (not in connect-src) → the harness WS is blocked,
so the harness never reconnects. Fix: the dev build (`--dev`, which includes the
harness) **drops `upgrade-insecure-requests`**; production keeps it (hardened).
(Verified: with it dropped, the Firefox harness reconnects and the full round-trip works.)

## Layout
- `src/harness/harness.html`, `src/harness/harness.ts` — in-extension page.
- `src/manifest.json` — CSP connect-src directive.
- `scripts/build.mjs` — add `src/harness/` entry; copy harness.html; add `--dev` flag
  to include the harness only in dev builds (or always include; see note).
- `cli/index.js` — subcommand core + `leia <cmd>`.
- `cli/repl.js` — interactive REPL.
- `cli/browser/chrome.js`, `cli/browser/firefox.js` — BrowserAdapter impls.
- `cli/browser/adapter.js` — the interface + factory.
- `cli/commands/` — command registry (reader, voice, prefs, theme, scope, options, probe).
- `leia-fixture.html` (or under `fixtures/`) — deterministic article for `open`.

## WS protocol (harness page ⇄ CLI) — THE shared contract
The harness page and the CLI agree on exactly this JSON protocol over
`ws://127.0.0.1:<port>`. This is the seam that lets the harness and CLI be built
independently. It is the only cross-lane interface.

CLI → harness (`{type:'command', id, name, args}`):
- `id`: number (monotonic). `name`: one of the command names. `args`: object.
Harness → CLI (three message shapes):
- `{type:'hello', url}` — sent once on WS open.
- `{type:'reply', id, replyType, ok, data?, error?}` — reply to a command.
- `{type:'event', name, data}` — a live background broadcast observed via
  `runtime.onMessage` (`name` = the msg.type, `data` = the msg).

Command name → sendMessage mapping (the harness resolves this internally):
- `ping` → `{type:'ping'}`
- `voices` → `{type:'leia:reader:voices'}`
- `status` → `{type:'leia:reader:status'}`
- `page-info` → `{type:'leia:page-info'}`
- `theme <x>` → `{type:'leia:theme:set', theme:x}`
- `start` → `{type:'leia:reader:start', ...}` (tokens if `args.text`, else capture active tab)
- `pause` → `{type:'leia:reader:pause'}`, `resume` → `{type:'leia:reader:resume'}`,
  `stop` → `{type:'leia:reader:stop'}`, `seek <t>` → `{type:'leia:reader:seek', token:t}`
- `prefs` → `{type:'leia:reader:prefs', voiceName?, rate?, engine?}`
- `preview <v>` → `{type:'leia:reader:preview', voiceName:v}`
- `scope` → `{type:'leia:selection:capture'}` (harness asks the active tab)
- `probe:<x>` → `{type:'leia:probe-<x>'|'leia:tts-probe'|'leia:ff-playback'|...}`
- `audio:families` → `{type:'leia:audio:families'}`, `audio:clock` → `{type:'leia:audio:clock'}`

The harness MUST return `undefined` from its `runtime.onMessage` listener for any
handled message (so it never claims a reply channel that belongs to the owner),
echoing the repo's `addReplyListener` rule.

The harness also must NOT treat `leia:theme:set` broadcasts it observes as its own
reply (it's a background broadcast, so it's an `event`, not a `reply`).

All WS is IPv4 loopback only (Node ws-server binds 127.0.0.1). Note: Firefox MV3
CSP needs exact-origin `connect-src` (no port wildcards) — see manifest section.

## Command surface (the "every aspect" set)
- `leia up` / `leia down` — launch/teardown the browser (Chrome auto; Firefox attach-only).
- `leia open <url>` / `leia open-fixture` — subject tab (bundled fixture or real URL).
- `leia start [--voice V] [--rate R] [--text TOKEN] [--url U]`, `leia pause`, `leia resume`, `leia stop`, `leia seek <token>`.
- `leia voices`, `leia voice <name>`, `leia rate <r>`, `leia preview <voice>`.
- `leia status` / `leia state` (mirrors the live session state), `leia theme <name>`.
- `leia scope` (capture selection/article), `leia page-info`.
- `leia options:servers` / `options:add-server` / `options:keys` / `options:set-key` — options config.
- `leia probe:voices` / `probe:speak` / `probe:cancel` / `probe:kitten` / `probe:tts` / `probe:ff`.
- `leia events` — follow the live event stream.
- `leia wait <condition>` / `leia expect <condition>` — assertion mode (CI-able).
- `--json` on any command for machine output.

## Verification gate (both browsers)
- `npm run build` (with harness) produces both dists; `npm run typecheck` clean;
  `npm test` green (existing 833 tests).
- Live smoke: `leia up` → `leia start` on fixture → observe `leia:session:state` /
  `leia:audio:event` stream → `leia stop`. Repeat on Firefox via geckodriver.
- **Expected browser gating** (validate these are the *reason* for any `ok:false`,
  not a harness bug — see `docs/permissions.md` "Web Speech platform limitation"):
  - `probe:voices` / `probe:speak` / `probe:cancel` use the **offscreen API**
    (Chrome 109+ only) → work in Chrome, error in Firefox ("offscreen API
    unavailable").
  - `probe:tts` uses **`chrome.tts`** (Chrome-only + needs a real speech engine)
    → errors in both on a headless/voiceless host.
  - `probe:ff` uses **`speechSynthesis` in the event page** (Firefox-only) →
    works in Firefox (`{stage:"started"}`), errors in Chrome.
  - `probe:kitten` needs the model fetch to succeed (CSP `connect-src` must list
    `raw.githubusercontent.com` + `huggingface.co`); it is otherwise a live,
    on-device probe that works in both browsers.
  - `audio:families` is richer in Firefox (full family catalog; the event page
    has a DOM) than Chromium's service-worker context.
  - Web Speech (`web-speech`) family reports "no speech voices available" on a
    host where the browser doesn't surface voices — expected platform gap, not a
    defect. Use `kitten-local` / provider families for on-device speech.
  - First command after `up` is sent only after a bounded connect grace, so a
    "harness not connected" is a real teardown, not a startup race.
