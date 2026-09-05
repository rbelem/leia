#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * leia — the leia-ctl CLI. One engine (BrowserAdapter + WS bridge), three
 * fronts (subcommand / REPL / --json machine mode).
 *
 *   node cli/index.js up
 *   node cli/index.js start --voice en-US --text "hello world"
 *   node cli/index.js status --json
 *   node cli/index.js repl
 */
import { createAdapter } from "./adapter.js";
import { getCommand, listCommandNames, splitArgs } from "./commands.js";
import { runRepl } from "./repl.js";

const GLOBAL_FLAGS = ["--browser", "-b", "--port", "-p", "--token", "--json", "--help", "--profile", "--chrome-bin"];

function usage() {
  const cmds = listCommandNames().join(" ");
  return `leia-ctl — drive the Leia extension end-to-end from the CLI.

USAGE
  node cli/index.js [global flags] <command> [args] [--flags]

GLOBAL FLAGS
  -b, --browser   chrome | firefox   (default: chrome; firefox is attach-only)
  -p, --port      WS bridge port      (default: 9333 — must match the extension CSP)
      --token     WS handshake token  (default: none for now)
      --profile   Firefox profile dir (attach-only; for extension UUID discovery)
      --chrome-bin  Chromium binary path (default: $CHROME or 'chromium')
      --json      machine output (print the reply/data as JSON)

COMMANDS
  ${cmds}

  Run 'node cli/index.js <cmd> --help' for a command's own flags.`;
}

/** Resolve the effective browser from global flags. */
function resolveBrowser(flags) {
  const b = flags.browser || process.env.LEIA_BROWSER || "chrome";
  if (b !== "chrome" && b !== "firefox") {
    throw new Error(`unknown browser '${b}' (choose chrome|firefox)`);
  }
  return b;
}

/** Peel global flags off the front of argv; return { globalFlags, tokens }. */
function parseGlobalFlags(argv) {
  const globalFlags = {};
  const tokens = [];
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (GLOBAL_FLAGS.includes(t)) {
      const key = t === "-b" ? "browser" : t === "-p" ? "port" : t.replace(/^--/, "");
      const val = argv[i + 1] && !GLOBAL_FLAGS.includes(argv[i + 1]) ? argv[++i] : true;
      globalFlags[key] = val;
    } else {
      tokens.push(t);
    }
    i++;
  }
  return { globalFlags, tokens };
}

/** Build the adapter + command ctx. */
function buildContext(globalFlags, rest, flags) {
  const adapterP = createAdapter(resolveBrowser(globalFlags), {
    port: Number(globalFlags.port || 9333),
    token: globalFlags.token || null,
    profileDir: globalFlags.profile,
    chromeBin: globalFlags["chrome-bin"],
  });
  // The ctx is built after the adapter resolves; we return a factory because
  // createAdapter is async.
  return async function makeCtx() {
    const adapter = await adapterP;
    const ctx = {
      adapter,
      json: Boolean(flags.json || globalFlags.json),
      help: Boolean(flags.help || globalFlags.help),
      rest,
      flags,
      opts: globalFlags,
      spawnEventsFollow: () => followEvents(adapter, ctx),
    };
    return ctx;
  };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || (argv.includes("--help") && argv.length === 1)) {
    console.log(usage());
    return;
  }

  const { globalFlags, tokens } = parseGlobalFlags(argv);

  const commandName = tokens[0];
  if (!commandName) {
    console.log(usage());
    return;
  }
  const commandTokens = tokens.slice(1);
  const { rest, flags } = splitArgs(commandTokens);

  if (commandName === "repl") {
    await runRepl(globalFlags);
    return;
  }

  const command = getCommand(commandName);
  if (!command) {
    console.error(`unknown command '${commandName}'`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (flags.help || globalFlags.help) {
    console.log(usage());
    return;
  }

  const makeCtx = buildContext(globalFlags, rest, flags);
  const ctx = await makeCtx();
  await dispatch(command, commandName, ctx, rest, flags);
}

async function dispatch(command, commandName, ctx, rest, flags) {
  try {
    const result = await command(ctx, { rest, flags });
    printResult(ctx, result, commandName);
  } catch (e) {
    if (ctx.json) {
      console.log(JSON.stringify({ ok: false, command: commandName, error: e.message }));
    } else {
      console.error(`[error] ${e.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (commandName !== "events") adapterClose(ctx);
  }
}

function adapterClose(ctx) {
  ctx.adapter.close();
}

/** Print the command result honoring --json. */
function printResult(ctx, result, commandName) {
  if (ctx.json) {
    printJson(ctx, result, commandName);
    return;
  }
  if (result === undefined || result === null) {
    console.log("[ok]");
    return;
  }
  if (typeof result !== "object") {
    console.log(String(result));
    return;
  }
  if (result.error !== undefined) {
    console.log(`[error] ${result.error}`);
    return;
  }
  if (result.message !== undefined) {
    console.log(result.message);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function printJson(ctx, result, commandName) {
  const out = result && typeof result === "object" && "ok" in result ? result : { ok: true, command: commandName, data: result };
  console.log(JSON.stringify(out, null, 2));
}

/** Follow the live event stream — print `{type:'event'}` until Ctrl+C. */
async function followEvents(adapter, _ctx) {
  return new Promise((resolve) => {
    console.log("following events… (Ctrl+C to stop)");
    const un = adapter.onEvent((name, data, raw) => {
      console.log(`[event] ${name} ${raw ? JSON.stringify(raw.data ?? data) : ""}`);
    });
    const unConn = adapter.onConnection(() => console.log("[ws] harness connected"));
    const unDisc = adapter.onDisconnect(() => console.log("[ws] harness disconnected"));
    const onSigint = () => {
      process.off("SIGINT", onSigint);
      un();
      unConn();
      unDisc();
      resolve({ ok: true, message: "event stream ended" });
    };
    process.on("SIGINT", onSigint);
  });
}

main().catch((e) => {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exitCode = 1;
});
