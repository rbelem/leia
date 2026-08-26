# Leia — Chrome/Firefox parity checklist (T18)

Run the same scenarios in both browsers and mark Pass/Fail/Notes. Shipped
builds: `npm run build` → `dist/chrome` + `dist/firefox` (store zips via
`node scripts/zip.mjs`).

**Load**

- Chrome: `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`
- Firefox: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → any file in `dist/firefox`

| # | Scenario | Chrome | Firefox | Notes |
|---|----------|--------|---------|-------|
| 1 | Read selection (floating bar) | ☐ | ☐ | sentence highlight marches |
| 2 | Read article (no selection; readable page) | ☐ | ☐ | T3 fallback |
| 3 | Word-granular marching (estimated, Web Speech) | ☐ | ☐ | T5 |
| 4 | Word-granular marching (provider with word timing) | ☐ | ☐ | needs key |
| 5 | Sentence marching only (`wordTiming:false`, e.g. OpenAI) | ☐ | ☐ | ADR-0003 disclosure |
| 6 | Click-to-seek inside the read scope | ☐ | ☐ | T7 |
| 7 | Pause / resume keeps highlight + position | ☐ | ☐ | |
| 8 | Stop clears live state, resume record kept | ☐ | ☐ | T16 |
| 9 | Per-URL resume on revisit (same article) | ☐ | ☐ | continues at saved token |
| 10 | Resume clear action removes saved position | ☐ | ☐ | popup row |
| 11 | Keyboard toggle Alt+Shift+L (play/pause/stop→start) | ☐ | ☐ | rebindable in extension shortcuts settings |
| 12 | Voice picker groups by family + capability pills | ☐ | ☐ | |
| 13 | Provider key entry activates family voices immediately | ☐ | ☐ | minimax / elevenlabs / openai / azure(+region) |
| 14 | Missing-key states + voice preview per family | ☐ | ☐ | preview needs the family's key |
| 15 | Theme picker: swap is instant incl. active march | ☐ | ☐ | persists across pages |
| 16 | Highlight contrast on light and dark pages | ☐ | ☐ | incl. dark code blocks |
| 17 | Local server profile online (kokoro :8880 or sidecar shim) | ☐ | ☐ | voices appear after TTL refresh ≤30s or reload |
| 18 | Local server offline → family invisible, no errors on start | ☐ | ☐ | |
| 19 | Start in tab B preserves tab A position (resume store) | ☐ | ☐ | single active session |
| 20 | Kill local server mid-read → actionable error, safe park | ☐ | ☐ | error line in popup |
| 21 | Remove provider key mid-read → actionable error | ☐ | ☐ | |
| 22 | Store zips install cleanly (drag dist/*.zip into browsers) | ☐ | ☐ | manifest.json at zip root |

**Store payloads**: `dist/chrome.zip` (Chrome Web Store), `dist/firefox.zip`
(AMO). Rebuild both with `npm run build && node scripts/zip.mjs`.
