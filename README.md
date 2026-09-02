# Leia

A browser extension (Chrome + Firefox) that reads webpages aloud using
pluggable AI voices — provider APIs, an on-device model, or local servers —
with a highlight that follows the speech. Vocabulary (voice engine, read
scope, marching highlight, engine capability, local server profile, reading
position) is defined in CONTEXT.md; architecture decisions in docs/adr/.

**Status — working product.** Select text or read the whole page; audio
plays through the engine you pick and a marching highlight tracks the words.
Eight provider engines, an on-device engine, and five built-in local-server
profiles ship in one TypeScript codebase that builds both MV3 packages.

## Layout

```
src/audio/        engines (TextEngine contract) + EngineHub multiplexer
src/background/   message router; Chrome service worker / Firefox event page
src/content/      content script: page text, highlighting, scope
src/floating-bar/ selection pill and inline controls
src/offscreen/    Chrome offscreen document: audio host + engine home
src/popup/        action popup: voice picker, provider keys, local profiles
src/manifest.json source manifest; scripts/build.mjs patches it per browser
scripts/build.mjs esbuild bundler → dist/chrome + dist/firefox
shims/            containerized local model servers (piper, kittentts, …)
tests/            vitest (jsdom)
docs/             permissions, engine contract, platform floor, spikes
```

## Scripts

| Command | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | vitest run (jsdom) |
| `npm run build` | esbuild → `dist/chrome` + `dist/firefox` |

## Load in Chrome

```sh
npm install        # esbuild, vitest, @mozilla/readability, onnxruntime-web
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

## Voices

Pick a voice family in the Leia popup. Three tiers:

**Cloud providers** — paste an API key in the popup settings (stored in
`browser.storage.local`; each origin is requested as an optional host
permission when you save the key):

| Provider | Notes |
|---|---|
| ElevenLabs | word timing supported |
| OpenAI | MP3, curated voices |
| Azure Speech | SSML pipeline, word timing |
| MiniMax | hex-encoded MP3 envelope |
| xAI (Grok) | raw MP3, 28 voices, `eve` default |
| Mistral (Voxtral) | voices are your account's saved voices, fetched live |
| Gemini | PCM → WAV, 30 voices, `Kore` default |

**On-device** — Kitten (nano) runs entirely in the browser via ONNX Runtime
Web, free and offline-capable. First use downloads ~25 MB of model files —
the popup discloses this before it happens — then it works with no server
and no key.

**Local servers** — Leia can drive a loopback server that speaks the
ADR-0006 contract (`/leia/v1/health`, `/capabilities`, `/synthesize`).
Built-in profiles ship under the popup's local-servers list, each with a
copy-pasteable run line:

| Profile | Port | What |
|---|---|---|
| Kokoro | 8880 | stock Kokoro-FastAPI image, works unedited |
| Piper | 8881 | fastest, GPL-3 server process |
| Kittentts | 8882 | ~real-time on CPU |
| Neutts | 8883 | LLM backbone, slowest, most expressive |
| Edge | 8884 | free Microsoft voices — text leaves your machine |

To run the four shim models you need [podman](https://podman.io) (or
docker): `podman build` + `podman run` one-liners per model, the server
contract, curl verification, and honest speed/license notes are all in
[shims/README.md](shims/README.md).

## Build from source (store submission)

The `dist/*.zip` store payloads are built from this exact source:

```sh
npm install           # installs esbuild, vitest, @mozilla/readability
npm test              # vitest run (jsdom)
npm run build         # esbuild bundles src/*.ts → dist/chrome + dist/firefox
node scripts/zip.mjs  # → dist/chrome.zip + dist/firefox.zip
```

esbuild bundles without minifying. The only source transform is
`scripts/readability-patch.mjs` (wired in `scripts/build.mjs`): it rewrites
two `.innerHTML =` statements inside the vendored `@mozilla/readability`
into a DOMParser-based equivalent — see that file for the exact diff.

## Decisions

- docs/permissions.md — permission surface (optional host permissions, CSP
  including `wasm-unsafe-eval` for the on-device engine), key storage,
  audio-owner seam
- docs/engine-contract.md — the TextEngine family contract all voices implement
- docs/platform-floor.md — Custom Highlight API floor: Chrome ≥ 105, Firefox ≥ 140
- docs/adr/0006 — local voice-server protocol (profiles, probe, synthesize)
- docs/spike-offscreen-speech.md, docs/spike-firefox-eventpage.md — audio-owner probes
