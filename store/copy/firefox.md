# Firefox Add-ons (AMO) submission runbook

Sources for every requirement below (fetched 2026-10-14):

- Summary limit and listing guidance: <https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/> (summary 250 chars, screenshots 1280x800 recommended, up to two categories)
- Submission flow: <https://extensionworkshop.com/documentation/publish/submitting-an-add-on/>
- Source submission for minified bundles: <https://extensionworkshop.com/documentation/publish/source-submission/> (reviewers must be able to read the code; esbuild bundles count as generated, so attach sources)
- Signing and distribution: <https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/>

## Fields

| AMO field | Value | Source of truth |
|---|---|---|
| Add-on name | `Leia: Read Aloud` | manifest `name` |
| Summary (≤250) | `store/copy/copy.json` `amo_summary` (155/250 chars) | copy.json |
| Description (Markdown supported) | paste `store/copy/long-description.md` (plain text renders fine as Markdown) | copy.json |
| Tags | copy.json `keywords_tags` | copy.json |
| Categories (up to 2) | Accessibility + one more if it fits | copy.json |
| Supported platforms | Linux, Mac, Windows; include Android only if you test it (build sets gecko_android min 142) | |
| Homepage / Support | repo issues page if public | |

## Assets

| Upload slot | File |
|---|---|
| Icon | already in the package (`icons/icon32/48/128.png`); AMO shows it from the manifest |
| Screenshots | `store/screenshots/article-wikipedia-1280x800.png`, `store/screenshots/article-speech-synthesis-1280x800.png` (1280x800 is AMO's recommended size) |
| No banner needed | AMO has no promo tile upload |

## Data disclosure

The build already declares what AMO's review policy expects (see
`scripts/build.mjs`): `data_collection_permissions` with `required: ["none"]`
and `optional: ["websiteContent"]`. Answer the developer hub's data-collection
questions the same way: required collection = none; the optional
website-content flag is the provider-engine path (page text sent to the
provider the user configured).

## Review notes to paste (Review Notes)

```
Leia reads webpages aloud with a highlight that follows the speech.

The bundles are minified (esbuild). Attached: source archive + build
instructions (node scripts/build.mjs, see store/pkg/README-amo-src.md).
The @mozilla/readability vendored file is patched at build time to avoid
innerHTML assignments; see scripts/readability-patch.mjs.

Permissions:
- <all_urls> content script: the reader runs on the page (article location +
  marching highlight). Nothing is uploaded.
- storage: settings, provider API keys (storage.local only), per-URL reading
  positions.
- loopback hosts: options page probes local TTS servers on the user's machine.
- optional host permissions: requested on first use, only for providers the
  user configures. No remote host is touched without that.

Data collection: none by default. The optional websiteContent flag covers the
BYO-key provider path (page text -> the provider the user chose). The data
_collection_permissions in the manifest declares exactly this.

Remote code: none. ONNX Runtime wasm ships in the package; the kitten engine
fetches model weights (data) once from pinned URLs.
```

## Steps

1. Gate first: `npm run typecheck && npm test && node scripts/store-check.mjs`.
2. Package: `npm run build` then `cd dist/firefox && 7z a -tzip ../../store/pkg/leia-firefox-<version>.zip .`
3. Prepare the source archive AMO reviewers get: `git archive -o store/pkg/leia-<version>-sources.zip HEAD` (a source tarball also works; `store/pkg/README-amo-src.md` ships inside as the build instructions and already exists in this repo).
4. Submit at <https://addons.mozilla.org/developers/> → Submit a New Add-on. Upload the package zip, fill the listing from the tables above, paste the review notes, attach the source zip in the version's file details ("Provide source code for review").
5. First listed versions get human review; expect questions about the bundle. The notes above pre-answer the common ones.
