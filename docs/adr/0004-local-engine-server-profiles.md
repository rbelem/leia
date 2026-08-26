# ADR-0004: Local engine family targets discoverable server profiles

The local engine family ships with two server profiles — Kokoro-FastAPI (OpenAI-compatible API plus a word-level captioned endpoint) and sherpa-onnx serving Piper (no word timestamps yet; sentence-granularity highlight on that profile). Any other local TTS server integrates later by adding a profile: base URL, known endpoints, capability probe — no code changes to the family.

Profiles are discovered, not assumed: the extension probes localhost health endpoints per profile, surfaces offline servers in settings with install instructions (one-line Docker or pip), and hides the engine from the voice picker while offline. The family talks OpenAI-compatible `/v1` surface where the server offers it, so the profile registry stays thin.

## Considered Options

- **Kokoro-FastAPI only**: simplest, timestamps available; but the user asked for Piper too.
- **Piper only**: mature and fast, but no timing — weaker highlight sync.
- **Defer local entirely**: violates the core "local AI" requirement of the product.

## Consequences

- Two install paths (Docker, pip) to document in settings.
- Word-level sync on local is only as good as the profile's timestamp endpoint; Piper profile reads at sentence granularity until sherpa-onnx exposes timestamps (open feature request #3705).
- The health probe must be fast and non-fatal: a server appearing mid-session refreshes the engine list.