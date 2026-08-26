# Leia

A browser extension (Chrome + Firefox) that reads webpages aloud using pluggable AI voices — local models or provider APIs — with a highlight that follows the speech.

## Language

**Voice engine**:
A pluggable source of synthesized speech behind a single adapter interface. Three families: Web Speech API, provider API (OpenAI/ElevenLabs/…), local model server.
_Avoid_: provider, backend, TTS engine

**Read scope**:
The content the reader reads in a session — either the user's selection or the article extracted from the page.
_Avoid_: content, page

**Marching highlight**:
The highlight that tracks the text currently being spoken. Granularity is a word where the engine provides word timing, a sentence otherwise.
_Avoid_: cursor, active highlight

**Highlight theme**:
A predefined set of related colors plus an adaptation rule: the reader samples the background behind each text run and picks the palette variant with sufficient contrast, falling back to outline/underline when no variant works.
_Avoid_: color scheme, palette (alone)

**Engine capability**:
A declared, user-visible property of a voice engine: highlight granularity it can serve (word or sentence), streaming, cost class, privacy class (device-local vs provider). The voice picker discloses capabilities per engine; the user must never discover them by trial.
_Avoid_: feature flag, metadata

**Local server profile**:
A named localhost TTS server the local engine family can talk to — base URL, known endpoints, capability probe. Kokoro-FastAPI and sherpa-onnx/Piper ship as profiles; any compatible server integrates by adding a profile.
_Avoid_: server adapter, plugin

**Reading position**:
The saved point in a read scope (per-URL) that lets a later session resume where the previous one stopped.
_Avoid_: bookmark, checkpoint