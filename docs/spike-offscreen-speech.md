# Spike: Chrome audio owner — offscreen `speechSynthesis` vs `chrome.tts`

**Entry gate for T2.** Files + checklist only — the browser run happens later.
Winner of this spike becomes the Chrome default free engine (Web Speech family,
ADR-0001). `chrome.tts` (ADR-0002) is the alternative Chrome-only contender.

## 1. Offscreen document probe (`speechSynthesis`)

Bundle and load an offscreen document (`reason: "AUDIO_PLAYBACK"`) hosting
these probes. Log each result back to the service worker via `chrome.runtime`.

Offscreen page needs:

```ts
import browser from "webextension-polyfill";

browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.type) {
    case "leia:probe-voices":
      // 1. voices list populates
      const voices = await new Promise<SpeechSynthesisVoice[]>((res) => {
        const v = speechSynthesis.getVoices();
        if (v.length) return res(v);
        speechSynthesis.addEventListener("voiceschanged", () => res(speechSynthesis.getVoices()));
        setTimeout(() => res(speechSynthesis.getVoices()), 1500);
      });

      // 2. boundary events fire
      const events: string[] = [];
      const u = new SpeechSynthesisUtterance("hello world, this is leia.");
      u.voice = voices.find(v => v.localService) ?? voices[0];
      u.onboundary = (e) => events.push(`boundary@${e.charIndex}`);
      u.onend = () => log({ stage: "speechSynthesis:end", events });
      u.onerror = (e) => log({ stage: "speechSynthesis:error", error: e.error });

      // 3. audio actually audible — human check, see step 4
      speechSynthesis.speak(u);
      break;
  }
});
```

### Checklist (offscreen)

- [ ] `chrome.offscreen.createDocument({ reason: "AUDIO_PLAYBACK" })` succeeds from the service worker
- [ ] `getVoices()` is non-empty and local voices present (or at least one usable voice)
- [ ] `onboundary` fires with a usable `charIndex` (word-level marching highlight, ADR-0001)
- [ ] **Audio is actually audible** (wear headphones / confirm system audio) — if the offscreen document is silent, this fails the spike regardless of events
- [ ] One function call `chrome.tts` — skip this probe if the user is on Linux where tts is often a dummy engine; record which platform was tested
- [ ] No `onerror` (esp. `not-allowed`, `interrupted`, `canceled`) during a 30s read

## 2. `chrome.tts` comparison probe (service worker side)

```ts
import browser from "webextension-polyfill";

const events: string[] = [];
chrome.tts.speak("hello world, this is leia.", {
  onEvent: (ev) => {
    events.push(`${ev.type}@${typeof ev.charIndex === "number" ? ev.charIndex : "-"}`);
    if (ev.type === "end") {
      console.log("tts:end", events);
    }
  },
});
```

### Checklist (`chrome.tts`)

- [ ] `speak()` accepted without a registered engine error (`"extension load error"` / "not installed")
- [ ] Word events (`"word"`) delivered with non-`undefined` `charIndex` (Chrome-only reliable word timing — the reason tts is in the frame)
- [ ] `end` event fires
- [ ] Audio audible (human check), on macOS/Windows at least; Linux may be a dummy engine

## Decision output

| | Offscreen `speechSynthesis` | `chrome.tts` |
|---|---|---|
| Voices usable | ? | ? |
| Word `charIndex`/boundary | ? | ? |
| Error-resilient events | ? | ? |
| Audio in offscreen / no user-gesture need | ? | n/a |

**Default engine:** (fill in) → one becomes the Web Speech Chrome default; the
other stays as an engine capability variant behind the adapter seam.