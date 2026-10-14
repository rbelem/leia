#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * leia-restore — one command back to a reading session after a browser restart.
 *
 * Per-session profiles wipe provider keys by design, so every restart repeated
 * the same dance: pull the fish.audio key from Bitwarden Secrets Manager, save
 * it, pin a voice (the voice id re-pins the engine family), open the fixture
 * and start. This script is that dance, verified live on both browsers.
 *
 * Usage:
 *   node scripts/leia-restore.mjs [--browser chrome|firefox] [--voice <id>] [--seconds-wait 6]
 * For firefox, run inside `devbox shell` (geckodriver + firefox come from devbox.json).
 * Requires: `bws` authenticated for FISH_API_KEY, and the dev build (npm run build -- --dev).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const browser = flag("browser", "chrome");
const waitSeconds = Number(flag("seconds-wait", "6"));
const repo = new URL("..", import.meta.url).pathname;
const browserArgs = browser === "firefox" ? ["-b", "firefox"] : [];

const leia = (cmdArgs, opts = {}) => {
  try {
    return execFileSync("node", ["cli/index.js", ...browserArgs, ...cmdArgs], {
      cwd: repo,
      encoding: "utf8",
      timeout: 90_000,
      ...opts,
    });
  } catch (err) {
    // Never echo the key back through a failed-command message.
    if (err.message) err.message = err.message.replaceAll(keyValue, "«redacted»");
    throw err;
  }
};

const keyFile = join(tmpdir(), `leia-fish-key-${Date.now()}`);
const secretId = JSON.parse(execFileSync("bws", ["secret", "list"], { encoding: "utf8" })).find(
  (s) => s.key === "FISH_API_KEY",
)?.id;
if (!secretId) throw new Error("FISH_API_KEY not found in Bitwarden Secrets Manager");
const secret = JSON.parse(execFileSync("bws", ["secret", "get", secretId], { encoding: "utf8" }));
const keyValue = secret.value;
writeFileSync(keyFile, keyValue);
chmodSync(keyFile, 0o600);

// A fresh checkout or post-restart shell has no browser attached — bring one up.
let connected = true;
try {
  leia(["ping"]);
} catch {
  connected = false;
}
if (!connected) {
  console.error("[restore] harness down — running up first...");
  leia(["up"]);
}

const parsed = (out) => {
  const start = (out || "").indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(out.slice(start));
  } catch {
    return null;
  }
};

const saved = parsed(leia(["options:set-key", "fishaudio", keyValue]));
rmSync(keyFile);
if (!saved?.ok) throw new Error("key save failed");

const voices = JSON.parse(leia(["voices", "--json"]) ?? "{}").data;
let voiceId = flag("voice");
if (!voiceId && Array.isArray(voices)) {
  voiceId = voices.find((v) => v.family === "fishaudio" && v.lang === "en-US")?.name;
}
if (!voiceId) {
  // Chrome's voices shim can answer null — ask the runtime directly (chrome adapter only).
  const probe = await import(join(repo, "cli/adapter.js")).then((m) => m.createAdapter(browser, {}));
  try {
    const res = await probe.eval(`(async () => {
      const r = await browser.runtime.sendMessage({ type: "leia:reader:voices" });
      const v = (r.data || []).find((x) => x.family === "fishaudio" && x.lang === "en-US");
      return v ? v.name : "";
    })()`);
    voiceId = String(res).replace(/^"|"$/g, "");
  } finally {
    await probe.close?.();
  }
}
if (!voiceId) throw new Error("no fishaudio voice available — check the key");

leia(["voice", voiceId]);
leia(["open-fixture"]);
leia(["start"]);
await new Promise((r) => setTimeout(r, waitSeconds * 1000));
const status = JSON.parse(leia(["status", "--json"])).data;
console.log(
  `restored: ${status.state} ${status.tokenPos}/${status.tokenCount} engine=${status.settings.engine} voice=${status.settings.voiceName.slice(0, 8)} err=${status.lastError}`,
);
