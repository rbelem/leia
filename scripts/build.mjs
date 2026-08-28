import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { patchReadability } from "./readability-patch.mjs";

// AMO flags `.innerHTML =` even inside Mozilla's vendored Readability; patch
// those two exact statements at bundle time (see readability-patch.mjs).
const readabilityPatch = {
  name: "readability-innerhtml-patch",
  setup(build) {
    build.onLoad({ filter: /[\\/]@mozilla[\\/]readability[\\/]Readability\.js$/ }, (args) => ({
      contents: patchReadability(readFileSync(args.path, "utf8")),
      loader: "js",
    }));
  },
};

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
    plugins: [readabilityPatch],
  });

  cpSync("src/popup/popup.html", `dist/${browser}/popup/popup.html`);
  cpSync("src/probes/offscreen.html", `dist/${browser}/probes/offscreen.html`);
  cpSync("src/offscreen/audio.html", `dist/${browser}/offscreen/audio.html`);
  cpSync("src/icons", `dist/${browser}/icons`, { recursive: true });

  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  if (browser === "firefox") {
    // Firefox MV3 background is an event page, not a service worker (ADR-0002).
    manifest.background = { scripts: ["background/index.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        id: "leia@rclb.dev",
        strict_min_version: "140.0",
        // AMO-required disclosure (Nov 2025+). Default path (Web Speech)
        // transmits nothing; a configured provider key opts the user into
        // sending page text to their chosen TTS API.
        data_collection_permissions: {
          required: ["none"],
          optional: ["websiteContent"],
        },
      },
      // The disclosure key is only understood from FF 142 on Android; keep
      // the desktop floor at 140 and raise Android to match the key.
      gecko_android: { strict_min_version: "142.0" },
    };
    // Chrome-only / dead permissions never ship to Firefox: "offscreen" is
    // capability-gated to Chrome at runtime (chromeOffscreen()), and nothing
    // calls the shortcut-management APIs that "keyboard-shortcuts" gates.
    manifest.permissions = manifest.permissions.filter((p) => p !== "offscreen" && p !== "keyboard-shortcuts");
  }
  writeFileSync(`dist/${browser}/manifest.json`, JSON.stringify(manifest, null, 2));

  console.log(`✓ dist/${browser}`);
}