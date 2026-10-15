// SPDX-License-Identifier: MPL-2.0
// Autonomous Firefox Add-ons (AMO) publish, source archive included. Three
// requests: multipart POST of the zip to the upload endpoint, poll the upload
// until AMO's validator finishes, multipart POST to the version endpoint with
// the source archive attached. The raw v5 API is used instead of sign-addon
// because sign-addon has no step that attaches a source archive, and AMO
// requires sources for esbuild-minified bundles (see store/copy/firefox.md).
//
// Credentials live only in env vars and are never printed; --dry-run needs
// none of them. Every run creates a fresh upload, so a failed version create
// leaves nothing behind and the run is safe to repeat; a version AMO already
// has is rejected and the script says to bump it.
//
// API reference, fetched 2026-10-14:
//   https://addons-server.readthedocs.io/en/latest/topics/api/addons.html
//     (upload create/detail, version create: multipart source + upload uuid)
//   https://addons-server.readthedocs.io/en/latest/topics/api/auth.html
//     (JWT: HS256, iss = API key, exp at most 5 min past iat, "JWT " prefix)
//   https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
//   https://extensionworkshop.com/documentation/publish/source-code-submission/
//
//   AMO_API_KEY=... AMO_API_SECRET=... node scripts/publish-firefox.mjs \
//     --zip store/pkg/leia-firefox-<version>.zip \
//     --src-zip store/pkg/leia-<version>-sources.zip \
//     [--channel listed|unlisted] [--dry-run]

import { createHmac, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const ORIGIN = "https://addons.mozilla.org";
const API = `${ORIGIN}/api/v5`;
const DEFAULT_ADDON_ID = "leia@rclb.dev";
const CHANNELS = new Set(["listed", "unlisted"]);
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 10;

const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const jsonOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const kb = (n) =>
  n >= 1024 * 1024
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AMO answers with DRF error bodies: {"detail": "..."} for auth and plain
// rejections, {"field": ["msg", ...]} for validation, raw HTML/text through
// proxies. None of these echo the Authorization header, so truncating them
// into one line leaks no credentials.
function describeAmoError(httpStatus, text) {
  const body = jsonOrNull(text);
  if (typeof body?.detail === "string") return body.detail;
  if (body && typeof body === "object") {
    const parts = Object.entries(body).map(([field, value]) => {
      const msg = Array.isArray(value)
        ? value.join("; ")
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
      return `${field}: ${msg}`;
    });
    if (parts.length > 0) return parts.join("; ").slice(0, 300);
  }
  return text
    ? `HTTP ${httpStatus}: ${text.slice(0, 200)}`
    : `HTTP ${httpStatus}`;
}

// The upload detail's `validation` field is the addons-linter results blob.
// Live shape (verified against upload b34d49b4, 2026-10-14): integer counts
// under errors/warnings/notices plus a `messages` array whose items carry
// `type` ("error"|"warning"|"notice") and `message`. Older AMO responses
// listed the messages directly under the kind keys, sometimes wrapped one
// level deep in `validation` — all three stay supported.
function validationLists(blob) {
  const top = blob && typeof blob === "object" ? blob : null;
  const v =
    top &&
    !Array.isArray(top.messages) &&
    top.validation &&
    typeof top.validation === "object"
      ? top.validation
      : top;
  const messages = Array.isArray(v?.messages) ? v.messages : [];
  const singular = { errors: "error", warnings: "warning", notices: "notice" };
  const fromMessages = (kind) =>
    messages
      .filter((m) =>
        m && typeof m === "object" ? m.type === singular[kind] : false,
      )
      .map((m) =>
        typeof m.message === "string"
          ? m.message
          : JSON.stringify(m.message ?? m),
      )
      .filter(Boolean);
  const pick = (kind) => {
    const direct = v?.[kind];
    if (Array.isArray(direct))
      return direct
        .map((m) =>
          typeof m === "string" ? m : (m?.message ?? JSON.stringify(m)),
        )
        .filter(Boolean);
    return fromMessages(kind);
  };
  return {
    errors: pick("errors"),
    warnings: pick("warnings"),
    notices: pick("notices"),
  };
}

// mintJwt is HS256 per the auth reference: iss = API key, exp within 5 min of
// iat (60s here), jti a nonce. Signed with node:crypto, no dependencies.
function mintJwt(key, secret) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ iss: key, jti: randomBytes(16).toString("hex"), iat, exp: iat + 60 })}`;
  const sig = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${sig}`;
}

function validateZipFile(path, flag) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) fail(`--${flag} ${path} is not a file`);
  if (st.size === 0) fail(`--${flag} ${path} is empty`);
  const fd = openSync(path, "r");
  const magic = Buffer.alloc(4);
  readSync(fd, magic, 0, 4, 0);
  closeSync(fd);
  if (!magic.equals(Buffer.from("PK\x03\x04"))) {
    fail(
      `--${flag} ${path} has no zip signature (zip per store/copy/firefox.md: the package has manifest.json at the root, sources via git archive --format=zip)`,
    );
  }
  return st.size;
}

// The runbook is the one source of truth for reviewer notes; the fenced block
// under "Review notes to paste" becomes the version's approval_notes. Best
// effort: notes missing must not block a release.
function loadApprovalNotes() {
  try {
    const runbook = readFileSync(
      resolve(import.meta.dirname, "../store/copy/firefox.md"),
      "utf8",
    );
    const m = runbook.match(
      /## Review notes to paste[\s\S]*?```\n([\s\S]*?)\n```/,
    );
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { channel: "listed", dryRun: false };
  const usage =
    "usage: node scripts/publish-firefox.mjs --zip <path> --src-zip <path> [--channel listed|unlisted] [--dry-run]";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--channel") {
      const value = argv[++i];
      if (!value || !CHANNELS.has(value))
        fail(
          `--channel needs listed or unlisted (got ${value ?? "nothing"}); ${usage}`,
        );
      args.channel = value;
    } else if (arg === "--zip") args.zipPath = argv[++i];
    else if (arg === "--src-zip") args.srcPath = argv[++i];
    else fail(`unknown argument ${arg}; ${usage}`);
  }
  if (!args.zipPath || !args.srcPath)
    fail(`missing --zip <path> --src-zip <path>; ${usage}`);
  return args;
}

function printPlan(args, zipSize, srcSize, approvalNotes) {
  const addonId = process.env.AMO_ADDON_ID || DEFAULT_ADDON_ID;
  const has = (name) =>
    process.env[name] ? "set (value never printed)" : "not set";
  console.log(
    "dry run: no requests will be made, no credentials are read; secret values would print only as ***",
  );
  console.log(
    `addon: ${addonId} (env AMO_ADDON_ID or the default), channel: ${args.channel}`,
  );
  console.log(
    `secrets: AMO_API_KEY ${has("AMO_API_KEY")}, AMO_API_SECRET ${has("AMO_API_SECRET")}`,
  );
  console.log(`step 1/3 POST ${API}/addons/upload/`);
  console.log(
    "  headers: Authorization: JWT <redacted>, Content-Type: multipart/form-data (set by fetch)",
  );
  console.log(
    `  multipart: upload=${args.zipPath} (${kb(zipSize)}), channel=${args.channel}`,
  );
  console.log(
    "  success: 201 with the upload object (uuid, url); validation runs server side",
  );
  console.log(
    `step 2/3 GET the upload url from step 1 (${API}/addons/upload/<uuid>/) every ${POLL_INTERVAL_MS / 1000}s until processed, at most ${POLL_TIMEOUT_MS / 60000}min`,
  );
  console.log(
    "  success: processed=true and valid=true; valid=false fails the run with the linter errors; warnings are printed and do not block",
  );
  console.log(`step 3/3 POST ${API}/addons/addon/${addonId}/versions/`);
  console.log(
    "  headers: Authorization: JWT <redacted>, Content-Type: multipart/form-data (set by fetch)",
  );
  console.log(
    `  multipart: upload=<uuid from step 1>, source=${args.srcPath} (${kb(srcSize)}; the source attachment AMO requires for this minified bundle)`,
  );
  console.log(
    approvalNotes
      ? `  multipart: approval_notes=${approvalNotes.length} chars from store/copy/firefox.md "Review notes to paste"`
      : '  multipart: approval_notes skipped (no fenced block under "Review notes to paste" in store/copy/firefox.md)',
  );
  console.log(
    "  success: 201 version object; a version number AMO already has is rejected here and the script says to bump it",
  );
  console.log(
    "after: exit 0; signing and, for first listed versions, human source review stay async on AMO's side",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zipSize = validateZipFile(args.zipPath, "zip");
  const srcSize = validateZipFile(args.srcPath, "src-zip");
  const approvalNotes = loadApprovalNotes();

  if (args.dryRun) {
    printPlan(args, zipSize, srcSize, approvalNotes);
    return;
  }

  const missing = ["AMO_API_KEY", "AMO_API_SECRET"].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    fail(
      `missing env ${missing.join(", ")} (both are required for a live run, from https://addons.mozilla.org/developers/addon/api/key/; values are read from the environment only and never printed)`,
    );
  }
  const addonId = process.env.AMO_ADDON_ID || DEFAULT_ADDON_ID;
  const jwt = mintJwt(process.env.AMO_API_KEY, process.env.AMO_API_SECRET);
  const amo = async (pathOrUrl, options = {}) => {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    const { timeoutMs, ...rest } = options;
    return fetch(url, {
      ...rest,
      headers: { ...rest.headers, authorization: `JWT ${jwt}` },
      signal: AbortSignal.timeout(timeoutMs ?? 60_000),
    });
  };

  console.log(
    `step 1/3 uploading ${args.zipPath} (${kb(zipSize)}) to ${API}/addons/upload/ (channel ${args.channel})`,
  );
  const zipForm = new FormData();
  zipForm.append(
    "upload",
    new Blob([readFileSync(args.zipPath)], { type: "application/zip" }),
    basename(args.zipPath),
  );
  zipForm.append("channel", args.channel);
  const upRes = await amo("/addons/upload/", {
    method: "POST",
    body: zipForm,
    timeoutMs: 600_000,
  });
  const upText = await upRes.text();
  if (!upRes.ok)
    fail(
      `upload rejected (HTTP ${upRes.status}): ${describeAmoError(upRes.status, upText)}`,
    );
  const upload = jsonOrNull(upText);
  if (!upload?.uuid || !upload?.url)
    fail(
      `upload response has no uuid/url (HTTP ${upRes.status}): ${upText.slice(0, 200)}`,
    );
  const pollUrl = upload.url.startsWith("http")
    ? upload.url
    : `${ORIGIN}${upload.url}`;
  console.log(
    `upload accepted, uuid ${upload.uuid}; polling ${pollUrl} every ${POLL_INTERVAL_MS / 1000}s`,
  );

  console.log("step 2/3 waiting for AMO's validator on the upload");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  let validated;
  while (true) {
    if (Date.now() >= deadline) {
      fail(
        `AMO validation did not finish within ${POLL_TIMEOUT_MS / 60000}min; check ${pollUrl} in the dev hub, then rerun`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
    let res;
    let text;
    try {
      res = await amo(pollUrl, { timeoutMs: 60_000 });
      text = await res.text();
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        fail(
          `upload status poll failed ${consecutiveFailures} times in a row: ${e.cause?.message ?? e.message}`,
        );
      }
      continue;
    }
    if (!res.ok) {
      if (res.status >= 500) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          fail(
            `upload status poll kept failing (HTTP ${res.status}): ${describeAmoError(res.status, text)}`,
          );
        }
        continue;
      }
      fail(
        `upload status poll failed (HTTP ${res.status}): ${describeAmoError(res.status, text)}`,
      );
    }
    consecutiveFailures = 0;
    const detail = jsonOrNull(text);
    if (!detail)
      fail(
        `upload status response is not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    if (detail.submitted)
      fail(
        `upload ${detail.uuid} was already submitted as a version; rerun the script so it uploads a fresh copy`,
      );
    if (!detail.processed) continue;
    validated = detail;
    break;
  }

  const lists = validationLists(validated.validation);
  if (!validated.valid) {
    const msgs =
      lists.errors.length > 0
        ? lists.errors.slice(0, 3).join(" | ")
        : "no error detail returned";
    if (/duplicate/i.test(lists.errors.join(" "))) {
      fail(
        `version ${validated.version ?? "?"} already exists on AMO for ${addonId}; bump the version (tag vX.Y.Z) and rerun (${msgs})`,
      );
    }
    fail(`AMO validation failed: ${msgs}`);
  }
  const warn =
    lists.warnings.length > 0
      ? `; ${lists.warnings.length} warning(s): ${lists.warnings.slice(0, 3).join(" | ")}`
      : "";
  console.log(
    `validation passed (errors 0, warnings ${lists.warnings.length}, notices ${lists.notices.length})${warn}`,
  );
  if (lists.warnings.length > 0)
    console.log(
      "warnings do not block publishing but AMO reviewers cite the same lints; read them",
    );

  console.log(
    `step 3/3 creating version ${validated.version ?? "(from manifest)"} on ${addonId} with the source archive ${args.srcPath} (${kb(srcSize)}) attached`,
  );
  const versionForm = new FormData();
  versionForm.append("upload", validated.uuid);
  versionForm.append(
    "source",
    new Blob([readFileSync(args.srcPath)], { type: "application/zip" }),
    basename(args.srcPath),
  );
  if (approvalNotes) versionForm.append("approval_notes", approvalNotes);
  const vRes = await amo(
    `/addons/addon/${encodeURIComponent(addonId)}/versions/`,
    {
      method: "POST",
      body: versionForm,
      timeoutMs: 600_000,
    },
  );
  const vText = await vRes.text();
  if (!vRes.ok) {
    const detail = describeAmoError(vRes.status, vText);
    if (
      vRes.status === 409 ||
      /already (exists|submitted)|duplicate/i.test(detail)
    ) {
      fail(
        `version ${validated.version ?? "?"} already exists on AMO for ${addonId}; bump the version (tag vX.Y.Z) and rerun (${detail})`,
      );
    }
    fail(`version create failed (HTTP ${vRes.status}): ${detail}`);
  }
  const version = jsonOrNull(vText);
  console.log(
    `published version ${version?.version ?? validated.version} (${args.channel}) on ${addonId}; waited for: upload processed+valid, version created (HTTP 201). Still async on AMO's side: file signing and, for first listed versions, the human source review; watch the dev hub or the confirmation email`,
  );
}

main().catch((e) => fail(`request failed: ${e.cause?.message ?? e.message}`));
