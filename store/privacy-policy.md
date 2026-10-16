# Leia privacy policy

Leia is a browser extension that reads webpages aloud. This policy explains what data the extension handles and where it goes. The short version: Leia has no servers, collects no analytics, and sends nothing anywhere unless you configure a voice provider yourself.

Last updated: 2026-10-16. Applies to Leia 0.1.2 and later.

## What Leia stores, and where

Leia stores everything in your browser's local extension storage, on your device:

- Your settings (voice, rate, highlight theme, engine choice).
- Voice provider API keys, if you add any. Keys are stored with `storage.local` only. Leia never writes them to browser sync, so they never leave your device through profile sync.
- Your reading position per page, so a session can resume where it stopped.

Uninstalling the extension removes all of this.

## What Leia sends over the network

It depends on the voice engine you choose. Each engine discloses its privacy class in the voice picker before you pick it:

- **Browser voices (Web Speech), the default.** Speech is synthesized by your browser or operating system on your device. Leia sends nothing to any server. (Your browser's own speech stack may have its own behavior; that is between you and your browser vendor.)
- **Local model servers.** If you configure a local TTS server (for example Kokoro-FastAPI or a Piper profile), page text is sent from the extension to that server address on your own machine or network. It goes nowhere else.
- **Provider voices.** If you add an API key for a speech provider (for example ElevenLabs, Azure Speech, or OpenAI), Leia sends the text of the page you are reading to that provider so it can be spoken. That provider handles the text under its own terms and privacy policy. Leia asks for your permission the first time it contacts each provider. If you never add a key, no provider is ever contacted.
- **One-time model download.** The built-in on-device kitten engine downloads its model files once from pinned public asset hosts (GitHub raw content and Hugging Face) and caches them on your device. Model weights are data; no code is loaded from the network at runtime.

## What Leia does not do

- No account, anywhere.
- No analytics, telemetry, crash reporting, or tracking of any kind.
- No servers operated by the Leia developers.
- No reading history leaves your device. Reading positions live in local storage.
- No selling or sharing of data, because no data reaches anyone to sell or share.

## Permissions Leia asks for

- Read and change data on all sites: the content script that finds the article, draws the marching highlight, and reads your selection runs on every page. The toolbar action reaches the page you are on through the active-tab and scripting permissions.
- Storage: to keep your settings, keys, and reading positions on your device.
- Loopback addresses (`127.0.0.1`, `localhost`): so the options page can find voice servers running on your own machine.
- Alarms: a periodic alarm wakes the background page so it does not idle out while audio plays (Firefox).
- Offscreen document and background page (platform-specific): to play audio while you read.
- Declarative network requests: to apply required headers, such as an authentication header, on requests to the voice services you configure yourself.
- Optional provider origins (asked on first use, one prompt per provider): only the providers you choose to configure.

## Contact

Questions about this policy: open an issue at https://github.com/rbelem/leia/issues, or use the support contact listed on the store listing where you installed Leia.
