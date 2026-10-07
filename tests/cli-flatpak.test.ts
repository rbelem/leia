// SPDX-License-Identifier: MPL-2.0
/**
 * cli/chrome.js flatpak lifecycle (issue #21) — pure helpers only.
 * No browser, no flatpak daemon, no cua: wrapper-content parsing, durable
 * profile-root selection, and the state.json round-trip (incl. the optional
 * instanceId/flatpakAppId fields).
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cli/chrome flatpak lifecycle (issue #21)", () => {
  let chrome: typeof import("../cli/chrome");
  let state: typeof import("../cli/state");
  let sandbox: string;
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;

  beforeEach(async () => {
    chrome = await import("../cli/chrome");
    state = await import("../cli/state");
    sandbox = mkdtempSync(join(tmpdir(), "leia-flatpak-test-"));
    savedHome = process.env.HOME;
    savedStateDir = process.env.LEIA_STATE_DIR;
    process.env.HOME = sandbox;
    process.env.LEIA_STATE_DIR = join(sandbox, "state");
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.LEIA_STATE_DIR;
    else process.env.LEIA_STATE_DIR = savedStateDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe("parseFlatpakWrapper", () => {
    it("extracts the app-id from a plain exec wrapper", () => {
      expect(chrome.parseFlatpakWrapper(`exec flatpak run org.chromium.Chromium "$@"`)).toBe(
        "org.chromium.Chromium",
      );
    });

    it("skips flags between run and the app-id", () => {
      expect(
        chrome.parseFlatpakWrapper(`exec flatpak run --user org.chromium.Chromium "$@"`),
      ).toBe("org.chromium.Chromium");
      expect(
        chrome.parseFlatpakWrapper(`flatpak run --branch=stable org.chromium.Chromium`),
      ).toBe("org.chromium.Chromium");
    });

    it("returns null for plain binaries and non-flatpak wrappers", () => {
      expect(chrome.parseFlatpakWrapper(`exec /usr/bin/chromium --flags "$@"`)).toBeNull();
      expect(chrome.parseFlatpakWrapper(`exec chromium "$@"`)).toBeNull();
      expect(chrome.parseFlatpakWrapper("")).toBeNull();
    });

    it("returns null when flatpak run has no dotted app token", () => {
      expect(chrome.parseFlatpakWrapper(`flatpak run --user`)).toBeNull();
    });
  });

  describe("profile root selection", () => {
    it("flatpak sessions get a durable mkdtemp under ~/.local/share/leia/profiles", () => {
      const dir = chrome.makeProfileDir("org.chromium.Chromium");
      try {
        expect(dir.startsWith(join(sandbox, ".local", "share", "leia", "profiles", "leia-chrome-"))).toBe(true);
        expect(existsSync(dir)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("plain binaries keep the /tmp/opencode profile root", () => {
      const dir = chrome.makeProfileDir(null);
      try {
        expect(dir.startsWith(join("/tmp/opencode", "leia-chrome-"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("state.json round-trip with instanceId", () => {
    it("persists and clears the flatpak fields alongside the classic ones", () => {
      const st = {
        browser: "chrome",
        debugPort: 9224,
        profileDir: "/tmp/opencode/leia-chrome-x",
        extensionId: "abcdef",
        pid: 1234,
        flatpakAppId: "org.chromium.Chromium",
        instanceId: "3864146032",
      };
      state.saveState(st);
      expect(state.loadState()).toEqual(st);
      state.clearState();
      expect(state.loadState()).toBeNull();
    });

    it("still round-trips old-shaped state without flatpak fields", () => {
      const st = { browser: "chrome", debugPort: 9224, pid: 9, extensionId: "x", profileDir: "/p" };
      state.saveState(st);
      expect(state.loadState()).toEqual(st);
      state.clearState();
    });

    it("reads null when the state dir does not exist", () => {
      expect(state.loadState()).toBeNull();
    });
  });
});
