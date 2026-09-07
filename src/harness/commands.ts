// SPDX-License-Identifier: MPL-2.0
/**
 * CLI/REPL command name → extension message mapping for the harness page.
 * Own module so tests can import it without harness.ts's DOM/WebSocket
 * side effects (main() runs at module load there).
 */

/** Map a CLI command name + args to the extension message to send. */
export function commandToMessage(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "ping":
      return { type: "ping" };
    case "voices":
      return { type: "leia:reader:voices" };
    case "status":
      return { type: "leia:reader:status" };
    case "page-info":
      return { type: "leia:page-info" };
    case "theme":
      return { type: "leia:theme:set", theme: args.theme ?? "amber" };
    case "start":
      // `args.text` carries explicit token text; otherwise the background
      // captures the active tab's selection (its `handleReaderStart` fallback).
      return {
        type: "leia:reader:start",
        ...(typeof args.text === "string" ? { tokens: [{ text: args.text }] } : {}),
      };
    case "pause":
      return { type: "leia:reader:pause" };
    case "resume":
      return { type: "leia:reader:resume" };
    case "stop":
      // Explicit user stop: forget the page's saved position too.
      return { type: "leia:reader:stop", forget: true };
    case "seek":
      return { type: "leia:reader:seek", token: args.token };
    case "prefs": {
      // Build the payload only from args actually given. A phantom
      // `engine: undefined` key must not reach the session: there it
      // suppresses the voice→family pin (session.ts strips undefined-valued
      // keys too — belt and suspenders).
      const msg: Record<string, unknown> = { type: "leia:reader:prefs" };
      if (args.voiceName !== undefined) msg.voiceName = args.voiceName;
      if (args.rate !== undefined) msg.rate = args.rate;
      if (args.engine !== undefined) msg.engine = args.engine;
      return msg;
    }
    case "preview":
      return { type: "leia:reader:preview", voiceName: args.voiceName };
    case "scope":
      return { type: "leia:selection:capture" };
    case "audio:families":
      return { type: "leia:audio:families" };
    case "audio:clock":
      return { type: "leia:audio:clock" };
    default:
      // `probe:<x>` resolves to `leia:probe-<x>` / `leia:tts-probe` / etc.
      if (name.startsWith("probe:")) {
        const probe = name.slice("probe:".length);
        if (probe === "tts") return { type: "leia:tts-probe" };
        if (probe === "ff" || probe === "ff-playback") return { type: "leia:ff-playback" };
        return { type: `leia:probe-${probe}` };
      }
      return null;
  }
}
