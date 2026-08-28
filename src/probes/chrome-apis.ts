// SPDX-License-Identifier: MPL-2.0
import browser from "webextension-polyfill";

/**
 * Minimal inline typings for Chrome-only APIs used by the T2 probe harness
 * (webextension-polyfill's types don't cover `offscreen` or `tts`).
 * Probe harness only — product code must not depend on these.
 */

export interface TtsVoice {
  voiceName: string;
  lang: string;
  remote: boolean;
}

export interface TtsEvent {
  type: string;
  charIndex?: number;
  charLength?: number;
  errorMessage?: string;
}

export interface TtsSpeakOptions {
  onEvent: (event: TtsEvent) => void;
}

export interface ChromeTts {
  getVoices(callback: (voices: TtsVoice[]) => void): void;
  speak(text: string, options?: TtsSpeakOptions): void;
}

export interface ChromeOffscreen {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

export function chromeTts(): ChromeTts | undefined {
  return (browser as unknown as { tts?: ChromeTts }).tts;
}

export function chromeOffscreen(): ChromeOffscreen | undefined {
  return (browser as unknown as { offscreen?: ChromeOffscreen }).offscreen;
}