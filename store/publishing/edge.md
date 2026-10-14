# Publishing Leia updates to Edge Add-ons automatically

`scripts/publish-edge.mjs` pushes a built Leia zip to Microsoft Edge Add-ons and submits it for certification without opening Partner Center. It updates an existing product only. The API cannot create a product or edit listing metadata such as descriptions, screenshots, and privacy answers, so the first submission stays manual; follow the runbook in `store/copy/edge.md` for that one. After the product exists, every release can go through this script.

## Sources

All fetched 2026-10-14:

- API overview and auth: <https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api>
- Endpoint reference and operation statuses: <https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference>
- Partner Center submission flow and listing fields: <https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension>

The older page `learn.microsoft.com/en-us/microsoft-edge/extensions/publish/api` cited in earlier notes is gone. The API docs now live under `/extensions/update/api/`.

## Auth

The current API version is v1.1. Every call carries two headers and there is no token exchange:

- `Authorization: ApiKey <key>`
- `X-ClientID: <client id>`

The older v1 scheme exchanged an AAD client secret (tenant id, client id, secret) for a bearer token at login.microsoftonline.com. Microsoft retired it on Dec 31 2024, so this script does not implement it. If you hold v1-era secrets, create fresh credentials below; the API key replaces the client secret.

Secrets come only from the environment, never from flags or files. The script prints redacted placeholders only.

| Variable | Meaning |
|---|---|
| `EDGE_PRODUCT_ID` | the product's ID GUID from Partner Center (Extension overview page) |
| `EDGE_CLIENT_ID` | the Client ID from the Publish API page |
| `EDGE_API_KEY` | the API key from the Publish API page |
| `EDGE_CLIENT_SECRET` | legacy alias for `EDGE_API_KEY`; v1-era configs named the key a client secret, and Microsoft's own samples did too. `EDGE_API_KEY` wins when both are set |
| `EDGE_TENANT_ID` | accepted and ignored; v1.1 has no tenant |

## Setup (once)

1. Sign in at <https://partner.microsoft.com/dashboard/microsoftedge>.
2. Under the Microsoft Edge program, open Publish API.
3. Click Enable next to "enable the new experience" if it appears, then Create API credentials.
4. Copy the Client ID and the API key. Note the key's expiry date; renew it before it lapses or releases start failing with HTTP 401.
5. Store the three values as CI secrets or in your local environment. Never commit them.

The product ID is on the extension's Extension overview page, and also appears as the GUID in the dashboard URL.

## Usage

```
node scripts/publish-edge.mjs --zip store/pkg/leia-edge-<version>.zip [--note "<notes for certification>"] [--dry-run]
```

- Exit 0: the package uploaded, the publish call was accepted, and both operations polled to `Succeeded`. The publish operation's `Succeeded` means "Successfully created submission with ID ...": the submission exists and certification has begun. That is the last synchronous signal; the review outcome and store rollout are asynchronous and take days. Watch Partner Center for them.
- Any failure: one line starting with `error: ` on stderr, exit 1.
- `--dry-run` validates what it can (zip presence, zip magic bytes) and prints every request it would make with secrets redacted. It needs no secrets and makes no network calls.
- `--note` passes your text as the notes for certification. Without it the script sends a short default; passing the testing steps from `store/copy/edge.md` is better.

## The flow

1. `POST /v1/products/<pid>/submissions/draft/package` with the raw zip as the body and `Content-Type: application/zip`. This is not a multipart upload. A 202 response carries a `Location` header with the operation ID.
2. Poll `GET /v1/products/<pid>/submissions/draft/package/operations/<op>` until `status` is `Succeeded` or `Failed`. The script polls every 3s with a 5 minute cap.
3. `POST /v1/products/<pid>/submissions` with `{"notes": "..."}`. A 202 response carries the publish operation ID.
4. Poll `GET /v1/products/<pid>/submissions/operations/<op>` until terminal. The script polls every 10s with a 30 minute cap.
5. Exit 0 only when both operations report `Succeeded`.

The reference page's URI tables omit the `/v1` prefix, but the worked examples on the same page and the live API use it. The script uses `/v1`.

## Same-version submissions

The API has no endpoint to read the live version, so the script cannot pre-check it. Uploading a zip whose version equals the live one does not fail at upload: the draft is replaced (202, then upload operation `Succeeded`), and the publish operation then ends `Failed` with `errorCode: NoModulesUpdated`, message "Can't publish extension since there are no updates, please try again after updating the package." The script turns that into a single error line and exits 1. The live listing is untouched; nothing is half-published, because the store only changes after certification succeeds. Recovery: bump the version in `src/manifest.json`, rebuild, re-zip per the runbook, rerun.

## Failure playbook

HTTP level, from the reference's error table:

- 401 or 403: credentials missing or invalid. Check `EDGE_API_KEY` and `EDGE_CLIENT_ID`, and the key's expiry on the Publish API page. A probe with a bogus key returned HTTP 403 on 2026-10-14, and a malformed client ID returned HTTP 400 "The value of X-ClientID must be a valid GUID", so auth failures do not always use 401.
- 404: the product ID or operation ID is not a valid GUID or belongs to another account.
- 400: the body was rejected, for example an empty zip or a wrong content type. Rebuild the zip per the runbook.
- 408, 429, 5xx: transient. Rerun the script. Reruns are safe because step 1 replaces the draft, and the API refuses a publish that has nothing new rather than duplicating it.

Operation level, when the publish operation ends `Failed` with an `errorCode`:

- `CreateNotAllowed`: the product does not exist yet; do the first submission manually.
- `NoModulesUpdated`: the same version is already live; bump the version and rerun.
- `InProgressSubmission`: a previous submission is still in review; wait for it to finish.
- `UnpublishInProgress`: the product is being unpublished; wait.
- `ModuleStateUnPublishable` or `SubmissionValidationError`: the package or listing has validation errors; fix what the API message names and rerun.

If the script hits its 30 minute poll cap it exits 1 with "still InProgress (not failed)". Re-check the operation later:

```
curl -s -H "Authorization: ApiKey $EDGE_API_KEY" -H "X-ClientID: $EDGE_CLIENT_ID" \
  https://api.addons.microsoftedge.microsoft.com/v1/products/$EDGE_PRODUCT_ID/submissions/operations/<operationId>
```

`InProgress` means still processing, `Succeeded` means the submission was created, `Failed` carries `errorCode` and `message`. Once a submission is created, review progress shows in Partner Center.

## Release checklist

1. Gate: `npm run typecheck && npm test && node scripts/store-check.mjs`.
2. `npm run build`, then zip `dist/chrome` per `store/copy/edge.md` step 2.
3. `node scripts/publish-edge.mjs --zip store/pkg/leia-edge-<version>.zip --note "<testing steps for certification>"`.
4. Exit 0 means submitted for certification; track the review in Partner Center.
