# Chrome Web Store autonomous publishing

`scripts/publish-chrome.mjs` publishes `store/pkg/leia-chrome-<version>.zip` to the Chrome Web Store with three API calls: a refresh-token exchange, a PUT upload of the zip, and a POST publish to the public channel. The release workflow (`publish-chrome` job) runs it on every tag, in `--dry-run` when the secrets are not configured, live when they are.

API reference for every endpoint and response shape below (fetched 2026-10-14):

- Using the API: <https://developer.chrome.com/docs/webstore/using-api>
- Items resource, publish method, error fields: <https://developer.chrome.com/docs/webstore/api>

## Command

```
CWS_EXTENSION_ID=... CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... \
  node scripts/publish-chrome.mjs --zip store/pkg/leia-chrome-<version>.zip
```

Add `--dry-run` to print the exact requests with every secret as `***` and exit 0 without reading credentials. Any failure prints exactly one line starting with `error:` and exits 1. Exit 0 means published.

The script reads credentials only from the environment and never prints their values, error messages included. The endpoints it calls, verbatim from the reference:

| Step | Method and URL | Success signal |
|---|---|---|
| Token exchange | `POST https://accounts.google.com/o/oauth2/token` with `grant_type=refresh_token`, the client id, the client secret, the refresh token | response carries `access_token` (valid one hour) |
| Upload | `PUT https://www.googleapis.com/upload/chromewebstore/v1.1/items/$ITEM_ID`, headers `Authorization: Bearer` + `x-goog-api-version: 2`, body is the zip | `uploadState` is `SUCCESS` |
| Publish | `POST https://www.googleapis.com/chromewebstore/v1.1/items/$ITEM_ID/publish` (no `publishTarget` param, the API default, meaning public) | `status` array contains `OK` |

## One-time setup

Do the manual first submission from `store/copy/chrome.md` first: the API uploads packages and publishes, it cannot fill the privacy tab, listing tab, or the review notes.

1. Enable two-step verification on the publisher's Google account. The Publish API refuses updates without it.
2. In Google Cloud Console, create a project, then enable the "Chrome Web Store API" on it.
3. Configure the OAuth consent screen: External, fill in the required app info, add the publisher's account under test users.
4. Create credentials of type OAuth client ID, application type Desktop app. That yields the client id and the client secret.
5. Mint a refresh token for the scope `https://www.googleapis.com/auth/chromewebstore`. The classic path is Google's OAuth Playground (<https://developers.google.com/oauthplayground>): open its settings, check "Use your own OAuth credentials", paste the client id and secret, authorize the scope, exchange the code, copy the refresh token. The offline `urn:ietf:wg:oauth:2.0:oob` redirect shown in the official docs was shut down by Google in 2022 and no longer works for new clients.
6. The item id (`CWS_EXTENSION_ID`) is the long string in the developer dashboard URL for the item.
7. Store the four values as GitHub Actions secrets (`CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`) and, for local runs, in your shell environment. Never commit them.

## Driving the dashboard over CDP (first submission)

The Publish API cannot fill the privacy tab, the listing tab, or the review
notes, so the first submission is manual. The whole flow also runs under CDP
(Chrome DevTools Protocol) against a logged-in dashboard, which is how the
0.1.2 submission on 2026-10-14 was produced. Facts for this item:
`CWS_EXTENSION_ID=edaedoahpgocdflmgmjjfifpfpgdepmn`, publisher account
`0ec818d2-d9a0-492f-8b6e-85c8a85465e3`.

Launch Chrome with a dedicated profile and a debug port. A profile under the
flatpak app directory survives reboots and is always visible to the sandbox:

```
nohup flatpak run com.google.Chrome \
  --user-data-dir="$HOME/.var/app/com.google.Chrome/config/google-chrome/leia-cws" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --start-maximized \
  "https://chromewebstore.google.com/devconsole" >/tmp/opencode/chrome-cws.log 2>&1 &
```

Sign in inside the window (operator step; the login persists in the profile).
Attach to the page target from `http://127.0.0.1:9222/json` over a plain
WebSocket (Node 22+ has a native client) and drive it with
`Runtime.evaluate`, `Page.captureScreenshot`, `DOM.setFileInputFiles` and
`Input.dispatchMouseEvent`.

Lessons that cost time, in order of pain:

- The UI renders in the account's language (pt-BR here). Navigate by URL
  (`.../edit/package`, `/edit/listing`, `/edit/privacy`, `/edit/distribution`)
  and by DOM structure, never by label text.
- Package upload: the upload button opens an in-page dialog that contains a
  real `input[type=file]`. Set the file with `DOM.setFileInputFiles` (the repo
  directory is flatpak-visible through its own permission) and dispatch
  `input` + `change` events on the input. `Page.setInterceptFileChooserDialog`
  never fires on this console.
- Listing images work the same way, one slot at a time: store icon 128x128,
  screenshots 1280x800 (a new input appears after each upload), small promo
  tile 440x280. Re-scan and address slots by index; keyword walks over
  ancestor sections lie once the DOM re-renders.
- Category and language are Google jsaction dropdowns. Synthetic `.click()`
  does nothing. `scrollIntoView` the option inside the popup (it opens upward
  with an internal scroller), read `getBoundingClientRect`, then send
  `mouseMoved` / `mousePressed` / `mouseReleased` via
  `Input.dispatchMouseEvent`. Radios and checkboxes need the same trusted
  click on the control itself, never on the label text.
- `Runtime.evaluate` shares one global scope across calls: a top-level `const`
  in one call breaks every later call with `SyntaxError`. Wrap every
  expression in an IIFE.
- Fields commit into the framework's model, not the DOM. After setting a
  value, confirm the character counter (for example `74/2.048`), save the
  draft, reload the page and re-read the field. The privacy-policy URL
  silently dropped on the first save without this check.
- Two account-level gates block any first submission: a verified publisher
  contact email (Configurações, "Adicionar e-mail", then "Verificar endereço
  de e-mail" sends the link) and the EEE trader declaration. Both are
  one-time and need the operator.
- "Por que não consigo enviar?" lists the current blockers verbatim. The
  submit dialog carries the "publish automatically after review" checkbox;
  keep it checked so an approval goes live on its own. The
  broad-host-permissions warning on submit is expected for this manifest
  (`<all_urls>` content script plus loopback host permissions) and only
  signals a longer in-depth review.

## Re-runs and version conflicts

- The zip's manifest version must be strictly higher than the live version. The store rejects a duplicate or lower version at the upload step; the script prints the store's own message and exits 1 before any publish. Fix is a new tag, per the publishing README.
- Uploading while a draft exists replaces the draft. Uploading while the previous version is under review is rejected with an in-review message; wait for the review to finish and rerun.
- If the upload succeeds but publish fails, the draft keeps the new package. Rerunning the job re-uploads (replacing the draft again) and re-issues the publish, so it is always safe to rerun.

## Failure playbook

The script surfaces the API's own message in its single `error:` line. What each known message means:

| Error line says | Cause and fix |
|---|---|
| `token exchange failed (HTTP 401): invalid_client` | Wrong client id or client secret. Check the Cloud Console values and that the secrets are mapped to the right env names. |
| `token exchange failed ... invalid_grant` | The refresh token was revoked, expired, or belongs to another client. Mint a new one (setup step 5). Rotating the client secret also invalidates refresh tokens. |
| `token exchange failed ... admin_policy_enforced` | The account's Google Workspace policy blocks the OAuth grant. Use a personal or unmanaged account for the publisher. |
| `upload rejected ... version` (same or lower version) | The tag already published, or an older tag was re-pushed. Cut a new tag. |
| `upload ... in review` | The previous version is still under store review. Wait, then rerun. |
| `upload failed (uploadState FAILURE)` | The package itself failed validation. The `itemError` text names the problem; rebuild from a clean `npm run build` and re-zip per `store/copy/chrome.md`. |
| `publish did not succeed (status ITEM_PENDING_REVIEW)` | The store took the submission into review instead of accepting it. Watch the dashboard; nothing is broken, but the script did not get an `OK`. |
| `publish did not succeed (status NOT_AUTHORIZED, DEVELOPER_NO_OWNERSHIP, INVALID_DEVELOPER, ...)` | The OAuth client's account does not own the item, or the account is suspended. Check that the client and the item belong to the same Google account. |
| `request failed: ...` | The network call itself failed (DNS, proxy, timeout). Rerun; nothing was published. |

## What this script deliberately does not do

- No retry logic: a rerun is the retry, and every failure leaves a safe state.
- No trusted-tester target: publish goes to the public channel. The `?publishTarget=trustedTesters` variant exists in the API if a staged rollout is ever wanted.
- No status polling: the API has no "review finished" endpoint; reviews are watched in the dashboard.
- No zip creation: `reprozip.py` in the release workflow and `store/copy/chrome.md` locally own packaging.
