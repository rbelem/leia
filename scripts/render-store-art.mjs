// SPDX-License-Identifier: MPL-2.0
// Renders store/ art SVGs to exact-size PNGs via headless chromium, then
// asserts each PNG's pixel dimensions (and alpha channel) from its bytes.
// No image library: chromium is the renderer, the PNG IHDR is the check.
//
//   node scripts/render-store-art.mjs           render everything
//   node scripts/render-store-art.mjs --check   only verify existing PNGs
//   node scripts/render-store-art.mjs --install copy icon sizes onto
//                                               src/icons/icon*.png
//
// Chromium resolution order: $CHROMIUM, then the devbox profile binary.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEVBOX_CHROMIUM =
  "/home/rodrigo/.local/share/devbox/global/default/.devbox/nix/profile/default/bin/chromium";

function findChromium() {
  for (const candidate of [process.env.CHROMIUM, DEVBOX_CHROMIUM]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("render-store-art: no chromium found (set $CHROMIUM)");
}

// Every store PNG asset, in one table. art: source SVG. out: target PNG.
// Transparent canvases (icons) use transparent:true; promo art fills its frame.
const ASSETS = [
  // icons — one concept directory holds the promoted identity
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-16.png", size: [16, 16], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-32.png", size: [32, 32], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-48.png", size: [48, 48], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-96.png", size: [96, 96], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-128.png", size: [128, 128], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-256.png", size: [256, 256], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-300.png", size: [300, 300], transparent: true },
  { art: "store/icons/leia-icon.svg", out: "store/icons/leia-512.png", size: [512, 512], transparent: true },
  // chrome web store
  { art: "store/promo/cws-small-tile.svg", out: "store/promo/cws-small-tile-440x280.png", size: [440, 280] },
  { art: "store/promo/cws-marquee.svg", out: "store/promo/cws-marquee-1400x560.png", size: [1400, 560] },
  // edge add-ons (small tile + marquee share CWS dimensions)
  { art: "store/promo/cws-small-tile.svg", out: "store/promo/edge-small-tile-440x280.png", size: [440, 280] },
  { art: "store/promo/cws-marquee.svg", out: "store/promo/edge-large-tile-1400x560.png", size: [1400, 560] },
];

const ROOT = resolve(import.meta.dirname, "..");

// PNG IHDR: width at byte 16, height at 20 (big-endian), color type at 25.
function pngDimensions(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25], bytes: buf.length };
}

function renderOne(chromium, asset) {
  const svgPath = join(ROOT, asset.art);
  const outPath = join(ROOT, asset.out);
  const [w, h] = asset.size;
  const work = mkdtempSync(join(tmpdir(), "leia-art-"));
  const html = [
    `<!doctype html><html><head><style>`,
    `html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}`,
    `body{background:${asset.transparent ? "transparent" : "#fff"}}`,
    `img{display:block;width:${w}px;height:${h}px}`,
    `</style></head><body><img src="file://${svgPath}"></body></html>`,
  ].join("\n");
  const htmlPath = join(work, "art.html");
  writeFileSync(htmlPath, html);
  const profile = join(work, "profile");
  execFileSync(
    chromium,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`,
      "--default-background-color=00000000",
      `--window-size=${w},${h}`,
      `--screenshot=${outPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  );
  const { w: rw, h: rh, colorType, bytes } = pngDimensions(outPath);
  if (rw !== w || rh !== h) {
    throw new Error(`${asset.out}: rendered ${rw}x${rh}, expected ${w}x${h}`);
  }
  // Transparent assets need RGBA. Full-bleed promo art may encode opaque RGB.
  if (asset.transparent && colorType !== 6) {
    throw new Error(`${asset.out}: PNG color type ${colorType}, expected 6 (RGBA)`);
  }
  return { out: asset.out, w: rw, h: rh, kb: Math.round(bytes / 1024) };
}

function checkOnly() {
  let failed = false;
  for (const asset of ASSETS) {
    const outPath = join(ROOT, asset.out);
    if (!existsSync(outPath)) {
      console.error(`MISSING  ${asset.out}`);
      failed = true;
      continue;
    }
    const [w, h] = asset.size;
    const { w: rw, h: rh } = pngDimensions(outPath);
    const ok = rw === w && rh === h;
    if (!ok) failed = true;
    console.log(`${ok ? "OK      " : "WRONG   "} ${asset.out} (${rw}x${rh}, want ${w}x${h})`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--check")) checkOnly();
const chromium = findChromium();
let failed = 0;
for (const asset of ASSETS) {
  try {
    const r = renderOne(chromium, asset);
    console.log(`rendered ${r.out} (${r.w}x${r.h}, ${r.kb} KB)`);
  } catch (err) {
    failed++;
    console.error(`FAILED   ${asset.out}: ${err.message}`);
  }
}
if (process.argv.includes("--install")) {
  // The manifest references icons/icon{16,32,48,128}.png; keep those names.
  const installs = [
    ["store/icons/leia-16.png", "src/icons/icon16.png"],
    ["store/icons/leia-32.png", "src/icons/icon32.png"],
    ["store/icons/leia-48.png", "src/icons/icon48.png"],
    ["store/icons/leia-128.png", "src/icons/icon128.png"],
  ];
  for (const [from, to] of installs) {
    copyFileSync(join(ROOT, from), join(ROOT, to));
    console.log(`installed ${to}`);
  }
}
if (failed > 0) {
  console.error(`${failed} asset(s) failed`);
  process.exit(1);
}
