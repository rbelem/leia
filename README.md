# Leia

A browser extension (Chrome + Firefox) that reads webpages aloud using
pluggable AI voices — local models or provider APIs — with a highlight that
follows the speech. Vocabulary (voice engine, read scope, marching highlight,
engine capability, local server profile, reading position) is defined in
CONTEXT.md; architecture decisions in docs/adr/0001–0004.

**Status — T1 skeleton.** One TypeScript codebase builds into a Chrome MV3
package and a Firefox MV3 package. A minimal messaging backbone
(popup ↔ background ↔ content script ↔ floating bar) is wired end to end and
exercised by a ping/echo router. No product behavior yet — audio ownership is
T2 (see docs/permissions.md → “Audio-owner seam”).

## Layout

```
src/background/   message router; Chrome service worker / Firefox event page
src/content/      content script: answers leia:page-info
src/floating-bar/ content script: placeholder pill, knows the router
src/popup/        action popup: probes router + page info
src/manifest.json source manifest; scripts/build.mjs patches it per browser
scripts/build.mjs esbuild bundler → dist/chrome + dist/firefox
tests/            vitest (jsdom)
docs/             permissions, platform floor, T2 spike checklists
```

## Scripts

| Command | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | vitest run (jsdom) |
| `npm run build` | esbuild → `dist/chrome` + `dist/firefox` |

## Load in Chrome

```sh
npm run build
```

`chrome://extensions` → enable Developer mode → **Load unpacked** →
`dist/chrome`.

## Load in Firefox

```sh
npm run build
```

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`dist/firefox/manifest.json`.

In both browsers, click the Leia action: “Ping background router” and “Ask
active tab for page info” walk popup → background → content script → popup
through the `browser.*` API (webextension-polyfill on Chrome, native
`browser.*` on Firefox) — the same paths the product messaging will use.

## Decisions

- docs/permissions.md — permission surface (optional host permissions), key
  storage, CSP, audio-owner seam (T2)
- docs/platform-floor.md — Custom Highlight API floor: Chrome ≥ 105, Firefox ≥ 140
- docs/spike-offscreen-speech.md, docs/spike-firefox-eventpage.md — T2 entry-gate probes