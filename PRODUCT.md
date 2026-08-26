# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Browser extension — MV3 Chrome ≥109 / Firefox ≥140. All surfaces — popup, floating reading bar, settings — are web technology with a web design language; the host browser is the operating context.)

## Users

Primary audience is broad by design; Leia serves all of these without picking a single lane:

- Readers with visual or reading challenges (dyslexia, low vision, fatigue) who follow along with the highlight.
- Multitaskers and commuters who listen to articles while doing other things.
- Language learners reading along in a foreign language, including CJK.
- General article listeners who prefer audio over screen reading.

The job in every case: turn a webpage into an attended listening experience where the text being spoken is visibly marked.

## Product Purpose

Leia reads webpages aloud with a highlight that follows the speech. It exists so that reading and listening are interchangeable on any article: start a session, follow along in place, leave and resume exactly where you stopped, click any sentence to jump the audio there. Success means a session that feels as natural as reading — the extension gets out of the way.

## Positioning

The claim a rival reader extension could not truthfully copy: the user owns the voice. One adapter seam covers the entire speech ecosystem — free browser voices, any BYO provider API (ElevenLabs/Azure/OpenAI), and local privacy-first models via localhost server profiles — with a fully offline, no-account reading path as a first-class option, not a fallback. Capabilities are disclosed per engine up front; the user never discovers limits by trial.

## Operating Context

- The user installs the extension (Chrome: unpacked `dist/chrome` or the store; Firefox: temporary load or AMO) and reads ordinary articles on the live DOM.
- Reading happens in place on the article (spec-locked decision): the march highlight is applied to the real page text via a Readability-located article root, not an overlay.
- Voice sources range from zero-setup (Web Speech API) through BYO provider keys to a locally run TTS server (Kokoro-FastAPI, sherpa-onnx/Piper profiles; any compatible server via a profile).
- Sessions can span visits: reading position is saved per URL and resumed later. Audio playback is hosted off the content page (Chrome offscreen document; Firefox event page — event-page persistence still under spike verdict).

## Capabilities and Constraints

Confirmed:

- Pluggable voice engines behind one adapter seam: Web Speech (default), provider APIs (ElevenLabs/Azure/OpenAI, BYO key), localhost TTS server profiles.
- Word-level marching highlight where the engine provides timestamps; sentence-level otherwise. Granularity is a disclosed engine capability.
- Click-to-seek on text; per-URL reading-position resume.
- Multi-locale, including CJK (Intl.Segmenter segmentation, ~100-char chunks).
- Contrast-adaptive predefined highlight themes: samples the background behind each text run and picks the variant with sufficient contrast, falling back to outline/underline.
- In-place highlighting on the live DOM; article scope via Readability-located root; selection-based scope also supported.
- Platform floor: Chrome ≥109, Firefox ≥140.

Undecided (recorded honestly, not invented):

- Chrome default free engine: offscreen `speechSynthesis` vs `chrome.tts` — pending user-side spike verdict; drop-in point `src/audio/owner.ts`.
- Firefox audio owner: event page vs hidden persistent page — pending spike verdict (wake-watchdog).
- Extension distribution channels and pricing, if any.

Terminology is normative in `CONTEXT.md` (voice engine, read scope, marching highlight, highlight theme, engine capability, local server profile, reading position). Architecture decisions in `docs/adr/0001..0004`.

## Brand Commitments

- Name **Leia** is binding: Portuguese imperative of *ler* — "read!" — a quiet pun on asking the AI to read it aloud. The name stays; the pt-br etymology is the identity story.
- No Star Wars theming — the name is not a reference; no visual identity or assets exist yet beyond the name itself.
- No other voice, personality, or visual commitments have been made. Nothing beyond the name is binding.

## Evidence on Hand

- Working tracer bullet: sentence marching highlight, selection read, ReaderSession, Chrome offscreen / Firefox direct audio (commit `ae78dd8`); 33 tests green; `npm run typecheck/test/build` clean for both dists.
- Spec: GitHub issue #1 + tickets #2–#19; binding in-place-highlight resolution in T3.
- Spike runbooks: `docs/spike-offscreen-speech.md`, `docs/spike-firefox-eventpage.md`; permissions model `docs/permissions.md`; platform floor `docs/platform-floor.md`.
- ADRs 0001–0004 (adapter seam, Chrome/Firefox audio split, capability disclosure, local server profiles); ADR-0002 has a pending amendment slot for the two spike verdicts.
- No real users, testimonials, benchmarks, or market data exist. Future work must not fabricate them.

## Product Principles

1. **The user owns the voice.** Engine freedom is the product claim: free, BYO-provider, and local models are equal citizens behind one seam, with capabilities disclosed, never discovered by trial.
2. **Listening never replaces reading; it attends it.** The highlight, click-to-seek, and per-URL resume keep audio bound to the text, so a session can be left and rejoined like a book with a bookmark.
3. **Local-first is a real path, not a fallback.** A no-account, device-local reading experience must be complete and first-class, not an afterthought with missing features.
4. **The highlight must always be legible.** Whatever the page's colors, the marching highlight adapts for contrast — that is a correctness property, not a preference.
5. **Accessibility is baseline, not a mode.** Assistive reading (dyslexia, low vision) is a primary audience, so keyboard-first operation, calm pacing, and clarity hold for everyone.

## Accessibility & Inclusion

- Follow-along reading for people with dyslexia, low vision, and reading fatigue is a primary use case, not an accommodation.
- Highlight themes are contrast-adaptive to page background, with outline/underline fallback when no color variant has sufficient contrast.
- CJK and mixed-locale reading are first-class (Intl.Segmenter), which also serves language learners.