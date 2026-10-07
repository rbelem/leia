# leia

Browser TTS extension (Chrome MV3 + Firefox MV3 event page).

## Browser automation (firefox-devtools MCP)

Firefox must be launched manually — the MCP cannot spawn the flatpak binary:

```sh
nohup flatpak run org.mozilla.firefox --marionette --remote-debugging-port=9222 \
  >/tmp/opencode/firefox-flatpak.log 2>&1 &
```

- Port **9222** is what the MCP connects to (`list_pages` and friends).
- `restart_firefox({firefoxPath})` fails here: "flatpak run" is not a binary path. Always start via shell instead.
- Flatpak sandbox: use Flatseal to grant filesystem access to this repo dir (needed to load `dist/firefox` as an add-on).

## Build / test

- `npm run build` → `dist/chrome`, `dist/firefox`
- `npm test`, `npm run typecheck`
- `LEIA_E2E=1 npm run test:e2e` — native permission-grant e2e via cua-driver (see docs/cua-e2e.md)

## a11y recipe (chromium + AT-SPI)

- cli/chrome.js forces the a11y activation recipe by default (session-bus
  ScreenReaderEnabled pre-spawn + `--force-renderer-accessibility`) so
  cua-driver e2e can see the browser; `LEIA_NO_FORCE_A11Y=1` opts out.
  Rationale: docs/cua-e2e.md §"activation recipe".
- Agent shells scrub DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR/WAYLAND_DISPLAY
  from directly-spawned GUI binaries; if you launch chromium from an agent
  shell, wrap it in a script that re-exports them (node child_process spawns
  are unaffected).
