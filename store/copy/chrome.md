# Chrome Web Store submission runbook

Sources for every requirement below (fetched 2026-10-14):

- Images: <https://developer.chrome.com/docs/webstore/images/> (icon 128x128 in the zip, small promo 440x280 required, marquee 1400x560 optional, screenshots 1280x800 or 640x400, at least 1 / up to 5)
- Listing tab: <https://developer.chrome.com/docs/webstore/cws-dashboard-listing/>
- Manifest prep (132-char description, manifest at zip root): <https://developer.chrome.com/docs/webstore/prepare/>
- Publishing flow (2-item limit for new publishers): <https://developer.chrome.com/docs/webstore/publish/>
- Privacy tab: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/>

## Fields

| Dashboard field      | Value                                                                                                                             | Source of truth                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Item name            | `Leia: Read Aloud`                                                                                                                | manifest `name` (read-only after upload) |
| Short description    | manifest `description` (105/132 chars)                                                                                            | manifest (read-only)                     |
| Detailed description | paste `store/copy/long-description.md` (plain text; markdown syntax does NOT render on CWS, the file is written plain on purpose) | copy.json                                |
| Category             | Accessibility                                                                                                                     | copy.json                                |
| Language             | English (en-US)                                                                                                                   | copy.json                                |
| Homepage URL         | `https://github.com/rbelem/leia` (repo root)                                                                                      | copy.json `homepage_url`                  |
| Support URL          | `https://github.com/rbelem/leia/issues` (repo issues; repo is public)                                                             | copy.json `support_url`                   |

## Assets

| Upload slot                                         | File                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Store icon (in the zip, not the dashboard)          | `icons/icon128.png` (128x128, square art inside per CWS sizing guidance)                                      |
| Screenshots (1 to 5)                                | `store/screenshots/article-wikipedia-1280x800.png`, `store/screenshots/article-speech-synthesis-1280x800.png` |
| Small promo tile (required)                         | `store/promo/cws-small-tile-440x280.png`                                                                      |
| Marquee promo tile (optional, needed for featuring) | `store/promo/cws-marquee-1400x560.png`                                                                        |

## Privacy tab answers

- Single purpose: "Reads webpages aloud with a highlight that follows the spoken words."
- Data usage disclosures: check "Website content" — Leia reads page text aloud and, when you configure a provider key, sends page text to that provider for speech synthesis. Leia collects nothing else: no personal data, no health, no financial, no communications, no location, no web history, no user activity, no website content storage beyond local settings.
- Privacy policy URL: required because Leia handles website content via provider engines. Paste `https://github.com/rbelem/leia/blob/main/store/privacy-policy.md` (copy.json `privacy_policy_url`).
- Certification: no data sold; no data used for unrelated purposes; not used for creditworthiness/lending.

## Review notes to paste (Item review notes / permissions justification)

```
Single purpose: Leia reads webpages aloud and draws a highlight that follows
the spoken words on the page.

activeTab + scripting + <all_urls> content script: the product runs on the
page itself — it locates the article, splits it into sentences, and applies a
marching highlight synced to the audio. Nothing is uploaded.

storage: settings, voice-provider API keys (storage.local only, never sync),
and per-URL reading positions, all on device.

host_permissions (loopback 127.0.0.1/localhost/[::1]): the options page probes
TTS servers running on the user's own machine. No remote host access at
install.

optional_host_permissions (provider APIs, wss token host): requested on first
use per provider, only when the user adds their own API key. Page text goes to
that provider for speech synthesis only when the user configures it.

offscreen: plays synthesized audio in an offscreen document so reading
survives tab switches.

declarativeNetRequest + alarms: keep the audio owner alive and route engine
requests within the declared origins.

Remote code: none. All code ships in the package. The on-device engine
downloads model weights (data, never code) once from pinned GitHub/Hugging
Face URLs and caches them in IndexedDB.
```

## Steps

1. Gate first: `npm run typecheck && npm test && node scripts/store-check.mjs`.
2. Package: `npm run build` then `cd dist/chrome && 7z a -tzip ../../store/pkg/leia-chrome-<version>.zip .` (manifest must sit at the zip root; `zip -r ... .` is equivalent).
3. Upload the zip at <https://chrome.google.com/webstore/devconsole>. First upload triggers the $5 one-time registration fee.
4. Fill the tabs in this order: Privacy → Store listing → Distribution. The item stays in draft until every required field validates.
5. Submit for review. New publishers can publish at most two items.
