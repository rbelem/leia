import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ENTRIES = [
  "src/background/index.ts",
  "src/content/index.ts",
  "src/floating-bar/index.ts",
  "src/popup/popup.ts",
  "src/probes/offscreen.ts",
  "src/offscreen/audio.ts",
];
const BROWSERS = ["chrome", "firefox"];

for (const browser of BROWSERS) {
  rmSync(`dist/${browser}`, { recursive: true, force: true });

  await build({
    entryPoints: ENTRIES,
    outdir: `dist/${browser}`,
    entryNames: "[dir]/[name]",
    bundle: true,
    format: "iife",
    target: ["es2022"],
    sourcemap: true,
    logLevel: "info",
  });

  cpSync("src/popup/popup.html", `dist/${browser}/popup/popup.html`);
  cpSync("src/probes/offscreen.html", `dist/${browser}/probes/offscreen.html`);
  cpSync("src/offscreen/audio.html", `dist/${browser}/offscreen/audio.html`);

  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  if (browser === "firefox") {
    // Firefox MV3 background is an event page, not a service worker (ADR-0002).
    manifest.background = { scripts: ["background/index.js"] };
    manifest.browser_specific_settings = {
      gecko: { id: "leia@rbelem.dev", strict_min_version: "140.0" },
    };
    // "keyboard-shortcuts" permission (FF-only): lets the Settings UI open
    // about:addons shortcut management and expose UpdateShortcut API.
    manifest.permissions = [...manifest.permissions, "keyboard-shortcuts"];
  }
  writeFileSync(`dist/${browser}/manifest.json`, JSON.stringify(manifest, null, 2));

  console.log(`✓ dist/${browser}`);
}