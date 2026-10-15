// SPDX-License-Identifier: MPL-2.0
// Autonomous Chrome Web Store publish: refresh-token exchange, PUT the zip to
// the update endpoint, POST publish with the API's default (public) target.
// Credentials live only in env vars and are never printed; --dry-run needs
// none of them. Re-running with an already-published version is rejected at
// the upload step with the store's own message, before anything publishes;
// uploading over a pending draft replaces that draft (the API's update
// semantics) and republishes, so a failed publish is always safe to rerun.
//
// API reference, fetched 2026-10-14:
//   https://developer.chrome.com/docs/webstore/using-api
//   https://developer.chrome.com/docs/webstore/api
//
//   CWS_EXTENSION_ID=... CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... \
//   CWS_REFRESH_TOKEN=... node scripts/publish-chrome.mjs \
//     --zip store/pkg/leia-chrome-<version>.zip [--dry-run]

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const TOKEN_URL = "https://accounts.google.com/o/oauth2/token";
const uploadUrl = (itemId) =>
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${itemId}`;
const publishUrl = (itemId) =>
  `https://www.googleapis.com/chromewebstore/v1.1/items/${itemId}/publish`;
const REQUIRED_ENV = [
  "CWS_EXTENSION_ID",
  "CWS_CLIENT_ID",
  "CWS_CLIENT_SECRET",
  "CWS_REFRESH_TOKEN",
];

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

// Google reports failures in three shapes: the token endpoint answers
// {error, error_description}, standard APIs answer {error: {message}}, and
// the store's items resource carries {uploadState, itemError[]}. Raw text is
// the last resort (proxy/HTML error pages); it is truncated and carries no
// credentials because none of these responses echo request secrets.
function describeFailure(httpStatus, text) {
  const body = jsonOrNull(text);
  if (typeof body?.error === "string") {
    return body.error_description
      ? `${body.error}: ${body.error_description}`
      : body.error;
  }
  if (typeof body?.error?.message === "string") return body.error.message;
  if (Array.isArray(body?.itemError) && body.itemError.length > 0)
    return body.itemError.join("; ");
  return text
    ? `HTTP ${httpStatus}: ${text.slice(0, 200)}`
    : `HTTP ${httpStatus}`;
}

function validateZip(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) fail(`--zip ${path} is not a file`);
  if (st.size === 0) fail(`--zip ${path} is empty`);
  const fd = openSync(path, "r");
  const magic = Buffer.alloc(4);
  readSync(fd, magic, 0, 4, 0);
  closeSync(fd);
  if (!magic.equals(Buffer.from("PK\x03\x04"))) {
    fail(
      `--zip ${path} has no zip signature; package per store/copy/chrome.md (manifest at the zip root)`,
    );
  }
  return st.size;
}

function printPlan(zipPath, size) {
  console.log(
    "dry run: no requests will be made, no credentials are read; secret values would print only as ***",
  );
  console.log(`step 1/3 POST ${TOKEN_URL}`);
  console.log(
    "  body: grant_type=refresh_token, client_id=$CWS_CLIENT_ID ***, client_secret=$CWS_CLIENT_SECRET ***, refresh_token=$CWS_REFRESH_TOKEN ***",
  );
  console.log(`step 2/3 PUT ${uploadUrl("$CWS_EXTENSION_ID")}`);
  console.log(
    "  headers: Authorization: Bearer ***, x-goog-api-version: 2, Content-Type: application/zip",
  );
  console.log(`  file: ${zipPath} (${kb(size)})`);
  console.log(
    "  success: uploadState SUCCESS; an already-published version is rejected here with the store's own message and nothing is published",
  );
  console.log(`step 3/3 POST ${publishUrl("$CWS_EXTENSION_ID")}`);
  console.log("  headers: Authorization: Bearer ***, x-goog-api-version: 2");
  console.log(
    "  target: public (no publishTarget query param, the API default)",
  );
  console.log(
    "  success: status contains OK; ITEM_PENDING_REVIEW or any other status exits 1",
  );
}

async function main() {
  let zipPath;
  let dryRun = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--dry-run") dryRun = true;
    else if (process.argv[i] === "--zip") zipPath = process.argv[++i];
    else
      fail(
        `unknown argument ${process.argv[i]} (usage: node scripts/publish-chrome.mjs --zip <path> [--dry-run])`,
      );
  }
  if (!zipPath)
    fail(
      "missing --zip <path> (usage: node scripts/publish-chrome.mjs --zip <path> [--dry-run])",
    );
  const size = validateZip(zipPath);

  if (dryRun) {
    printPlan(zipPath, size);
    return;
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(
      `missing env ${missing.join(", ")} (all of ${REQUIRED_ENV.join(", ")} are required; values are read from the environment only and never printed)`,
    );
  }
  const itemId = process.env.CWS_EXTENSION_ID;

  console.log(`step 1/3 exchanging the refresh token at ${TOKEN_URL}`);
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.CWS_CLIENT_ID,
      client_secret: process.env.CWS_CLIENT_SECRET,
      refresh_token: process.env.CWS_REFRESH_TOKEN,
    }),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok)
    fail(
      `token exchange failed (HTTP ${tokenRes.status}): ${describeFailure(tokenRes.status, tokenText)}`,
    );
  const accessToken = jsonOrNull(tokenText)?.access_token;
  if (!accessToken)
    fail(`token exchange returned no access_token (HTTP ${tokenRes.status})`);

  const zip = readFileSync(zipPath);
  console.log(
    `step 2/3 uploading ${zipPath} (${kb(size)}) to ${uploadUrl(itemId)}`,
  );
  const upRes = await fetch(uploadUrl(itemId), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-goog-api-version": "2",
      "content-type": "application/zip",
    },
    body: zip,
  });
  const upText = await upRes.text();
  if (!upRes.ok)
    fail(
      `upload rejected (HTTP ${upRes.status}): ${describeFailure(upRes.status, upText)}`,
    );
  const item = jsonOrNull(upText);
  if (item?.uploadState !== "SUCCESS") {
    const detail =
      Array.isArray(item?.itemError) && item.itemError.length > 0
        ? item.itemError.join("; ")
        : describeFailure(upRes.status, upText);
    fail(
      `upload failed (uploadState ${item?.uploadState ?? "unknown"}): ${detail}`,
    );
  }
  console.log("upload accepted (uploadState SUCCESS)");

  console.log(
    `step 3/3 publishing to the public channel at ${publishUrl(itemId)}`,
  );
  const pubRes = await fetch(publishUrl(itemId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-goog-api-version": "2",
    },
  });
  const pubText = await pubRes.text();
  if (!pubRes.ok)
    fail(
      `publish failed (HTTP ${pubRes.status}): ${describeFailure(pubRes.status, pubText)}`,
    );
  const pub = jsonOrNull(pubText);
  const status = Array.isArray(pub?.status) ? pub.status : [];
  const detail =
    Array.isArray(pub?.statusDetail) && pub.statusDetail.length > 0
      ? ` (${pub.statusDetail.join("; ")})`
      : "";
  if (!status.includes("OK")) {
    fail(
      `publish did not succeed (status ${status.join(", ") || "missing"})${detail}; the uploaded draft is kept, fix the cause and rerun`,
    );
  }
  console.log(
    `published ${itemId} to the public channel (status ${status.join(", ")})${detail}`,
  );
}

main().catch((e) => fail(`request failed: ${e.cause?.message ?? e.message}`));
