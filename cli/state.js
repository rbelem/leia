// SPDX-License-Identifier: MPL-2.0
/**
 * Adapter state persistence across separate CLI invocations.
 *
 * Because each `leia <cmd>` is its own process, `up` must leave state that a
 * later `status` / `events` / `down` can read to know which browser is running
 * and where. Stored as JSON under the OS temp dir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STATE_DIR = join(tmpdir(), "opencode", "leia-ctl");
const STATE_FILE = join(STATE_DIR, "state.json");

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveState(s) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

export function clearState() {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {}
}

export function stateError() {
  return "no running leia browser state found — run `leia up` first";
}
