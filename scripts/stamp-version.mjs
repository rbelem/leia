// SPDX-License-Identifier: MPL-2.0
// Stamps the release version into src/manifest.json and package.json from a
// git tag (vX.Y.Z). Idempotent: re-running with the same tag is a no-op, so a
// retried release job converges to the same state.
//
//   node scripts/stamp-version.mjs --tag v0.1.2     explicit tag
//   node scripts/stamp-version.mjs                  read GITHUB_REF_NAME / GITHUB_REF
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function readTag() {
  const argIndex = process.argv.indexOf("--tag");
  if (argIndex !== -1) return process.argv[argIndex + 1];
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_REF) return process.env.GITHUB_REF.replace("refs/tags/", "");
  throw new Error("no tag given: pass --tag vX.Y.Z or set GITHUB_REF_NAME");
}

const tag = readTag();
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  console.error(`error: tag ${JSON.stringify(tag)} is not vX.Y.Z`);
  process.exit(1);
}
const version = tag.slice(1);

const files = [
  { path: "src/manifest.json", pick: (o) => o.version, put: (o, v) => (o.version = v) },
  { path: "package.json", pick: (o) => o.version, put: (o, v) => (o.version = v) },
];

for (const file of files) {
  const full = resolve(ROOT, file.path);
  const json = JSON.parse(readFileSync(full, "utf8"));
  const before = file.pick(json);
  if (before === version) {
    console.log(`${file.path}: already ${version}`);
    continue;
  }
  file.put(json, version);
  writeFileSync(full, JSON.stringify(json, null, 2) + "\n");
  console.log(`${file.path}: ${before} -> ${version}`);
}
console.log(`stamped ${version}`);
