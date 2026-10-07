// SPDX-License-Identifier: MPL-2.0
/**
 * Adapter state persistence across separate CLI invocations.
 *
 * Because each `leia <cmd>` is its own process, `up` must leave state that a
 * later `status` / `events` / `down` can read to know which browser is running
 * and where. Stored as JSON under the OS temp dir. LEIA_STATE_DIR overrides
 * the directory — parallel sessions (lanes/e2e) set it to isolate their
 * state from other leia instances on the same machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_STATE_DIR = join(tmpdir(), "opencode", "leia-ctl");

function stateFile() {
  return join(process.env.LEIA_STATE_DIR || DEFAULT_STATE_DIR, "state.json");
}

export function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

export function saveState(s) {
  try {
    mkdirSync(process.env.LEIA_STATE_DIR || DEFAULT_STATE_DIR, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  } catch {}
}

export function clearState() {
  try {
    rmSync(stateFile(), { force: true });
  } catch {}
}

export function stateError() {
  return "no running leia browser state found — run `leia up` first";
}
