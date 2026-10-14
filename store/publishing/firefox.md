# Firefox Add-ons (AMO) autonomous publishing

`scripts/publish-firefox.mjs` publishes `store/pkg/leia-firefox-<version>.zip` to AMO with three requests: a multipart upload of the zip, a poll of the upload until AMO's validator finishes, and a multipart version create that attaches `store/pkg/leia-<version>-sources.zip` as the version's source archive. The release workflow (`publish-firefox` job) runs it on every tag, in `--dry-run` when the secrets are not configured, live when they are.

API reference for every endpoint and field below (fetched 2026-10-14):

- addons-server API v5, add-ons resource (upload create, upload detail, version create): <https://addons-server.readthedocs.io/en/latest/topics/api/addons.html>
- addons-server API v5 authentication (JWT shape and claims): <https://addons-server.readthedocs.io/en/latest/topics/api/auth.html>
- Submission flow and the 200 MB package cap: <https://extensionworkshop.com/documentation/publish/submitting-an-add-on/>
- Why the source archive is mandatory for minified bundles: <https://extensionworkshop.com/documentation/publish/source-code-submission/>

## Command

```
AMO_API_KEY=... AMO_API_SECRET=... \
  node scripts/publish-firefox.mjs \
    --zip store/pkg/leia-firefox-<version>.zip \
    --src-zip store/pkg/leia-<version>-sources.zip
    # --channel unlisted while in beta; --dry-run for the plan only
```

Add `--dry-run` to print the exact requests with every secret as `***` and exit 0 without reading credentials. Any failure prints exactly one line starting with `error:` and exits 1. Exit 0 means the upload passed AMO's validator (the script polls until `processed` is true and `valid` is true) and the version was created (HTTP 201). Signing and, for the first listed versions, the human source review stay async on AMO's side; watch the dev hub or the confirmation email.

The script reads credentials only from the environment and never prints their values, error messages included. The endpoints it calls, verbatim from the reference:

| Step | Method and URL | Body | Success signal |
|---|---|---|---|
| Upload | `POST https://addons.mozilla.org/api/v5/addons/upload/` | multipart `upload` (the zip), `channel` (`listed` or `unlisted`) | 201 with the upload object (`uuid`, `url`); validation then runs server side |
| Poll | `GET <url from the upload response>` every 5s, up to 15min | none | `processed: true`; `valid: false` fails the run with the linter errors, warnings are printed and do not block |
| Version create | `POST https://addons.mozilla.org/api/v5/addons/addon/<addon id>/versions/` | multipart `upload` (the uuid), `source` (the source archive), `approval_notes` (extracted from the fenced block in `store/copy/firefox.md`) | 201 version object |

Every request carries `Authorization: JWT <token>`. The script mints the HS256 JWT itself with `node:crypto` (`iss` is the API key, `exp` is 60s past `iat`, well inside the 5 min the reference allows). No dependencies are added.

## Why the raw API and not sign-addon

`sign-addon` signs a package but has no step that attaches a source archive. The Firefox bundle is esbuild-minified, so AMO requires the source archive with every version (see `store/copy/firefox.md`). The v5 version create endpoint takes the archive in the same multipart POST as the `upload` uuid, which is what the script uses.

## One-time setup

Do the manual first submission from `store/copy/firefox.md` first. The API uploads packages and attaches sources; it cannot fill the listing, the license, the categories, or the review notes.

1. On the add-on's dashboard page, open Manage API Keys (<https://addons.mozilla.org/developers/addon/api/key/>).
2. Generate a key. That yields the API key (`AMO_API_KEY`, shaped like `user:12345:67890`) and the API secret (`AMO_API_SECRET`). A revoked or regenerated key invalidates the old secret.
3. Store both as GitHub Actions secrets (`AMO_API_KEY`, `AMO_API_SECRET`) and, for local runs, in your shell environment. Never commit them.
4. Optionally set the repo variables the workflow forwards: `AMO_ADDON_ID` (defaults to `leia@rclb.dev`) and `AMO_CHANNEL` (`listed` by default, set to `unlisted` while the release is in beta).

## Re-runs and version conflicts

Every run uploads a fresh copy, so a failed version create leaves nothing behind and rerunning is safe. The one rejection to expect is a version number AMO already has. The script prints one line telling you to bump it. Bump the tag (`git tag -d v0.1.2 && git tag v0.1.3`), push again. Uploads that were never turned into versions just sit in the account's upload history and are harmless.

## Failure playbook

- **HTTP 401 on any step.** Wrong or revoked `AMO_API_KEY`/`AMO_API_SECRET`, or clock skew (the JWT window is 60s). Regenerate the key pair or sync the clock, then rerun.
- **`AMO validation failed:` with linter messages.** The package itself was rejected. Fix the build, rebuild and repackage, rerun. Messages come straight from the upload detail's validation blob.
- **`version X already exists on AMO`.** Duplicate version. Bump the tag and rerun, as above.
- **Validation warnings in the success output.** They do not block publishing. Read them anyway; AMO reviewers cite the same lints, and security or privacy warnings can fail the later human review.
- **Poll timeout after 15min.** Open the upload url from the error line in the dev hub. If the upload eventually shows valid there, rerun the script (it uploads fresh).
- **200 MB cap.** It applies to the package and to the source archive (see the submission reference). The build is far below it today; check before adding assets.

The default reviewer build environment is documented in the source submission reference. `store/pkg/README-amo-src.md` ships inside the source archive with our exact steps (Node 22, `npm ci`, `node scripts/build.mjs`), which keeps the reviewer's build reproducible.

## Automating the dev hub (verified 2026-10-14)

Two facts make the AMO dev hub scriptable, and both were learned the hard way:

1. addons.mozilla.org runs in a Firefox privileged content process, so
   marionette and WebDriver refuse content operations there ("browsing
   contexts in privileged scope"). Launch the automation browser with
   `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (flatpak: `flatpak run
   --env=MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 ...`) and the refusal disappears.
2. The image uploader ignores file selections set through WebDriver
   (`input.files` assignment and send_keys both save nothing). Post the
   media form directly from the page instead: read the CSRF token and
   formset fields from the live form (`edit_media/edit`), build a FormData
   with real `File` objects, and `fetch` it same-origin. Watch two traps:
   the description/name/release-notes fields are editor pairs where the
   submitted field is the `_0` mirror, and geckodriver execute scripts
   with top-level `await` fail with a bare "javascript error" unless the
   body is wrapped in a returned async IIFE.
