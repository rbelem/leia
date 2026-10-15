// SPDX-License-Identifier: MPL-2.0
// Publishes a Leia zip as an update to the existing Microsoft Edge Add-ons
// product: replace the draft package, issue the publish (submit for
// certification) call, and poll both operations to a terminal state.
//
//   node scripts/publish-edge.mjs --zip store/pkg/leia-edge-<version>.zip [--note "..."] [--dry-run]
//
// Sources (fetched 2026-10-14):
//   https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
//   https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference
//   https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
//
// Auth is the v1.1 API-key scheme (Authorization: ApiKey <key> + X-ClientID).
// The docs retired the older v1 scheme (AAD client-credential token exchange)
// on Dec 31 2024, so there is no token endpoint here: EDGE_CLIENT_SECRET is
// accepted as a legacy alias for the API key and EDGE_TENANT_ID is accepted
// but unused. The API cannot create products or edit listing metadata, so the
// first submission stays manual (store/copy/edge.md runbook).
//
// Exit 0 means both operations reported Succeeded. For the publish operation
// the API's synchronous confirmation is "Successfully created submission with
// ID ...": the submission exists and certification has begun. Review outcome
// and store rollout stay asynchronous. Any failure prints exactly one line
// starting with "error: " on stderr and exits 1.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const API_BASE = "https://api.addons.microsoftedge.microsoft.com";
const REDACTED = "***redacted***";
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const POLL_UPLOAD = { everyMs: 3_000, timeoutMs: 5 * 60_000 };
const POLL_PUBLISH = { everyMs: 10_000, timeoutMs: 30 * 60_000 };
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
const DEFAULT_NOTE =
  "Automated package update submitted by scripts/publish-edge.mjs (Leia release pipeline).";

const pkgUrl = (pid) =>
  `${API_BASE}/v1/products/${pid}/submissions/draft/package`;
const uploadOpUrl = (pid, op) =>
  `${API_BASE}/v1/products/${pid}/submissions/draft/package/operations/${op}`;
const publishUrl = (pid) => `${API_BASE}/v1/products/${pid}/submissions`;
const publishOpUrl = (pid, op) =>
  `${API_BASE}/v1/products/${pid}/submissions/operations/${op}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 300);

function fail(msg) {
  console.error(`error: ${oneLine(msg)}`);
  process.exit(1);
}

function parseArgv(argv) {
  const out = { zip: null, note: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--zip") out.zip = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else
      fail(
        `unknown argument ${a}; usage: publish-edge.mjs --zip <path> [--note <text>] [--dry-run]`,
      );
  }
  if (out.zip === undefined || out.note === undefined)
    fail("--zip and --note each need a value");
  if (!out.dryRun && !out.zip)
    fail("--zip <path> is required without --dry-run");
  return out;
}

function parseEnv(env, live) {
  const keySource = env.EDGE_API_KEY
    ? "EDGE_API_KEY"
    : env.EDGE_CLIENT_SECRET
      ? "EDGE_CLIENT_SECRET (legacy alias)"
      : null;
  const v = {
    productId: env.EDGE_PRODUCT_ID ?? "",
    clientId: env.EDGE_CLIENT_ID ?? "",
    apiKey: env.EDGE_API_KEY ?? env.EDGE_CLIENT_SECRET ?? "",
    keySource,
    tenantSet: env.EDGE_TENANT_ID !== undefined,
  };
  if (live) {
    if (!v.productId)
      fail(
        "EDGE_PRODUCT_ID is not set (Partner Center, Extension overview page)",
      );
    if (!v.clientId)
      fail("EDGE_CLIENT_ID is not set (Partner Center, Publish API page)");
    if (!v.apiKey)
      fail(
        "EDGE_API_KEY is not set (Partner Center, Publish API page; EDGE_CLIENT_SECRET works as a legacy alias)",
      );
  }
  return v;
}

function readZip(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    fail(`--zip ${path} does not exist`);
  }
  if (!st.isFile()) fail(`--zip ${path} is not a regular file`);
  if (st.size === 0) fail(`--zip ${path} is empty`);
  const fd = openSync(path, "r");
  const head = Buffer.alloc(4);
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  if (!head.equals(Buffer.from("PK\x03\x04")))
    fail(`--zip ${path} is not a zip file (bad magic bytes)`);
  return { path, size: st.size };
}

async function failResponse(res, what) {
  const text = await res.text().catch(() => "");
  let detail = text.trim();
  try {
    const body = JSON.parse(text);
    detail =
      [body.errorCode, body.message].filter(Boolean).join(": ") || text.trim();
  } catch {
    // not JSON; the raw text (possibly an HTML error page) is the best detail
  }
  fail(`${what} failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
}

function operationQueryUrl(v, kind, location) {
  // The docs say the Location header carries the operation ID; accept an
  // absolute URL too in case the service starts returning one.
  if (/^https?:/i.test(location)) return location;
  return kind === "upload"
    ? uploadOpUrl(v.productId, location)
    : publishOpUrl(v.productId, location);
}

async function awaitOperation(v, kind, location) {
  const { everyMs, timeoutMs } = kind === "upload" ? POLL_UPLOAD : POLL_PUBLISH;
  const url = operationQueryUrl(v, kind, location);
  console.log(
    `${kind} operation ${location}: polling every ${everyMs / 1000}s, timeout ${timeoutMs / 1000}s`,
  );
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  while (true) {
    if (Date.now() > deadline) {
      fail(
        `${kind} operation ${location} is still InProgress after ${timeoutMs / 1000}s (not failed); re-check it with the curl in store/publishing/edge.md`,
      );
    }
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `ApiKey ${v.apiKey}`,
          "X-ClientID": v.clientId,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (++consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS)
          fail(
            `${kind} operation ${location}: ${consecutiveErrors} polls in a row returned HTTP ${res.status}`,
          );
        await sleep(everyMs);
        continue;
      }
    } catch (e) {
      if (++consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS)
        fail(
          `${kind} operation ${location}: ${consecutiveErrors} polls failed in a row (last: ${e.message})`,
        );
      await sleep(everyMs);
      continue;
    }
    consecutiveErrors = 0;
    if (res.status !== 200) await failResponse(res, `${kind} status check`);
    const body = await res.json().catch(() => null);
    if (body?.status === "InProgress") {
      await sleep(everyMs);
      continue;
    }
    if (body?.status === "Succeeded" || body?.status === "Failed") return body;
    fail(
      `${kind} operation ${location} returned an unknown status: ${JSON.stringify(body?.status ?? body)}`,
    );
  }
}

async function uploadPackage(v, zip) {
  const res = await fetch(pkgUrl(v.productId), {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${v.apiKey}`,
      "X-ClientID": v.clientId,
      "Content-Type": "application/zip",
    },
    body: readFileSync(zip.path),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (res.status !== 202) await failResponse(res, "package upload");
  const op = res.headers.get("location");
  if (!op)
    fail(
      "package upload returned 202 without a Location header (cannot poll its operation)",
    );
  return op;
}

async function postPublish(v, note) {
  const res = await fetch(publishUrl(v.productId), {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${v.apiKey}`,
      "X-ClientID": v.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ notes: note ?? DEFAULT_NOTE }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 202) await failResponse(res, "publish request");
  const op = res.headers.get("location");
  if (!op)
    fail(
      "publish request returned 202 without a Location header (cannot poll its operation)",
    );
  return op;
}

// The API reference documents these publish failure modes verbatim; each maps
// to one operator action instead of an if-chain at the call site.
const PUBLISH_FAILURE_HINTS = {
  CreateNotAllowed:
    "the product does not exist yet; do the first submission manually (store/copy/edge.md)",
  NoModulesUpdated:
    "the package has no changes against the live version; the draft was replaced but the live listing is unchanged, so bump the version in src/manifest.json, rebuild, re-zip, and rerun",
  InProgressSubmission:
    "a previous submission is still in review; wait for it to finish",
  UnpublishInProgress:
    "the product is being unpublished; retry after that finishes",
  ModuleStateUnPublishable:
    "the uploaded package has invalid modules; fix what Partner Center reports and rerun",
  SubmissionValidationError:
    "the submission failed validation; fix the listed errors and rerun",
};

function renderPlan(args, v, zip) {
  const pid = v.productId || "<EDGE_PRODUCT_ID>";
  const note = args.note ?? DEFAULT_NOTE;
  const lines = [
    "dry-run: no network calls were made; exit 0",
    `auth: no token endpoint (v1.1 API-key auth; every request carries Authorization + X-ClientID)`,
    `env: EDGE_PRODUCT_ID=${v.productId ? "set" : "<unset>"}, EDGE_CLIENT_ID=${v.clientId ? "set" : "<unset>"}, API key via ${v.keySource ?? "EDGE_API_KEY"}=${v.apiKey ? "set" : "<unset>"}, EDGE_TENANT_ID=${v.tenantSet ? "set but unused (v1.1 has no tenant)" : "<unset>"}`,
    `zip: ${zip ? `${zip.path}, ${zip.size} bytes, zip magic ok` : "<not provided; pass --zip <path> to validate it>"}`,
    `step 1  POST ${pkgUrl(pid)}`,
    `        Authorization: ApiKey ${REDACTED}`,
    `        X-ClientID: ${REDACTED} (from EDGE_CLIENT_ID)`,
    `        Content-Type: application/zip`,
    `        body: raw zip bytes${zip ? ` (${zip.size} bytes from ${zip.path})` : ""}; not multipart`,
    `step 2  GET ${uploadOpUrl(pid, "<operationID from the 202 Location header>")}`,
    `        poll every ${POLL_UPLOAD.everyMs / 1000}s until status Succeeded or Failed (timeout ${POLL_UPLOAD.timeoutMs / 1000}s, ${MAX_CONSECUTIVE_POLL_ERRORS} consecutive poll errors tolerated)`,
    `step 3  POST ${publishUrl(pid)}`,
    `        Authorization: ApiKey ${REDACTED}`,
    `        X-ClientID: ${REDACTED} (from EDGE_CLIENT_ID)`,
    `        Content-Type: application/json`,
    `        body: ${JSON.stringify({ notes: note })}`,
    `step 4  GET ${publishOpUrl(pid, "<operationID from the 202 Location header>")}`,
    `        poll every ${POLL_PUBLISH.everyMs / 1000}s until status Succeeded or Failed (timeout ${POLL_PUBLISH.timeoutMs / 1000}s)`,
    `step 5  exit 0 only if both operations report Succeeded: per the API reference that means "Successfully created submission with ID ..." (submission created, certification queued); review outcome and store rollout stay asynchronous`,
    `same-version path: upload Succeeds (draft replaced), then publish ends Failed with errorCode NoModulesUpdated; the script prints one error line and exits 1, and the live listing is unchanged`,
  ];
  console.log(lines.join("\n"));
}

const args = parseArgv(process.argv.slice(2));
const v = parseEnv(process.env, !args.dryRun);

if (args.dryRun) {
  const zip = args.zip ? readZip(args.zip) : null;
  renderPlan(args, v, zip);
  process.exit(0);
}

const zip = readZip(args.zip);
console.log(
  `[1/4] uploading ${zip.path} (${zip.size} bytes) as the draft package`,
);
const uploadLoc = await uploadPackage(v, zip);
const uploadBody = await awaitOperation(v, "upload", uploadLoc);
if (uploadBody.status === "Failed") {
  fail(
    `package upload failed: ${uploadBody.errorCode || "Failed"}: ${uploadBody.message ?? "no message from the API"}`,
  );
}
console.log(
  `[2/4] upload operation ${uploadBody.id}: Succeeded (${oneLine(uploadBody.message ?? "")})`,
);

console.log(
  "[3/4] issuing the publish call (submits the draft for certification)",
);
const publishLoc = await postPublish(v, args.note);
const publishBody = await awaitOperation(v, "publish", publishLoc);
if (publishBody.status === "Failed") {
  const code = publishBody.errorCode || "unknown";
  const hint =
    PUBLISH_FAILURE_HINTS[code] ??
    "see store/publishing/edge.md for the failure playbook";
  fail(
    `publish refused (${code}): ${publishBody.message ?? "no message from the API"}; ${hint}`,
  );
}
console.log(
  `[4/4] publish operation ${publishBody.id}: Succeeded (${oneLine(publishBody.message ?? "")})`,
);
console.log(
  "Synchronous confirmation ends here: the submission exists and certification has begun. The review outcome and store rollout are asynchronous and take days.",
);
