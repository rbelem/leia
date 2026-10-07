// SPDX-License-Identifier: MPL-2.0
/** Minimal surface of cli/chrome.js for typed tests (cli itself is untyped JS). */
export function parseFlatpakWrapper(source: string | null | undefined): string | null;
export function flatpakProfileRoot(): string;
export function makeProfileDir(flatpakAppId: string | null): string;
export class ChromeAdapter {
  constructor(opts?: Record<string, unknown>);
}
