# Spike: Chrome audio owner — offscreen `speechSynthesis` vs `chrome.tts`

**Entry gate for T2.** Winner of this spike becomes the Chrome default free
engine (Web Speech family, ADR-0001). `chrome.tts` (ADR-0002) is the
alternative Chrome-only contender.

## What is implemented

| File | Role |
|---|---|
| `src/probes/offscreen.html` + `src/probes/offscreen.ts` | Offscreen document (`AUDIO_PLAYBACK`) running the `speechSynthesis` probes |
| `src/probes/tts-probe.ts` | Service-worker-side `chrome.tts` comparison probe |
| `src/probes/chrome-apis.ts` | Inline typings for Chrome-only APIs (`offscreen`, `tts`) — polyfill types don't cover them |
| `src/background/index.ts` | Probe entry points: creates the offscreen doc, forwards `leia:probe-*` messages, logs streamed `leia:probe-result` messages. No product behavior |
| `src/manifest.json` | `offscreen` permission + declared offscreen doc (`probes/offscreen.js`, reason `AUDIO_PLAYBACK`, creation `PROBE`) |

All of it is gated behind probe-only message types; popup/content/background
product behavior is unchanged. Chrome versions: runtime `offscreen` API needs
Chrome 109+; the manifest-declared `offscreen` key is only honored on newer
Chrome (the SW falls back to runtime creation, and the "only a single
offscreen document" error is swallowed). Firefox has no `offscreen` API — the
probes reply `{ok:false, error}` there and are ignored.

## Running it

```sh
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, pick `dist/chrome/` (project root).
2. Open the service worker console: on the extension card click the
   **service worker** link (a DevTools window for the SW opens).
3. Trigger each probe from that console (`chrome` is a global there):

```js
// 1. voices: report count / names / sync-vs-voiceschanged
chrome.runtime.sendMessage({ type: "leia:probe-voices" })

// 2. speechSynthesis on the offscreen document (audio should be audible)
chrome.runtime.sendMessage({ type: "leia:probe-speak" })

// 3. cancel any running offscreen utterance
chrome.runtime.sendMessage({ type: "leia:probe-cancel" })

// 4. chrome.tts comparison, straight from the SW
chrome.runtime.sendMessage({ type: "leia:tts-probe" })
```

Each `sendMessage` resolves with the probe's report; the SW additionally logs
every streamed event as `[leia probe] <probe> <data>` (e.g. one line per
`speak:boundary`), which is what you transcribe into the table below.

**CDP alternative:** launch Chrome with `--remote-debugging-port=9222`, find
the `service_worker` target (`/json`), and `Runtime.evaluate` the same
expressions with `awaitPromise: true` to capture the report object directly;
watch the SW console for the streamed `[leia probe]` lines.

## Checklist (offscreen `speechSynthesis`)

- [ ] First `leia:probe-voices` trigger also proves
      `chrome.offscreen.createDocument({reasons:["AUDIO_PLAYBACK"]})` succeeds
      (a failure returns `{ok:false}` from the SW instead of a report)
- [ ] `voices` report shows `populatedSync` (true → Chrome populated voices on
      first `getVoices()`; false → `waitMs` after `voiceschanged`) and
      `count > 0` with `localCount` noted
- [ ] `leia:probe-speak` streams `speak:start`, then `speak:boundary` events
      with numeric `charIndex` (+ `charLength` when the engine provides it) —
      word-level marching highlight needs these (ADR-0001)
- [ ] `speak:end` arrives with `elapsedMs` and no `speak:error`
      (esp. `not-allowed`, `interrupted`, `canceled`)
- [ ] **Audio is actually audible** (wear headphones / confirm system audio) —
      if the offscreen document is silent, the spike fails regardless of events
- [ ] A second `leia:probe-speak` after the first also completes
- [ ] `leia:probe-cancel` reports `canceled` and any running utterance stops

## Checklist (`chrome.tts`, service worker)

- [ ] `leia:tts-probe` returns `{ok:true}` with a `voices` list (if Linux:
      often a dummy/empty engine — record which platform was tested, macOS or
      Windows is the meaningful run)
- [ ] Events include `word` with numeric `charIndex` (Chrome-only reliable
      word timing — the reason `tts` is in the frame)
- [ ] A terminal `end` event fires (`error`/`interrupted`/`cancelled` count as
      failures) with `elapsedMs`
- [ ] Audio audible (human check)

## Result recording

| Probe | Console line to capture | Verdict |
|---|---|---|
| offscreen voices | `[leia probe] voices {populatedSync, waitMs, count, localCount, names}` | |
| offscreen speak:start | `[leia probe] speak:start {elapsedMs}` | |
| offscreen boundary | `[leia probe] speak:boundary {charIndex, charLength, elapsedMs}` (one per event — note whether `charLength` is ever undefined) | |
| offscreen speak:end | `[leia probe] speak:end {elapsedMs, boundaries}` | |
| offscreen error | `[leia probe] speak:error {error, elapsedMs}` | |
| tts voices | `[leia tts-probe] voices: [...]` | |
| tts events | `[leia tts-probe] word@<charIndex>/<charLength>` … `end@…` | |
| audible? | human check (headphones) | |

## Decision output

| | Offscreen `speechSynthesis` | `chrome.tts` |
|---|---|---|
| Voices usable | ? | ? |
| Word `charIndex`/boundary | ? | ? |
| Error-resilient events | ? | ? |
| Audio in offscreen / no user-gesture need | ? | n/a |

**Default engine:** (fill in) → one becomes the Web Speech Chrome default;
the other stays as an engine capability variant behind the adapter seam.
Amend ADR-0002 with the winner and the concrete `charIndex` evidence.
## T2 note (product offscreen document)

T2 moved the manifest `offscreen` declaration to the product audio owner
(`offscreen/audio.html`, creation `ALL` — see `src/audio/owner.ts`). Only one
offscreen document may exist per extension, so probe runs and product
sessions are mutually exclusive in a profile: while a product session holds
the offscreen slot, `leia:probe-voices` etc. reply `{ok:false, error:
"receiving end does not exist"}` (the creation error itself is swallowed).
Run probes in a fresh profile (or before the first product session).

## Headless run (2026-08-26, Chrome for Testing 149, headless=new)

Executed via `scripts/spike-drive.mjs` (CDP: open popup tab → `chrome.runtime.sendMessage`). Verdict:

| Probe | Result | Meaning |
|---|---|---|
| `leia:probe-voices` | `{populatedSync:false, waitMs:1503, count:0, localCount:0, names:[]}` | Offscreen doc + routing work; **headless exposes zero voices** (no speech platform) |
| `leia:probe-speak` | `{stage:"error", error:"synthesis-failed", elapsedMs:1}` | Utterance plumbing works end-to-end (SW→offscreen→events→reply); **headless speech stack refuses to synthesize** |
| `leia:tts-probe` | `chrome.tts unavailable` | **`chrome.tts` is absent in headless** (speech subsystem disabled) |

**Conclusion:** the probe harness is proven and reproducible; all three verdicts are headless artifacts. The Chrome default-engine decision NEEDS a GUI session: run this checklist in a real Chrome (load `dist/chrome` unpacked, drive via SW console with `chrome.runtime.sendMessage({type:"leia:probe-voices"|"leia:probe-speak"|"leia:tts-probe"})`), and record the GUI result here before amending ADR-0002.
