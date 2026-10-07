// SPDX-License-Identifier: MPL-2.0
/** Minimal surface of cli/state.js for typed tests (cli itself is untyped JS). */
export function loadState(): unknown | null;
export function saveState(s: unknown): void;
export function clearState(): void;
export function stateError(): string;
