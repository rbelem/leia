# Microsoft Edge Add-ons submission runbook

Source for every requirement below (fetched 2026-10-14):

- Publishing flow and store listing fields: <https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension>
  - Extension logo: required, 1:1, recommended 300x300 (min 128x128)
  - Small promotional tile: optional, 440x280
  - Large promotional tile: optional, 1400x560
  - Screenshots: max 6, 640x480 or 1280x800, one caption each
  - Name + description come from the manifest and are read-only in Partner Center

## Fields

| Partner Center field           | Value                                                                                       | Source of truth                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension name                 | `Leia: Read Aloud`                                                                          | manifest `name` (read-only)                                                                                                                                |
| Description                    | manifest `description` (read-only) + long description field                                 | paste `store/copy/long-description.md` (plain text; avoid special characters like bullets that the certification step rejects — the file is written plain) |
| Short name / short description | first lines of the long description                                                         |                                                                                                                                                            |
| Category                       | Accessibility                                                                               | copy.json                                                                                                                                                  |
| Website / Support              | `https://github.com/rbelem/leia` / `https://github.com/rbelem/leia/issues` (repo is public) | copy.json                                                                                                                                                  |
| Search terms                   | copy.json `keywords_tags`                                                                   | copy.json                                                                                                                                                  |

## Assets

| Upload slot                       | File                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension logo (required)         | `store/icons/leia-300.png` (300x300)                                                                                                                                              |
| Small promotional tile (optional) | `store/promo/edge-small-tile-440x280.png`                                                                                                                                         |
| Large promotional tile (optional) | `store/promo/edge-large-tile-1400x560.png`                                                                                                                                        |
| Screenshots (max 6)               | `store/screenshots/article-wikipedia-1280x800.png` ("A highlight follows the spoken words"), `store/screenshots/article-speech-synthesis-1280x800.png` ("Reading a real article") |

## Properties, privacy, certification

- **Single purpose description**: "Reads webpages aloud with a highlight that follows the spoken words."
- **Permission justifications**: same text as the CWS notes in `chrome.md` (Partner Center asks per permission).
- **Remote code**: None. (ONNX wasm ships in the package; the on-device engine downloads model weights, which are data.)
- **Data usage certification**: no data sold; no data used for unrelated purposes. Leia collects nothing; the BYO-key provider path sends page text to the provider the user chose.
- **Privacy policy URL**: required. Paste `https://github.com/rbelem/leia/blob/main/store/privacy-policy.md` (copy.json `privacy_policy_url`).
- **Notes for certification**: how to test (install, open any article, press Alt+Shift+L, watch the highlight; voices need at least one engine: system voices, a local server, or a provider key).

## Steps

1. Gate first: `npm run typecheck && npm test && node scripts/store-check.mjs`.
2. Package: `npm run build` then `cd dist/chrome && 7z a -tzip ../../store/pkg/leia-edge-<version>.zip .` (Edge takes Chrome MV3 packages as-is).
3. Register at <https://partner.microsoft.com/dashboard/microsoftedge> (free, one account), then Create new extension and upload the zip.
4. Fill: Availability (Public, all markets) → Properties → Privacy (single purpose, justifications, remote code, data usage, privacy URL) → Store listings (logo, tiles, screenshots with captions, search terms).
5. Paste the testing steps into Notes for certification and submit. Review is usually a few business days.
