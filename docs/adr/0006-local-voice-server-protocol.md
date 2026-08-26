# ADR-0006: Local voice-server protocol — profiles, /leia/v1 surface, health probing

T11 formalization of ADR-0004. A user-provided local TTS server (sidecar) exposes a small
uniform HTTP surface; Leia registers one engine family per profile (`local-<id>`), keyless,
loopback-only, with non-fatal health probing. Design: oracle lane 2026-08-26.

## Context

ADR-0004 fixes profiles as first-class citizens (add a profile, no code changes). That rule
rejects per-profile adapter code: an "OpenAI-compatible /v1 where offered" approach would need
a code adapter per server shape (OpenAI's `/v1/audio/speech` cannot carry word timestamps).
Instead the sidecar implements a 3-endpoint Leia surface; OpenAI-compatible servers join via a
documented ~50-line shim. Profiles stay pure data.

## Profile model

- A profile is `{ id, name, baseUrl, install }` (install = one-line docker/pip hint for the
  settings UI). Capability set is NEVER stored — discovered by probing.
- Built-ins (code constants, versioned with the extension): `kokoro` →
  `http://127.0.0.1:8880` (stock Kokoro-FastAPI docker port, install works unedited);
  `piper` → `http://127.0.0.1:8881` (Leia convention, documented).
- Custom (T14 settings): user-entered base URL stored at `leia:settings:localProfiles`
  (`{id, name, baseUrl}[]`); family id = `local-<id>`.
- Discovery = probe the two built-ins + user entries. NO port-range scan (slow, noisy,
  cannot satisfy "fast, non-fatal").
- Trust: loopback only (`127.0.0.1` / `::1` / `localhost`), no secrets, keyless family.

## Protocol — /leia/v1

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/leia/v1/health` | Liveness | Any 200 with body `{"ok":true}` = online; must answer < 500ms |
| GET | `/leia/v1/capabilities` | Capability + voice probe | 404 → degrade to defaults |
| POST | `/leia/v1/synthesize` | One chunk → audio + optional words | JSON in/out, one round trip |

`GET /leia/v1/capabilities` → `{ "wordTiming": true, "streaming": false,
"voices": [ {"id", "lang", "name"} ], "maxChars": 2500, "formats": ["wav","mp3"] }`.
`costClass: "free"` and `privacyClass: "local"` are fixed by the family, not probed.
Degrade defaults on 404/malformed: `wordTiming: false` + one synthetic voice
`{id:"default", lang:"en"}` — engine stays usable at sentence granularity (the Piper story).

`POST /leia/v1/synthesize` — request `{ "text", "voice", "rate": 1.0, "format": "wav" }`;
response `{ "format", "audio_b64", "words": [ {"begin", "end", "time_ms"} ] }`:

- `words` OPTIONAL per request; omitted when the server cannot time words. Engine schedules
  word events only when present, and `wordTiming` gates the march layer per contract.
- `begin`/`end` = char offsets into the exact `text` sent, half-open — same semantics as
  `EngineEvent.word` (chunk-relative). `time_ms` = offset from audio start; the server
  applies `rate` to audio AND timestamps.
- Format default `wav` (PCM16): zero encoder on the sidecar, trivial for any TTS pipeline;
  localhost bandwidth makes size irrelevant (≤250-char chunk ≈ 100–300 KB PCM, base64 ×1.33).
  `mp3` optional. base64, not hex (33% vs 100% overhead; `atob` everywhere).
- Errors: any non-2xx → engine emits `error` with `${status} ${body.slice(0,200)}`; body
  shape `{"error": ...}` recommended, not parsed normatively.

## Engine mapping

- One `LocalEngine` per profile under its own `local-<id>` family — multiple profiles
  simultaneously, NO profile-switching machinery: the hub already merges voices and the
  picker groups by family; "active profile" = `hub.select(family)` via existing prefs.
- Offline = invisible: engines stay registered; failed probe → `getVoices()` returns `[]`;
  the voice-driven picker drops the family automatically (analog of keyless-skip). No
  unregister.
- `LocalEngine` is structurally `MiniMaxEngine` minus the key: injected `fetchImpl` +
  `audioHost` (DOM_AUDIO_HOST), EventStream bridging, preempt/cancel parity, MiniMax
  word-scheduling pattern (`time_ms − firstTime − elapsed` vs `playResolvedAt`), base64
  decode (drops hexToBytes). Constructor takes the probed capabilities (per-profile
  descriptor).
- Server dies mid-session: `speak()` fetch rejects → `error` → `drive()` parks the session
  paused (existing behavior — no session changes); engine marks the profile offline
  immediately so picker/settings react.

## Health probe

- `GET {base}/leia/v1/health`, AbortController at 500 ms (localhost RTT is ~ms).
- Non-fatal: probe never throws → `{online, caps}`; health fail → `online:false`; caps 404
  → degraded defaults. Lazy, never blocks audio.
- Triggers (NO background interval — would pin Firefox event page / Chrome SW): audio-owner
  boot; `getVoices()` with cached probe older than 30 s TTL; settings open/refresh (T14);
  `speak()` network error → offline immediately.

## Implementation plan

- `src/audio/engine-local.ts` (LocalEngine per mapping), `src/audio/local-profiles.ts`
  (BUILT_IN_PROFILES, storage read/write `leia:settings:localProfiles`, loopback
  validation, `probeProfile(base)` with 500 ms abort + caps degrade).
- Registration: `src/audio/offscreen/audio.ts` (Chrome) + `src/audio/owner.ts` (Firefox):
  async boot probes each profile, registers engines; web-speech stays default. Manifest
  `host_permissions`: `http://127.0.0.1/*`, `http://localhost/*` (optional-host already
  lists them; move/verify for the offscreen fetch path).
- T14 settings surface: provider-key row minus the key — status dot (probed), base URL
  (editable for custom), install one-liner when offline.
- Tests: `tests/engine-local.test.ts` + `tests/local-profiles.test.ts` with `fetchImpl`
  stubs (sibling pattern; no node:http server needed).
- Out of scope: the server itself. Plausible sidecars: ~50-line FastAPI shim over
  Kokoro-FastAPI (audio + word captions) or sherpa-onnx/Piper (health + caps only).

## Consequences

- **Positive**: profiles stay pure data; per-server code is only ever a user-side shim;
  offline servers are invisible until they appear (TTL refresh self-heals); no background
  timers; session failure semantics unchanged.
- **Negative**: localhost loopback only (no LAN servers in v1); sidecar authors must
  implement the 3 endpoints (small); WAV bytes are fatter than MP3 (irrelevant on
  loopback); two engines may show simultaneously in the picker when both local servers run
  (that is the point — family freedom per ADR-0001).

## References

- ADR-0004 (profiles), docs/engine-contract.md (v1 contract), issue #12.
- Endpoint spec table above is normative for sidecar implementers.