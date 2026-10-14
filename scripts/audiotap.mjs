#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * audiotap — record a PipeWire sink-input and report speech vs silence.
 *
 * The fish.audio debugging instrument: per-second RMS bars plus the silent
 * runs between speech windows, so sentence gaps are a readout instead of an
 * investigation. Requires pactl + pw-record on PATH.
 *
 * Usage:
 *   node scripts/audiotap.mjs [--target <sink-input-id>] [--app <name>] [--seconds 15]
 *   --target  sink-input id (as `pactl list sink-inputs` reports)
 *   --app     substring of the application name to auto-detect (default "Chromium")
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const app = flag("app", "Chromium");
const seconds = Number(flag("seconds", "15"));
const wav = join(tmpdir(), `audiotap-${Date.now()}.wav`);

const findTarget = (list, needle) => {
  const blocks = list.split(/\n(?=Sink Input #)/);
  for (const b of blocks) {
    const name = (b.match(/application\.name = (.*)/) || [])[1] || "";
    if (name.includes(needle)) return b.match(/Sink Input #(\d+)/)[1];
  }
  return null;
};

const list = spawnSync("pactl", ["list", "sink-inputs"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
let target = flag("target") ?? findTarget(list.stdout ?? "", app);
if (!target) {
  console.error(`no sink-input matching app "${app}" — is it playing?`);
  process.exit(1);
}
console.error(`tapping sink-input #${target} for ${seconds}s...`);

spawnSync("pw-record", ["--target", target, wav], { timeout: (seconds + 5) * 1000 });
const buf = readFileSync(wav);
unlinkSync(wav);

let off = 12;
let fmt = null;
let data = null;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "fmt ") {
    fmt = { ch: buf.readUInt16LE(off + 10), bits: buf.readUInt16LE(off + 22), rate: buf.readUInt32LE(off + 12) };
  }
  if (id === "data") {
    data = buf.subarray(off + 8, off + 8 + size);
    break;
  }
  off += 8 + size + (size % 2);
}
if (!data || !fmt) {
  console.error("no PCM data recorded");
  process.exit(1);
}
const bytesPer = (fmt.bits / 8) * fmt.ch;
const win = fmt.rate * bytesPer;
const step = fmt.bits / 8;

let silentRun = 0;
const gaps = [];
let speechWindows = 0;
process.stdout.write("per-second RMS:\n");
for (let o = 0; o + win <= data.length; o += win) {
  let sumSq = 0;
  const n = win / step;
  for (let i = 0; i < win; i += step) {
    const v = fmt.bits === 16 ? data.readInt16LE(o + i) / 32768 : data.readFloatLE(o + i);
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  const active = rms > 0.005;
  const t = (o / bytesPer / fmt.rate).toFixed(0);
  console.log(
    `t=${t}s  ${"#".repeat(Math.min(40, Math.round(rms * 50)))} rms=${rms.toFixed(3)}${active ? "" : "  <-- silent"}`,
  );
  if (active) {
    if (silentRun > 0) gaps.push(silentRun);
    silentRun = 0;
    speechWindows += 1;
  } else {
    silentRun += 1;
  }
}
if (silentRun > 0) gaps.push(silentRun);
console.log(`\nspeech windows: ${speechWindows} | silent runs between speech (s): ${gaps.join(", ") || "(none)"}`);
