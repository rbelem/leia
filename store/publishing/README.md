# Autonomous publishing

Push a tag `vX.Y.Z` and `.github/workflows/release.yml` runs the gates, builds both dists, proves the double-build byte equality, attaches the packages to a GitHub release, and publishes each store whose secrets are configured. Stores without secrets run their publish script in `--dry-run`, so the mechanism is exercised on every release and the workflow is green from the very first tag.

## The flow of one release

1. `git tag v0.1.2 && git push origin v0.1.2`
2. The `build` job runs `npm ci`, typecheck, tests, stamps the version from the tag into `src/manifest.json` and `package.json` (`scripts/stamp-version.mjs`), builds, runs `store-check`, packages reproducible zips (`scripts/reprozip.py`, fixed epoch from the tag commit), rebuilds and repackages to prove byte equality, and attaches everything to a GitHub release with a `.sha256` file.
3. Each `publish-*` job downloads the packages and runs its store script. With secrets, it publishes. Without, it dry-runs and exits green.

## Secrets

| Store | Secret(s) | Where it comes from |
|---|---|---|
| Chrome | `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` | Google Cloud OAuth client (Chrome Web Store is the only enabled API) + a long-lived refresh token minted from the OAuth consent flow. The classic one-liner is in `store/publishing/chrome.md`. |
| Firefox | `AMO_API_KEY`, `AMO_API_SECRET` | AMO developer hub, Manage API Keys (https://addons.mozilla.org/developers/addon/api/key/). Optional repo *variable* `AMO_CHANNEL` (`listed` default, `unlisted` while in beta) and `AMO_ADDON_ID` (defaults to `leia@rclb.dev`). |
| Edge | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Partner Center → Account settings → Microsoft Edge program: create API keys on the "Publish API" page and copy the product ID from the extension's overview page. Auth is the v1.1 API-key scheme; the old AAD client-secret flow was retired by Microsoft on Dec 31 2024 (`EDGE_CLIENT_SECRET` still works as a legacy alias for the API key; `EDGE_TENANT_ID` is unused). The API cannot create products: do the first submission manually per `store/copy/edge.md`, and every release after that is automatic. Details in `store/publishing/edge.md`. |

Per-store behavior notes live next to each script: `store/publishing/chrome.md`, `firefox.md`, `edge.md`.

## Dry runs, locally

```
node scripts/publish-chrome.mjs  --zip store/pkg/leia-chrome-0.1.1.zip --dry-run
node scripts/publish-firefox.mjs --zip store/pkg/leia-firefox-0.1.1.zip \
  --src-zip store/pkg/leia-0.1.1-sources.zip --dry-run
node scripts/publish-edge.mjs    --zip store/pkg/leia-chrome-0.1.1.zip --dry-run
```

Every dry-run must exit 0 with zero secrets in the environment. That is the CI guarantee for an unconfigured store, so the scripts fail their own CI if it breaks.

## Reproducible packages, locally

```
npm ci && npm run build
EPOCH=$(git log -1 --format=%ct)
python3 scripts/reprozip.py --root dist/chrome --out /tmp/a.zip --epoch "$EPOCH"
npm run build
python3 scripts/reprozip.py --root dist/chrome --out /tmp/b.zip --epoch "$EPOCH"
sha256sum /tmp/a.zip /tmp/b.zip   # equal bytes
```

The CI `build` job runs exactly this comparison and fails the release if the two builds differ.

## Failure playbook

- **Duplicate version (AMO).** AMO rejects a version string that already exists on the addon. The script says so in one line. Bump the tag: `git tag -d v0.1.2 && git tag v0.1.3` (or amend the release), push again.
- **Chrome upload but publish failed.** The Chrome API keeps a drafted item state; re-running the script re-uploads (overwrite) and re-issues the publish. Safe to re-run the job.
- **Edge submission stuck in certification.** The script waits for the API's acceptance into certification, not for human certification to finish; finish in Partner Center. Re-running replaces the draft package, so a fix is one tag away.
- **AMO validation warnings.** The script reports them from the poll result. Warnings do not block listing but read them: AMO reviewers cite the same lints.
- **Gate failure in `build`.** Nothing publishes: all publish jobs depend on the build job. Fix forward with a new tag; never force-push a tag that already published.
- **Wrong version published somewhere.** Publish a new tag with the fix. Store versions are append-only in practice; do not try to yank a version in the dashboards while CI is the source of truth.

## What live secrets still have to prove

Everything up to the first real publication was verified without credentials: script dry-runs exit 0 clean, and each lane's request shape was proven against the store's real auth endpoint with deliberately bogus credentials (expecting the documented 401 or 400). The first configured release is the first time a real upload happens. Watch the first one by hand, then trust the automation:

1. Check the version landed on each listing page (the dashboards show it under the item's versions).
2. Confirm the AMO source attachment passed automated review (validation result in the script output).
3. Read the first AMO validation warnings before ignoring them forever.
