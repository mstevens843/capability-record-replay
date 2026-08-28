#!/usr/bin/env node
// The process wrapper: stdin -> app -> stdout, and nothing else.
//
// Everything interesting is in `app.js`, which knows nothing about processes. This file exists so
// the fixture can be spawned behind the driver's `pipe` transport, and it is deliberately the only
// file in the package that touches `process`.
//
// It writes ANSI unconditionally and never asks whether stdout is a tty. That is not laziness: it
// is the reason this fixture needs no pty at all. A pty exists to convince a third-party binary
// that it is talking to a terminal so that it will emit escape sequences; we wrote this binary, so
// there is nothing to convince. Real green screens - Symitar Episys, 5250, 3270 - are reached over
// telnet/SSH with no client-side pty either, so this is also the more faithful arrangement.
//
// Usage:
//   node src/main.js [--tenant riverbend|summit] [--fault <id>] [--fault-at <screen>]
//                    [--fault-mode once|sticky] [--delay-ms 400] [--tear-at 0.55]
// Environment variables of the same names (TENANT, FAULT, FAULT_AT, FAULT_MODE, DELAY_MS, TEAR_AT)
// are read as defaults, because a spawned child is often easier to configure through `env`.

import process from "node:process";
import { createTellerApp } from "./app.js";

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = "true";
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const num = (raw) => {
    const n = Number.parseFloat(String(raw ?? ""));
    return Number.isFinite(n) ? n : undefined;
  };
  const app = createTellerApp({
    tenant: args.tenant ?? env.TENANT,
    fault: args.fault ?? env.FAULT,
    faultAt: args["fault-at"] ?? env.FAULT_AT,
    faultMode: args["fault-mode"] ?? env.FAULT_MODE,
    delayMs: num(args["delay-ms"] ?? env.DELAY_MS),
    tearAt: num(args["tear-at"] ?? env.TEAR_AT),
  });

  app.onOutput((chunk) => process.stdout.write(chunk, "latin1"));
  process.stdin.on("data", (buffer) => {
    app.write(buffer.toString("latin1"));
    if (app.exitRequested) {
      app.close();
      process.exit(0);
    }
  });
  process.stdin.on("end", () => {
    app.close();
    process.exit(0);
  });
  app.start();
}

// Guarded so the module can be imported by a test without wiring anything to stdin.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
