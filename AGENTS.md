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
