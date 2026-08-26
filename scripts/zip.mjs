#!/usr/bin/env node
/**
 * T18: store-ready zips. Run after `npm run build`:
 *   node scripts/zip.mjs
 * Produces dist/chrome.zip and dist/firefox.zip with manifest.json at the
 * archive ROOT (Chrome Web Store / Firefox AMO payload shape).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function zipDir(dir, out) {
  const entries = readdirSync(dir);
  try {
    execFileSync("zip", ["-q", "-r", "-X", out, ...entries], { cwd: dir });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    // No `zip` binary — python's zipfile module ships almost everywhere.
    // Individual entries (not ".") so paths have no ./ prefix.
    execFileSync("python3", ["-m", "zipfile", "-c", out, ...entries], { cwd: dir });
  }
}

for (const target of ["chrome", "firefox"]) {
  const dir = join(root, "dist", target);
  if (!existsSync(join(dir, "manifest.json"))) {
    console.error(`dist/${target}/manifest.json missing — run \`npm run build\` first`);
    process.exit(1);
  }
  const out = join(root, "dist", `${target}.zip`);
  rmSync(out, { force: true });
  zipDir(dir, out); // archive root = extension payload itself
  console.log(`✓ dist/${target}.zip`);
}
