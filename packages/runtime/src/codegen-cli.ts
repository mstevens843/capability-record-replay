#!/usr/bin/env node
// `pnpm codegen` - read every approved contract in a document store, emit the caller's types.
//
// A separate entry point from `crr` on purpose. `crr` is what a REVIEWER runs against a live
// surface; this is a build step that touches no surface, no session and no network, and keeping the
// two apart means a `--check` in CI cannot accidentally acquire a browser dependency.
//
// `--check` is the mode that earns its keep: it regenerates in memory and exits non-zero if any
// file on disk differs. A generated file that is stale is exactly the condition the runtime digest
// pin catches at invocation time, and catching it at build time instead is strictly better - the
// pin is the backstop, not the plan.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type CapabilityContract, parseContract } from "@crr/core";
import { generateContractModule, generateIndexModule, writeGenerated } from "./codegen.js";

const USAGE = `crr-codegen - emit typed capability bindings from approved contracts

  pnpm codegen [--store <dir>] [--out <dir>] [--check]

Options
  --store <dir>   a document store root; contracts are read from <dir>/contracts   (default: ./evidence/store)
  --out <dir>     where the generated modules are written                          (default: ./generated)
  --check         do not write; exit 1 if anything on disk differs

Reads documents and writes TypeScript. Contacts nothing.
`;

/**
 * Every contract in a store, sorted by file name so the barrel is deterministic.
 *
 * A missing directory is EMPTY rather than an exception: a fresh checkout has no store yet, and
 * "ENOENT: scandir ..." is a worse thing to print at somebody than "no contracts under <path>". A
 * file that is present and unparseable still throws, because that is a real problem with a real
 * document and swallowing it would emit a silently incomplete barrel.
 */
function contractsIn(storeRoot: string): readonly CapabilityContract[] {
  const dir = join(storeRoot, "contracts");
  if (!existsSync(dir)) return [];
  const contracts: CapabilityContract[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    contracts.push(parseContract(JSON.parse(readFileSync(join(dir, file), "utf8"))));
  }
  return contracts;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { values } = parseArgs({
    args: [...argv],
    options: {
      store: { type: "string" },
      out: { type: "string" },
      check: { type: "boolean" },
    },
  });

  const store = resolve(values.store ?? "evidence/store");
  const out = resolve(values.out ?? "generated");
  const contracts = contractsIn(store);

  if (contracts.length === 0) {
    process.stderr.write(`no contracts under ${join(store, "contracts")}\n`);
    return 1;
  }

  if (values.check) {
    const modules = [...contracts.map(generateContractModule), generateIndexModule(contracts)];
    const stale = modules.filter((module) => onDisk(join(out, module.path)) !== module.source);
    for (const module of stale) {
      process.stderr.write(`stale: ${join(out, module.path)}\n`);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `${stale.length} generated file(s) differ from the contracts in ${store}. Run \`pnpm codegen\`.\n`,
      );
      return 1;
    }
    process.stdout.write(`codegen up to date - ${contracts.length} contract(s)\n`);
    return 0;
  }

  const result = writeGenerated(contracts, out);
  process.stdout.write(
    `codegen: ${result.written.length} written, ${result.unchanged.length} unchanged -> ${result.outDir}\n`,
  );
  for (const file of result.written) process.stdout.write(`  ${file}\n`);
  return 0;
}

function onDisk(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// `import.meta.url` guard so a test can import `main` without running the command.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `crr-codegen: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
