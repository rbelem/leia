# Permissions, keys, CSP — and the audio-owner seam (T2)

Decisions locked in T1 (council amendments). Source of truth:
`src/manifest.json` (+ Firefox patch in `scripts/build.mjs`).

## Permission surface

| Entry | Value | When granted | Why |
|---|---|---|---|
| `activeTab` | required | install | popup ↔ active-tab messaging; no warning, scoped to user gesture |
| `storage` | required | install | `chrome.storage.local` for API keys (T2). No warning |
| `host_permissions` | `<all_urls>` | install | content script + floating bar must be present on every page. The only install-time warning |
| `optional_host_permissions` | `http://localhost/*`, `http://127.0.0.1/*`, `https://api.openai.com/*`, `https://api.elevenlabs.io/*`, `https://api.x.ai/*`, `https://api.mistral.ai/*`, `https://generativelanguage.googleapis.com/*`, `https://*.speech.microsoft.com/*` | first use, prompted | provider APIs (ADR-0003) and local server profiles (ADR-0004). **Nothing network-related is asked at install** |

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

- The MV3 default CSP applies, plus `'wasm-unsafe-eval'`:
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (Firefox keeps the
  default's `upgrade-insecure-requests`, appended in `scripts/build.mjs`).
  `'wasm-unsafe-eval'` is required by the kitten-local engine (ticket 06):
  ONNX Runtime Web and the phonemizer's espeak-ng compile WebAssembly on
  device. It does NOT re-enable `eval()`/remote script — code is still
  bundled-only; the model *weights* are data, fetched once from the pinned
  asset URLs and cached in IndexedDB (never executed).
- Bundled code only. No remote scripts, no CDN loads — ORT's wasm binary is
  copied from node_modules into the build (`audio/kitten/ort/`). The default
  CSP would reject remote wasm anyway.
- First-use model download: `raw.githubusercontent.com/clowerweb/…` (pinned)
  with the `huggingface.co/KittenML/kitten-tts-nano-0.1/resolve/main` URLs as
  fallback. Both send permissive CORS headers, so **no host permission is
  needed or requested** for them (every entry in `optional_host_permissions`
  remains a user-chosen provider API or local voice server).

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