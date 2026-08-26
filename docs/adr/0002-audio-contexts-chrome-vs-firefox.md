# ADR-0002: Audio playback contexts differ between Chrome and Firefox

Chrome MV3 extensions have no DOM in the background service worker, so audio playback (speechSynthesis or fetched provider streams) must run in an offscreen document created with the `AUDIO_PLAYBACK` reason. Firefox MV3 uses event pages, which retain DOM access, so no offscreen document exists there.

This split is a platform constraint, not a preference: the reader must maintain one audio-owner abstraction that resolves to the offscreen document on Chrome and to the background event page on Firefox. All engines and the marching-highlight position tracker talk to that owner, never directly to the platform.

## Consequences

- Chrome has exactly one offscreen document per extension — it hosts all audio activity (providers, Web Speech, local streams).
- Firefox background pages can go idle; the audio owner abstraction must wake them on command (alarms/events) rather than relying on a resident page.
- `chrome.tts` (Chrome-only extension API with reliable word events) may be wrapped as an engine-family variant later; it bypasses the offscreen owner but still reports through the same adapter contract.