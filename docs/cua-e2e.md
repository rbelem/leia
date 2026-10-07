# Native permission-grant e2e (cua-driver)

How `npm run test:e2e` proves the real `permissions.request` save path end to
end: CDP clicks the options-page Save (a trusted gesture), the native
"**Leia** has requested additional permissions." bubble appears, cua-driver
clicks **Allow** over AT-SPI, and the test asserts ground truth —
`chrome.permissions.contains({origins:["https://api.openai.com/*"]}) === true`
AND the sentinel key persisted to `chrome.storage.local`. CDP cannot see or
click browser-process chrome, so cua is the only proven path to this surface
(issue #22; live transcript 2026-10-07: bubble window 462x220, element token
`s…:104`, `route: "accessibility"`, `granted: true`).

## Activation recipe — why BOTH parts exist

chromium is invisible to AT-SPI (and therefore to cua-driver) unless both:

1. `org.a11y.Status.ScreenReaderEnabled=true` on the session bus **before**
   the browser process starts — the property is read at browser-process
   start; setting it post-spawn does nothing (isolated experiment,
   investigation §1).
   ```sh
   busctl --user set-property org.a11y.Bus /org/a11y/bus org.a11y.Status \
     ScreenReaderEnabled b true
   ```
2. `--force-renderer-accessibility` on the chromium command line — without it
   the AT-SPI tree stays 2-element shallow (frame + heading) and never fills
   in; with it the full tree materializes (~100 elements).

`cli/chrome.js` runs this recipe by default (pre-spawn guard + spawn arg +
restore in `stop()`), behind the `LEIA_NO_FORCE_A11Y=1` kill switch. The e2e
test passes the flag itself and never depends on the CLI guard.

**Set-and-restore, not private bus.** A private `dbus-run-session` bus does
NOT work on a developer desktop: the cua daemon is anchored to the real
session bus, at-spi does not bridge buses, and the daemon can never see a
browser registered on a private bus (spike A: `list_windows {pid}` → `[]`).
So the recipe sets the flag on the real session bus and restores the prior
value in `stop()` — except when a live cua daemon answers (it set the flag
first and re-asserts it at startup; never fight it). In CI the
`dbus-run-session` shape DOES work, because daemon + chromium + test share
that one private bus — the failure mode is bus *mismatch*, not private buses.

## The one-bus rule

Everything that must see the browser — the cua daemon, the chromium under
test, the test process — shares ONE session bus. On a desktop that is the
real session bus; in CI it is the single `dbus-run-session` bus (below).

## The smoke probe

Before anything else, the e2e polls `cua-driver call list_windows
--arguments '{"pid": …}'` for 2 s and fails with a checklist if the browser
window never shows up: recipe flag pre-spawn? `--force-renderer-accessibility`
present? at-spi2-core installed? AT-SPI registry wedged
(`org.a11y.atspi.Registry` missing from the a11y bus —
`systemctl --user restart at-spi-dbus-bus.service` revives it; else session
relogin). This tripwire exists because a wedged registry otherwise reads as a
silent 30 s timeout: the daemon keeps serving cached apps while no new app
can register.

## Failure taxonomy

| Symptom (evidence) | Error | Class | Handling |
|---|---|---|---|
| preflight (version pin / session bus / daemon) fails | `CuaUnavailableError` | env | loud skip locally (`LEIA_E2E` unset) / red in CI |
| smoke probe can't see the browser in 2 s | `CuaUnavailableError` | env (recipe/registry) | same |
| no bubble window in 5 s | `BubbleNeverAppearedError` | timing / dirty profile / product | one wholesale retry, then red |
| Allow button absent from the bubble tree | `BubbleNeverAppearedError` | product (bubble content) | red |
| `stale_element_token` ×3 | `StaleTokenExhaustedError` | env flake | adapter re-observes per click; budget absorbs, then red |
| click ok, `permissions.contains` false | `ClickedNotGrantedError` | **product bug** | red immediately, never retried |
| click ok, grant true, storage sentinel missing | assertion | product bug | red |

Discipline: element tokens die across snapshots — every click re-observes
first (never retry a dead token), and all cua calls pass one named session
(`leia-e2e-perm`). Clicks go ONLY through AT-SPI Action `press` via
`element_token`; coordinate clicks are prohibited. Verification is never
"click returned 0" — always the CDP ground-truth pair.

## CI bootstrap contract

```sh
xvfb-run -a dbus-run-session -- bash -c 'LEIA_E2E=1 npm run test:e2e'
```

- **packages**: `chromium`, `at-spi2-core` (launcher + registryd), `dbus`
  (`dbus-run-session`), `xvfb`, `busctl` (in `dbus`/systemd), `cua-driver`
  pinned `0.33.x`.
- **one bus for everything**: `dbus-run-session` wraps the npm process so the
  lazily-activated cua daemon, chromium, and the test share the one private
  bus. Xvfb/X11 also unlocks cua's XTest routes and needs no portal grants.
- **env**: `LEIA_E2E=1` arms the suite (unarmed runs skip loudly; armed runs
  hard-fail on env problems); `LEIA_E2E_PORT` free (default 9226 — never
  :9224/:9333, the shared dev stack).
- **preflight order** (mirrored by `ensureCuaRecipe`/`smokeProbe`, each
  failing fast with an actionable message): version pin → session bus →
  daemon answer → chromium spawn → smoke probe.
- **no portal grant chasing**: assertions ride element tokens + CDP ground
  truth, never pixels (per-window capture is impossible on KWin; desktop
  capture needs a one-time interactive portal grant — never auto-approve).

## Version matrix

| Component | Verified | Notes |
|---|---|---|
| KWin | 6.7.5 (Wayland) | exposes no foreign-toplevel protocols → window discovery rides the AT-SPI registry; screenshots/activation/refocus routes refused |
| cua-driver | 0.33.2 | pinned `^0.33` (`CUA_PIN`); 0.34.0 exists — re-check KWin/cua capabilities before bumping (KWin 6.5+ may grow `ext_foreign_toplevel_list_v1`) |
| chromium | 152.0.7977.64 | recipe carries over unchanged |

## Agent-environment hazards

- **Env scrub**: agent shells strip `DBUS_SESSION_BUS_ADDRESS`,
  `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY` from directly-spawned GUI binaries. A
  wrapper script that re-exports them works around it; node `child_process`
  spawns (what `cli/chrome.js` and this e2e use) are unaffected.
- **Process-group teardown**: kill the browser's whole process group
  (`detached: true` + `process.kill(-pid)`); killing only the leader leaves
  at-spi launcher/registry children behind.
