# Engine contract (v1)

Formal specification of the voice-engine adapter contract — the seam ADR-0001
introduced. Normative for engine lanes (T5/T7/T8/T9/T10/T11/T20) and for the
EngineHub routing layer. Source of truth: `src/reader/contract.ts`
(annotated working v1); this document must not drift from it.

## Context

- v0 in `src/reader/contract.ts` was the working draft shaped by the T2/T3
  Web Speech work; **T6 formalizes it** into the v1 contract specified here.
- **T20** (MiniMax Speech-2.8, #20) added the `word` event, the capability
  descriptor, and the engine-family routing requirement — all behind the
  ADR-0001 seam. T6 makes the seam formal.
- The family dimension is the ADR-0001 seam made explicit: the hub keys
  engines by family id and routes selection, so the engine family is a
  first-class choice (cost/quality/privacy trade-off) rather than a fixed
  engine.

## Adapter contract

### TextEngine

```ts
export interface TextEngine {
  /** Engine family identifier (e.g. "web-speech", "minimax"). */
  readonly family: string;
  /** Capability disclosure (see below); rendered by the picker (ADR-0003). */
  readonly capabilities: EngineCapabilities;
  getVoices(): Promise<VoiceInfo[]>;
  /**
   * Speak one chunk. Yields events until the chunk ends; the iterable
   * completes after the terminal event. Only one active speak at a time —
   * a new `speak()` preempts the current one (which yields `cancelled`).
   */
  speak(text: string, speakId: number, options: SpeakOptions): AsyncIterable<EngineEvent>;
  /** Interrupt the current chunk; its stream yields `cancelled` and closes. */
  cancel(): void;
  /** Optional: switch the engine's active family (multi-family engines). */
  selectFamily?(family: string): void;
}
```

`VoiceInfo` is tagged with the family it belongs to (`family: string`), so
merged voice lists can be grouped and filtered by the picker.

### SpeakOptions

- `voiceName: string | null` — voice by name, engine family-specific; `null`
  = engine default voice.
- `rate: number` — playback rate multiplier (0.5–3).

### EventStream semantics

Engines bridge callback APIs into the `AsyncIterable<EngineEvent>` contract
with `EventStream` (`src/reader/event-stream.ts`): a **push-based queue with a
single consumer**. Producers `push()` events (queued if the consumer has not
started iterating yet) and `close()` the stream; `closeCancelled()` pushes a
terminal event then closes (used by preemption paths). Pushing after close is
a no-op.

Terminal-event rules: a stream ends exactly one of three ways — the **last
event is `end`** (completed), **`cancelled`**, or **`error`**. After a
terminal event the iterable completes and further pushes are ignored.
`start` and `word` are non-terminal: a stream that has emitted them must
still terminate with one of the three terminal events.

### EngineEvent union

| type | fields | terminal |
|---|---|---|
| `start` | `speakId` | no |
| `word` | `speakId`, `begin`, `end` | no |
| `end` | `speakId` | yes |
| `error` | `speakId`, `message` | yes |
| `cancelled` | `speakId` | yes |

`word` semantics — **`begin`/`end` are character offsets relative to the
chunk text** (the exact string passed to `speak()`), half-open `[begin, end)`.
Engines report offsets from their own tokenizer (e.g. MiniMax subtitle word
offsets, Azure `WordBoundary` offsets), which are not guaranteed to align
with the reader's Intl.Segmenter segmentation. The marching layer (reader
core / session) maps engine offsets onto the T4 word↔range map by matching
token text, not by raw offset. Engines without timestamp support **omit word
events entirely** (capability `wordTiming: false`); consumers then run the
highlight at sentence granularity via the T4 map.

`isEngineEventTerminal(ev)` — `true` only for `end` / `error` / `cancelled`.

## Capability descriptor

```ts
export interface EngineCapabilities {
  wordTiming: boolean;   // engine emits `word` events with chunk-relative char offsets
  streaming: boolean;    // audio starts before the whole chunk is synthesized
  costClass: "free" | "paid";
  privacyClass: "local" | "provider";
}
```

Disclosure rules (ADR-0003): the **voice picker renders the descriptor** per
engine. A missing capability degrades the highlight, never the engine:
`wordTiming: false` → sentence-granularity marching highlight (via the T4
map); `streaming: false` → batch REST synthesis with optional pipelining
(ADR-0003) to hide the gap. Providers without timestamps (OpenAI) are shown
**with their real capabilities, never hidden**. `costClass` is the free/paid
cost disclosure; `privacyClass` states whether page text leaves the device
toward a provider.

## Engine family dimension

`EngineHub` (`src/audio/hub.ts`) registers engines by family id and routes:

- **Register / select**: one engine per family id; `hub.selectFamily(family)`
  selects the active family (Web Speech is the default). `speak`, `cancel`,
  and `capabilities` route to the selected family's engine.
- **Merged voice lists**: `hub.getVoices()` merges across families with the
  default family's voices first; each entry carries its `VoiceInfo.family`
  tag. **Keyless engines are skipped** — a BYO-key family with no configured
  key contributes no voices and is never routed to.
- **Engine-level `selectFamily?`**: engines that bundle several families
  (e.g. a local-profile server class instantiated per ADR-0004 profile) may
  switch internally; the hub hands the family id through.
- **Per-engine key story**: providers are bring-your-own-key. Keys live in
  extension storage only, under `leia:settings:<family>Key` (e.g.
  `leia:settings:elevenlabsKey`) — never in a central service (ADR-0003). A
  missing key hides the family's voices from the picker; the settings UI
  shows the key call-to-action.

## Engine registry

| family | engine | wordTiming | streaming | costClass | privacyClass | status |
|---|---|---|---|---|---|---|
| `web-speech` | Web Speech API (`src/audio/engine-webspeech.ts`) | false | false | free | local | current |
| `minimax` | MiniMax Speech-2.8 (#20) | true | false | paid | provider | current |
| `elevenlabs` | ElevenLabs (T8, #9) | true | false | paid | provider | planned |
| `azure` | Azure Speech (T9, #10) | true | true | paid | provider | planned |
| `openai` | OpenAI TTS (T10, #11) | false | false | paid | provider | planned |
| `local-kokoro` | Kokoro-FastAPI (T11, #12, ADR-0004) | true | false | free | local | planned |
| `local-piper` | sherpa-onnx / Piper (T11, #12, ADR-0004) | false | false | free | local | planned |

Local server profiles map to `local-*` hub families per ADR-0004; an engine
is registered only while its profile's health probe is online.

## Chunking contract

- **Chunker** (`src/reader/chunker.ts`) constraints: chunks never cross
  sentence boundaries; ≤ `MAX_TOKENS_PER_CHUNK` (3) sentences per chunk; ≤
  `cap` total chars (`MAX_TOKEN_CHARS` = 250 for Latin sessions;
  `CJK_TOKEN_CHARS` = 100 for CJK sessions — the CJK cap keeps utterances
  short, avoiding the Chrome silent-stop bug). Tokens are pre-capped to ≤ the
  limit, so no chunk can exceed it by construction; the 300-char ceiling
  holds via the 3-sentence cap.
- **Engine-side length limits**: providers impose their own request caps —
  MiniMax is 10k chars per request, chunked within the engine (T20).
- **Preemption**: one active speak per engine; a new `speak()` preempts the
  current one, whose stream yields `cancelled` and closes. `cancel()` does
  the same for the current chunk.
- **Pause** = cancel-and-replay-from-token (T2): pause cancels the current
  utterance and records the token position; resume re-speaks from that
  token. Seek (T7) reuses the same mechanism from a clicked token.

## Open items (next revision)

- **Streaming transport**: websocket/async streaming for engines that offer
  it (MiniMax stream variants), so `streaming: true` engines feed audio
  incrementally end to end.
- **Per-token confidence / correction** (T5): estimated-timing fallback for
  engines without word events (`wordTiming: false`), with boundary-event
  drift correction; the Web Speech estimator lands against this contract.
- **Pipelining** (ADR-0003): synthesize chunk N+1 while chunk N plays to
  hide batch-REST latency (ElevenLabs), keeping inter-chunk gaps under ~1s.