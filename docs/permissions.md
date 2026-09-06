# Permissions, keys, CSP — and the audio-owner seam (T2)

Decisions locked in T1 (council amendments). Source of truth:
`src/manifest.json` (+ Firefox patch in `scripts/build.mjs`).

## Permission surface

| Entry | Value | When granted | Why |
|---|---|---|---|
| `activeTab` | required | install | popup ↔ active-tab messaging; no warning, scoped to user gesture |
| `storage` | required | install | `chrome.storage.local` for API keys (T2). No warning |
| `host_permissions` | `http://127.0.0.1/*`, `http://localhost/*`, `http://[::1]/*` | install (mandatory) | the options page probes local voice servers directly (ADR-0006) — loopback-only, keyless, so no prompt gate would make sense; listed alongside `<all_urls>` in the install warning |
| content-script `matches` | `<all_urls>` | install | content script + floating bar must be present on every page. Drives the install-time warning |
| `optional_host_permissions` | `https://api.openai.com/*`, `https://api.elevenlabs.io/*`, `https://api.x.ai/*`, `https://api.mistral.ai/*`, `https://generativelanguage.googleapis.com/*`, `https://*.speech.microsoft.com/*` | first use, prompted | provider APIs (ADR-0003). **No remote host is asked for at install** |

Rationale: reading the page is the product, so `<all_urls>` is unavoidable at
install; every *remote* network destination the extension will ever touch is
optional and requested on first use. The loopback hosts are the exception,
deliberately mandatory: the options page health-probes local servers itself
(ADR-0006), and a first-use permission prompt for the user's own machine
would be noise. They widen the install-time warning's host list but grant no
access beyond this machine.

## API keys: storage.local, never sync

- Provider API keys (ADR-0003, BYO-key) live in `chrome.storage.local` only.
- Never `chrome.storage.sync` / `browser.storage.sync`: sync replicates to the
  browser profile's cloud account — exactly where secrets must not go.
- The `storage` permission in the T1 manifest exists for this and nothing else.

## CSP / no remote code

- The MV3 default CSP applies, plus `'wasm-unsafe-eval'`:
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (Firefox keeps the
  default's `upgrade-insecure-requests`, appended in `scripts/build.mjs` —
  EXCEPT in the dev `--dev` build, which drops it so the harness's loopback
  WS is not upgraded to `wss://`; see `SPEC.md`). `default-src 'self'` and a
  `connect-src` are also set in `src/manifest.json`:
  - `connect-src` allows the extension's own loopback harness bridge
    (`ws://127.0.0.1:9333`, `http://127.0.0.1:9333`, + localhost) **and** the
    kitten-local asset origins (`https://raw.githubusercontent.com`,
    `https://huggingface.co`). These origins MUST be listed: `connect-src`
    governs the runtime `fetch()` the kitten worker uses for its model, and a
    loopback-only `connect-src` silently blocks that first-use download
    (regression caught in validation).
  - `'wasm-unsafe-eval'` is required by the kitten-local engine (ticket 06):
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
  remains a user-chosen provider API or local voice server). The fetch is
  governed purely by the CSP `connect-src` above, so the origins must stay
  listed there.

## Web Speech (`web-speech` family) — documented platform limitation
TTS voices via the browser Web Speech API (`speechSynthesis.getVoices()`) are
**not exposed** on this Linux host even though the system TTS stack
(`speech-dispatcher` with pico/flite/espeak-ng) is fully working — `spd-say -L`
lists voices and all modules speak. This is a browser-platform gap, not an app
or host config issue:
- Firefox desktop does not surface speech-dispatcher voices to Web Speech
  (Mozilla bug 1837789); `getVoices()` returns `[]` and `speak()` never fires.
- Chromium's Web Speech API has no Linux engine wired, so `getVoices()` returns
  `[]` and `chrome.tts` is absent in headless Chromium.
Consequently the `web-speech` family silently-completes/errors on this box and
the `start`/`pause`/`seek` path reports "no speech voices available". This is
**expected**; it does not affect the `kitten-local` (on-device) family or the
provider (network) families, which work. There is no reproducible host fix for
the browser Web Speech gap; validate Web Speech on a host where the browser
surfaces voices, and use the kitten-local/probe surface for on-device speech.

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