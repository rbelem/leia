# Platform floor

Leia's marching highlight (ADR-0001) renders with the CSS Custom Highlight API
(`::highlight()`). The extension does not ship a fallback renderer for
browsers without it.

| Browser | Floor | Why |
|---|---|---|
| Chrome | ≥ 109 | offscreen document API (`chrome.offscreen`, Chrome 109) is the audio owner for Chrome (ADR-0002); Custom Highlight API (105) is older — 109 covers both; enforced via `minimum_chrome_version` in the manifest |
| Firefox | ≥ 140 | 2026 stable line; enforced via `browser_specific_settings.gecko.strict_min_version` in the Firefox build |

- The floor is enforced in the **manifest**, not just documented:
  `minimum_chrome_version: "105"` is shared, `strict_min_version: "140.0"` is
  patched into the Firefox build.
- `webextension-polyfill` bridges the extension API namespace
  (`browser.*` ↔ `chrome.*`); it does **not** polyfill web platform APIs.
  Custom Highlight is a web API, so the polyfill cannot cover it — another
  reason for the hard floor.
- **No fallback renderer planned.** A text-range overlay for older engines
  would be a second implementation of the most fiddly surface in the product
  (ADR-0001: timestamps → ranges), and the floor already covers the target
  audience.