# Permissions, keys, CSP — and the audio-owner seam (T2)

Decisions locked in T1 (council amendments). Source of truth:
`src/manifest.json` (+ Firefox patch in `scripts/build.mjs`).

## Permission surface

| Entry | Value | When granted | Why |
|---|---|---|---|
| `activeTab` | required | install | popup ↔ active-tab messaging; no warning, scoped to user gesture |
| `storage` | required | install | `chrome.storage.local` for API keys (T2). No warning |
| `host_permissions` | `<all_urls>` | install | content script + floating bar must be present on every page. The only install-time warning |
| `optional_host_permissions` | `http://localhost/*`, `http://127.0.0.1/*`, `https://api.openai.com/*`, `https://api.elevenlabs.io/*`, `https://api.x.ai/*`, `https://api.mistral.ai/*`, `https://*.speech.microsoft.com/*` | first use, prompted | provider APIs (ADR-0003) and local server profiles (ADR-0004). **Nothing network-related is asked at install** |

Rationale: reading the page is the product, so `<all_urls>` is unavoidable at
install; every network destination the extension will ever touch is optional
and requested on first use. Local profiles need host permission only to
actually fetch audio, so the health probes (ADR-0004) stay prompt-free.

## API keys: storage.local, never sync

- Provider API keys (ADR-0003, BYO-key) live in `chrome.storage.local` only.
- Never `chrome.storage.sync` / `browser.storage.sync`: sync replicates to the
  browser profile's cloud account — exactly where secrets must not go.
- The `storage` permission in the T1 manifest exists for this and nothing else.

## CSP / no remote code

- No `content_security_policy` key is set: the MV3 default applies
  (`script-src 'self'; object-src 'self'`) on both Chrome and Firefox — no
  eval, no remote scripts, no remote code in any context.
- Bundled code only. The Azure Speech SDK (ADR-0003, the heavy in-extension
  dependency) will be bundled into the extension build in T2 — never loaded
  from a CDN or remote URL (the default CSP would reject that anyway).

## Audio-owner seam — T2 (documented here, deliberately NOT built in T1)

ADR-0002 splits audio ownership by platform: Chrome runs audio in an offscreen
document (reason `AUDIO_PLAYBACK`); Firefox runs audio in the MV3 background
event page — or, if spike-firefox-eventpage.md shows the event page suspending
mid-read, a hidden persistent page.

T1 does **not** implement this split: the T1 background is a messaging router
only — no `speechSynthesis`, no offscreen permission, no `chrome.tts` usage.
T2's dual-browser deliverable adds the audio-owner abstraction and both
platform owners; every engine and the marching-highlight position tracker will
talk to that owner, never directly to platform audio APIs. Entry-gate probes:

- docs/spike-offscreen-speech.md — Chrome: offscreen `speechSynthesis` vs `chrome.tts`
- docs/spike-firefox-eventpage.md — Firefox: 5-minute event-page playback