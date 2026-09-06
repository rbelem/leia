// SPDX-License-Identifier: MPL-2.0
/**
 * leia repl — interactive REPL built on the same command registry + adapter.
 * Each line is parsed like a `leia <cmd>` invocation (minus the global flags,
 * which were passed to the repl itself). The adapter stays alive across
 * commands so `up` once and drive many times.
 */
import readline from "node:readline";
import { createAdapter } from "./adapter.js";
import { getCommand, listCommandNames, splitArgs } from "./commands.js";

const BANNER = `leia-ctl REPL — ${listCommandNames().join(" ")}. Type 'quit' to exit.`;

export async function runRepl(globalFlags = {}) {
  const browser = globalFlags.browser || process.env.LEIA_BROWSER || "chrome";
  if (browser !== "chrome" && browser !== "firefox") {
    throw new Error(`unknown browser '${browser}'`);
  }
  const adapter = await createAdapter(browser, {
    port: Number(globalFlags.port || 9333),
    token: globalFlags.token || null,
    profileDir: globalFlags.profile,
    chromeBin: globalFlags["chrome-bin"],
    headless: !globalFlags.headed,
  });

  const ctx = {
    adapter,
    json: false,
    opts: globalFlags,
    spawnEventsFollow: () => Promise.resolve({ message: "events stream live in the REPL" }),
  };

  // Live-tail background broadcasts: every `leia:session:state` / `leia:audio:event`
  // / `leia:theme:set` / ... the harness observes is printed inline as it arrives.
  adapter.onEvent((name, data) => {
    console.log(`[event] ${name} ${JSON.stringify(data ?? {})}`);
  });
  const unConn = adapter.onConnection(() => console.log("[ws] harness connected"));
  const unDisc = adapter.onDisconnect(() => console.log("[ws] harness disconnected"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(BANNER);

  // Serialize command processing: readline fires callbacks concurrently when
  // lines are pasted, but the harness bridge is a single binding on 9333, so
  // commands must run one at a time (esp. `up` before the rest).
  let chain = Promise.resolve();
  const close = () => {
    unConn();
    unDisc();
    rl.close();
    adapter.close();
  };

  rl.on("line", (line) => {
    chain = chain.then(() => handleReplLine(ctx, rl, line, close));
  });

  rl.on("close", () => adapter.close());

  rl.prompt();
}

async function handleReplLine(ctx, rl, line, close) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed === "quit" || trimmed === "exit") return close();
  return handleLine(ctx, rl, trimmed);
}

async function handleLine(ctx, rl, line) {
  const [name, ...tokens] = line.trim().split(/\s+/);
  const command = getCommand(name);
  if (!command) {
    console.log(`unknown command '${name}' — try: ${listCommandNames().join(" ")}`);
    return;
  }
  const { rest, flags } = splitArgs(tokens);
  ctx.rest = rest;
  ctx.flags = flags;
  try {
    const result = await command(ctx, { rest, flags });
    printReplResult(name, result);
  } catch (e) {
    console.log(`[error] ${e.message}`);
  }
  // Only prompt again if the user hasn't quit (which closed the readline).
  if (!rl.closed) rl.prompt();
}

function printReplResult(name, result) {
  if (name === "up") {
    console.log("[ok] up — watch 'events' for the harness connect");
  } else if (result && result.error) {
    console.log(`[error] ${result.error}`);
  } else if (result && result.message) {
    console.log(result.message);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
