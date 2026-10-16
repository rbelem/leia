// SPDX-License-Identifier: MPL-2.0
// Gate for store submission material: char limits from cited sources,
// manifest/copy consistency, and asset dimensions (delegates to
// render-store-art.mjs --check). Run before every submission.
//
//   node scripts/store-check.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

const copy = JSON.parse(readFileSync(join(ROOT, "store/copy/copy.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, "src/manifest.json"), "utf8"));
const longText = readFileSync(join(ROOT, copy.long_description_file), "utf8");

// 1. Char limits (sources cited inline in copy.json).
for (const field of ["name", "short_description", "amo_summary"]) {
  const { value, max } = copy[field];
  const n = [...value].length;
  if (n > max) fail(`${field} is ${n} chars, limit ${max}`);
  else pass(`${field} ${n}/${max} chars`);
}

// 2. Long description soft cap.
const longN = [...longText].length;
if (longN > copy.long_description_soft_max) {
  fail(`${copy.long_description_file} is ${longN} chars, soft limit ${copy.long_description_soft_max}`);
} else {
  pass(`long description ${longN}/${copy.long_description_soft_max} chars`);
}

// 3. Manifest and copy.json must agree. The manifest fields are what all
// three stores display; a drift here is how stale listings happen.
if (manifest.name !== copy.name.value) {
  fail(`manifest name ${JSON.stringify(manifest.name)} != copy.json ${JSON.stringify(copy.name.value)}`);
} else {
  pass("manifest name matches copy.json");
}
if (manifest.description !== copy.short_description.value) {
  fail(`manifest description != copy.json short_description`);
} else {
  pass("manifest description matches copy.json short_description");
}

// 4. Keyword-spam guard (Yellow Argon strike, 2026-10-16): the listing must
// not name third-party voice/AI brands or carry SEO superlatives. Covers
// every file under store/copy — the detailed description is pasted verbatim
// into CWS and review notes/captions travel with it, so a brand re-entering
// anywhere in this directory is a resubmission risk.
import { readdirSync } from "node:fs";
const SPAM_PATTERNS = [
  /elevenlabs/i, /azure/i, /openai/i, /\bchatgpt\b/i, /mistral/i,
  /\bx\.?\s?ai\b/i, /gemini/i, /minimax/i, /\bqwen\b/i, /fish[.\s-]?audio/i,
  /\bbest\b/i, /#1\b/, /number\s*1/i, /free\s+unlimited/i, /top[-\s]?rated/i,
];
for (const file of readdirSync(join(ROOT, "store/copy"))) {
  if (!/\.(md|json)$/.test(file)) continue;
  const text = readFileSync(join(ROOT, "store/copy", file), "utf8");
  const hit = SPAM_PATTERNS.find((re) => re.test(text));
  if (hit) fail(`store/copy/${file} matches spam-guard ${hit} (see Yellow Argon 2026-10-16)`);
  else pass(`store/copy/${file} spam-guard clean`);
}

// 5. Every listing image exists at its exact store-specified dimensions.
try {
  execFileSync(process.execPath, [join(ROOT, "scripts/render-store-art.mjs"), "--check"], { stdio: "inherit" });
} catch {
  fail("asset dimension check failed (see output above)");
}

process.exit(failed > 0 ? 1 : 0);
