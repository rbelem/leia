# Spike: Firefox audio owner — event page 5-minute playback

**Entry gate for T2.** Firefox MV3 uses an event page (ADR-0002), and event
pages may be suspended after seconds of inactivity — including mid-read. This
spike answers: can an event page read for 5 continuous minutes without
suspension? If it suspends, the owner becomes a hidden persistent page.

## Probe

From the Firefox event page (`background/scripts` in the build), start a
6-minute `speechSynthesis` utterance and log lifecycle markers. Drive it via
`browser.runtime.onMessage` from the popup or a test page.

```ts
import browser from "webextension-polyfill";

const startedAt = Date.now();

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "leia:start-probe") return;

  const u = new SpeechSynthesisUtterance(
    `Leia probing continuous playback. ${"This is a long read. ".repeat(120)}`
  );
  u.onstart = () => log("start");
  u.onboundary = () => log(`boundary@${(Date.now() - startedAt) / 1000}s`);
  u.onend = () => log(`end@${(Date.now() - startedAt) / 1000}s`);
  u.onerror = (e) => log(`error:${e.error}@${(Date.now() - startedAt) / 1000}s`);

  // reset the idle timer: an event page stays alive while it has work or
  // a fresh event; a pure read with no events may still be suspended
  speechSynthesis.speak(u);
});

function log(line: string): void {
  console.log(`[leia eventpage probe] ${line}`);
  // persist so a restart can be detected: storage or an extra alarm
  void browser.storage.local.set({ last: `${Date.now()}:${line}` });
}
```

## Checklist

- [ ] `onstart` fires
- [ ] `onboundary` fires repeatedly across the whole utterance (continuous work)
- [ ] **`onend` fires at ≥ 5 minutes** without an intervening `error:canceled` / `error:interrupted` / silent restart — this is the pass gate
- [ ] No service-worker-style suspension visible: `browser.storage.local`
      `last` timestamp does not jump by many seconds between boundaries
- [ ] A second utterance immediately after the first also completes (idle timer reset check)
- [ ] Document in docs/platform-floor.md whether a hidden persistent page is the owner

## If it suspends mid-read (expected failure mode)

- First try restarting the utterance from `browser.storage` state + an alarm
  kick (`chrome.alarms` wakes the event page on schedule) — note audio gap
- If resume latency or the suspension itself is unacceptable, **the owner
  becomes a hidden persistent background page** (or `background.scripts` with
  no event-page optimization) as the documented Firefox audio owner

## Decision output

`event page survives 5 min?` → (yes / no). That answer fixes the Firefox audio
owner in ADR-0002: event page as-is, or hidden persistent page.