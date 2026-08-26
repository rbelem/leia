# ADR-0001: Voice engines behind one adapter seam

We build a reader (Leia) for Chrome and Firefox in which every voice source — Web Speech API, provider APIs, local model servers — is an interchangeable engine behind a single adapter interface. The user asked for local AI and provider voices; we deliberately make the engine family a first-class dimension rather than a fixed choice, because each family has a different cost/quality/privacy trade-off and the user expects to switch.

The adapter contract exposes: textual chunking, streamed audio (or speak calls), word-level timestamps when the engine can provide them (ElevenLabs, local models), and an estimated-timing fallback (Web Speech, whose boundary events are unreliable per Chromium/Firefox bugs). Engines that lack timestamps degrade the marching highlight to sentence granularity — the granularity is an engine capability, not a product decision.

## Considered Options

- **Web Speech only**: zero setup, but voice quality and event reliability are browser-dependent and it cannot satisfy the explicit "local AI or providers" requirement.
- **Provider only**: best quality, but per-character cost and API keys as a hard requirement for every user.
- **Local only**: private and free, but requires a sidecar server.

## Consequences

- MVP is larger: three adapters instead of one.
- The settings UI must group voices by engine family.
- Text is segmented once (per locale) and reused by every engine, so timestamps and the marching highlight stay engine-agnostic.