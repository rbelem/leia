# Spike: Firefox audio owner — event page 5-minute playback

**Entry gate for T2.** Firefox MV3 uses an event page (ADR-0002), and event
pages may be suspended after seconds of inactivity — including mid-read. This
spike answers: can an event page read for 5 continuous minutes without
suspension? If it suspends, the owner becomes a hidden persistent page.

## What is implemented

| File | Role |
|---|---|
| `src/probes/ff-playback.ts` | Event-page probe: starts a ~5-7 min `speechSynthesis` utterance, writes a heartbeat to `storage.session` every 5s, logs lifecycle markers, and logs a watchdog note on the next wake if the page was suspended mid-playback. Optional 30s `alarms` keepalive (`leia:ff-playback-keepalive`) |
| `src/background/index.ts` | Gated entry points `leia:ff-playback` / `leia:ff-playback-keepalive` (idle when unused; no product behavior) |
| `src/manifest.json` | `alarms` permission added (needed by the optional keepalive; benign otherwise) |

The probe is part of the shared background bundle, so it exists in the Chrome
build too — there it replies `{ok:false}` (the Chrome service worker has no
`speechSynthesis`).

**Probe validity rule:** the `leia:ff-playback` handler returns immediately.
A long-lived promise reply would keep the event page awake and fake the
result — all evidence is streamed via console + `storage.session`, never held
open as a reply.

## Running it

```sh
npm run build
```

1. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary
   Add-on…**, pick `dist/firefox/manifest.json`.
2. On the extension card click **Inspect** to open the background-script
   console (this is the event page's DevTools).
3. Trigger the probe from that console (`browser` is a global in the
   background context):

```js
browser.runtime.sendMessage({ type: "leia:ff-playback" })
```

4. Confirm the reply `{ok:true, data:{stage:"started"}}` and watch the
   console. Check the persisted state any time with:

```js
browser.storage.session.get("leia:ff-playback")
```

## The 5-minute observation protocol

The utterance is ~1000 words (`"This is a long read. "` × 200) ≈ 5-7 min at
normal TTS speed — comfortably past the 5-minute pass gate.

1. **Start:** console shows `[leia ff-playback] start: …` then `onstart @ …s`
   and the first `boundary #1..#5 @ …s` lines (after that, boundaries are
   counted, not logged individually).
2. **Alive:** every ~5s a `hb @ <N>s, boundaries=<M>` line appears and
   `storage.session`'s `lastHb` keeps moving. Boundary count increasing proves
   speech itself is progressing, not just timers.
3. **End:** `end: end @ ≥300s, boundaries=…` clears `active` in storage.
   A pass = `onend` fires at ≥ 5 minutes with no intervening
   `error:canceled` / `error:interrupted` / silent restart, and `lastHb`
   never jumps by many seconds.
4. **Second utterance:** trigger `leia:ff-playback` again right after `end`
   and confirm it also completes (idle-timer reset check).
5. **If it suspends mid-read (expected failure mode):** the `hb` lines go
   silent, audio stops, and the next wake (click the popup, send any message,
   or wait for the keepalive alarm) logs:
   `wake: previous run still active, heartbeat <N>s old … — event page WAS
   suspended mid-playback` (plus a fresh-context `speechSynthesis.speaking`
   note). `storage.session` still shows `active:true` with the frozen `lastHb`
   — that gap is the suspension duration.
6. **Keepalive (optional, only if 5 failed):** arm a 30s alarm that wakes the
   event page on schedule and observe whether it prevents suspension
   entirely (audio gap vs none):

```js
browser.runtime.sendMessage({ type: "leia:ff-playback-keepalive" })
// each wake logs: [leia ff-playback] alarm kick — page woke at …
```

If resume latency or the suspension itself is unacceptable, **the owner
becomes a hidden persistent background page** (or `background.scripts` with
no event-page optimization) as the documented Firefox audio owner.

## Result recording

| Observation | Console line to capture | Verdict |
|---|---|---|
| start | `[leia ff-playback] start: 4400 chars (~5-7 min)…` | |
| first events | `onstart @ Ns`, `boundary #1..#5 @ Ns` | |
| heartbeat cadence | `hb @ Ns, boundaries=M` every ~5s, gap ≤ ~6s | |
| completion | `end: end @ ≥300s, boundaries=M` | |
| suspension | silence in `hb` lines + `wake: … WAS suspended …` on next wake, gap = suspension length | |
| keepalive (if used) | `alarm kick — page woke at …` each cycle | |

## Decision output

`event page survives 5 min?` → (yes / no). That answer fixes the Firefox
audio owner in ADR-0002: event page as-is, or hidden persistent page.