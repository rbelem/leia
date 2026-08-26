# ADR-0003: Provider family ships multiple engines with capability disclosure

The provider engine family ships with ElevenLabs, Azure Speech, and OpenAI TTS in the MVP, deliberately, even though they differ sharply in what they support. The user's decision: support all, and tell the user per engine what works and what doesn't.

Capabilities are a first-class concept, disclosed in the voice picker: highlight granularity (ElevenLabs character-level alignment and Azure streaming `WordBoundary` events give word-level sync; OpenAI has no timestamps and runs at sentence granularity), streaming behavior, cost class, and privacy class (page text leaves the device toward the chosen provider). A provider with no timestamp data is not hidden — it is shown with its real capability, because the marching highlight is an engine capability, not a product promise.

## Considered Options

- **ElevenLabs only**: best quality, simplest REST; but the user asked for all providers.
- **Azure only**: best sync, cheaper; but loses ElevenLabs voices.
- **OpenAI only**: no timestamps at all — sentence-granularity reader, fails the product's core promise.

## Consequences

- The adapter contract must carry a capability descriptor per engine; the picker UI renders it.
- Pipelining (synthesize chunk N+1 while chunk N plays) hides ElevenLabs' non-streaming timestamp endpoint.
- Azure requires the Speech SDK inside the offscreen audio owner (Chrome) / event page (Firefox), heavier than plain REST.
- All provider engines are BYO-key: keys live in extension storage, never in a central service.