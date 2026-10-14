# Leia source package (for AMO review)

The uploaded add-on zip contains minified, generated bundles (esbuild). This
archive holds the original sources and the exact build steps to reproduce it.

## Build steps

1. Install Node.js 22+ and npm.
2. `npm ci`          installs pinned dependencies from package-lock.json
3. `node scripts/build.mjs`   writes production bundles to dist/chrome and
   dist/firefox
4. The Firefox submission zip is the contents of `dist/firefox`
   (manifest.json at the archive root): `cd dist/firefox && zip -r ../.. .`

No other steps, patches, or network fetches are needed at build time.

## Notes for reviewers

- `scripts/readability-patch.mjs` rewrites two `innerHTML =` assignments in
  Mozilla's vendored Readability at bundle time; the rest of the vendored file
  is unmodified (`node_modules/@mozilla/readability`).
- The bundles in dist/ are generated from src/ TypeScript; every shipped file
  has a .map alongside it.
- Firefox-specific manifest changes (event page background, CSP
  `upgrade-insecure-requests`, `browser_specific_settings`) happen in
  scripts/build.mjs under the `browser === "firefox"` branch.
