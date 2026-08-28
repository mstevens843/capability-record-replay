// The type test: adding an `OutcomeDecl` must BREAK a call-site `switch`.
//
// This is build unit 12's headline acceptance criterion and it is a claim about the COMPILER, so a
// runtime assertion cannot make it. The file makes it twice, at two different costs:
//
//   1. IN THIS FILE, for free, under `pnpm typecheck`. `@ts-expect-error` fails the build when the
//      line it guards does NOT error, so the assertion is two-way: the exhaustive switch over a
//      one-outcome contract must compile, and the same switch over a two-outcome contract must not.
//      A mechanism that quietly stopped working turns the guard into "unused @ts-expect-error" and
//      the typecheck goes red.
//   2. BY SPAWNING `tsc`, in a real test that `pnpm test` runs, over the ACTUAL OUTPUT of
//      `pnpm codegen`. That is the part 1 cannot do: it proves the emitted file compiles at all,
//      that the contract survives codegen as a literal rather than widening to
//      `CapabilityContract`, and that the compiler error a stale caller gets NAMES the outcome it
//      has never heard of. It costs a few seconds and it is worth them - the mechanism is one of
//      the six things SPEC section 11 says must never be cut.
//
// And the third assertion, which is the reason the runtime digest pin exists at all: hand a caller
// the WIDE `CapabilityContract` type and the whole thing evaporates silently. `outcome` becomes
// `string`, the `switch` becomes a string comparison, and nothing anywhere reports it. The pin is
// what converts that into `failed / contract-stale` at run time. See `test/invoke.test.ts`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityContract,
  type ReplayOutcomeArm,
  type ReplayResult,
  sealContract,
} from "@crr/core";
import { afterAll, describe, expect, it } from "vitest";
import { writeGenerated } from "../src/codegen.js";
import { disclosureContract } from "./fixtures/disclosure.js";

// ---------------------------------------------------------------------------------------------
// 1. Compile-time, in this file, checked by `pnpm typecheck`
// ---------------------------------------------------------------------------------------------

const ONE_OUTCOME = {
  schemaVersion: "capability.contract/v1",
  name: "typetest.one" as CapabilityContract["name"],
  version: "1.0.0" as CapabilityContract["version"],
  title: "One outcome",
  summary: "A capability with exactly one declared business outcome.",
  whenToUse: ["A type test needs a literal contract."],
  whenNotToUse: ["Anything else."],
  inputs: [
    {
      name: "memberId",
      type: { kind: "string", charset: "digits" },
      required: true,
      description: "The member number.",
      sensitivity: "sensitive",
      discoveredFrom: { goalSpan: "member {memberId}" },
    },
  ],
  outputs: [
    {
      name: "balance",
      type: { kind: "money", currency: "USD" },
      required: true,
      description: "The share balance.",
      sensitivity: "internal",
      agentDisclosure: "deliver",
    },
  ],
  outcomes: [
    {
      code: "MEMBER_NOT_FOUND",
      kind: "business_outcome",
      title: "Not on file",
      summary: "No such member.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      agentGuidance: "Ask for the number again.",
    },
  ],
  effect: "READ",
  requiresApproval: false,
  idempotent: true,
  digest: `sha256:${"a".repeat(64)}` as CapabilityContract["digest"],
} as const satisfies CapabilityContract;

/** The same capability after somebody declared a second business answer. */
const TWO_OUTCOMES = {
  ...ONE_OUTCOME,
  outcomes: [
    ...ONE_OUTCOME.outcomes,
    {
      code: "MEMBER_RESTRICTED",
      kind: "business_outcome",
      title: "Restricted",
      summary: "The core will not release this record's position.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      callerAction: "refer-to-specialist",
      retryable: "never",
      agentGuidance: "Offer to put them through to a person.",
    },
  ],
} as const satisfies CapabilityContract;

/**
 * The call site as it was written when the contract had one outcome. It compiles.
 *
 * The switch is over the extracted DISCRIMINANT rather than over the object, and that is not a
 * style choice. With one declared outcome `ReplayOutcomeArm<C>` is a single object type rather than
 * a union, and TypeScript's discriminant narrowing only removes union MEMBERS - so
 * `const impossible: never = r` in the default branch would not compile even though the switch is
 * exhaustive. Narrowing a string-literal type does reduce to `never`, so switching on
 * `r.outcome` bound to a local gives the same guarantee at every arity, one included.
 */
function handleOne(r: ReplayOutcomeArm<typeof ONE_OUTCOME>): string {
  const code = r.outcome;
  switch (code) {
    case "MEMBER_NOT_FOUND":
      return "not on file";
    default: {
      const impossible: never = code;
      return String(impossible);
    }
  }
}

/**
 * THE SAME call site, unchanged, against the contract after the outcome was added. It does not
 * compile, and `@ts-expect-error` is what asserts that: the day `ReplayOutcomeArm` stops
 * distributing over the outcome tuple, this guard becomes an unused suppression and
 * `pnpm typecheck` fails.
 */
function handleTwoUnchanged(r: ReplayOutcomeArm<typeof TWO_OUTCOMES>): string {
  const code = r.outcome;
  switch (code) {
    case "MEMBER_NOT_FOUND":
      return "not on file";
    default: {
      // @ts-expect-error MEMBER_RESTRICTED is unhandled, so `code` is not `never` here. Adding an
      // OutcomeDecl is a compile error at every existing call site - which is correct, because a
      // new possible answer IS a breaking change for a caller. If this ever stops erroring, the
      // suppression becomes unused and `pnpm typecheck` fails, which is the point.
      const impossible: never = code;
      return String(impossible);
    }
  }
}

/** Handling the new outcome makes it compile again, which is the fix the compiler was asking for. */
function handleTwoUpdated(r: ReplayOutcomeArm<typeof TWO_OUTCOMES>): string {
  const code = r.outcome;
  switch (code) {
    case "MEMBER_NOT_FOUND":
      return "not on file";
    case "MEMBER_RESTRICTED":
      return "restricted";
    default: {
      const impossible: never = code;
      return String(impossible);
    }
  }
}

/** The status union is exhaustive for the same reason, and that one never widens. */
function handleStatus(r: ReplayResult<typeof ONE_OUTCOME>): string {
  switch (r.status) {
    case "ok":
      return r.outputs.balance.amount;
    case "outcome":
      return handleOne(r);
    case "suspended":
      return r.intervention.id;
    case "failed":
      return r.failure.class;
    default: {
      const impossible: never = r;
      return String(impossible);
    }
  }
}

/**
 * And the silent-degradation case the runtime pin exists for.
 *
 * Nothing below is an error. `outcome` is `string`, the switch is a string comparison, and no
 * compiler anywhere reports it - which is exactly why `Invocation.capability.contractDigest` is
 * required and compared before a session is brokered.
 */
function handleWidened(r: ReplayOutcomeArm<CapabilityContract>): string {
  const code: string = r.outcome;
  return code === "ANYTHING_AT_ALL" ? "matched" : "did not match";
}

// ---------------------------------------------------------------------------------------------
// 2. The same claim, spawned, over what `pnpm codegen` actually emits
// ---------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const scratch = join(packageRoot, ".scratch");

/** The call site a caller writes against a generated module. Byte-identical in both projects: the
 *  contract is what changes, and that is the whole experiment. */
const CALL_SITE = `import type {
  MockMemberDiscloseArgs,
  MockMemberDiscloseOutputs,
  MockMemberDiscloseResult,
} from "./mock__member__disclose.js";
import { CAPABILITY, CONTRACT_DIGEST, mockMemberDisclose } from "./mock__member__disclose.js";

// The contract survived codegen as a LITERAL: these are literal types, not \`string\`.
const name: "mock.member.disclose" = mockMemberDisclose.name;
const pinned: string = CONTRACT_DIGEST;
void name;
void pinned;
void CAPABILITY;

const args: MockMemberDiscloseArgs = { memberId: "50001" };
void args;

export function handle(r: MockMemberDiscloseResult): string {
  switch (r.status) {
    case "ok": {
      const outputs: MockMemberDiscloseOutputs = r.outputs;
      return outputs.resultCount;
    }
    case "outcome": {
      const code = r.outcome;
      switch (code) {
        case "MEMBER_NOT_FOUND":
          return "not on file";
        case "MEMBER_RESTRICTED":
          return "restricted";
        default: {
          const impossible: never = code;
          return String(impossible);
        }
      }
    }
    case "suspended":
      return "pending";
    case "failed":
      return r.failure.class;
    default: {
      const impossible: never = r;
      return String(impossible);
    }
  }
}
`;

// Inlined rather than \`extends\`-ing the repo's base config: the project lives in a temp directory
// whose depth is not fixed, and a relative \`extends\` that resolves by accident is a test that
// breaks when somebody moves a folder.
const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ["./*.ts"],
  },
  null,
  2,
);

interface Compilation {
  readonly ok: boolean;
  readonly output: string;
}

function compileAgainst(contract: CapabilityContract): Compilation {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "typetest-"));
  created.push(dir);
  writeGenerated([contract], dir);
  writeFileSync(join(dir, "callsite.ts"), CALL_SITE);
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  try {
    execFileSync(process.execPath, [tscBin(), "-p", join(dir, "tsconfig.json")], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    return { ok: true, output: "" };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function tscBin(): string {
  const candidate = resolve(packageRoot, "node_modules/typescript/bin/tsc");
  return existsSync(candidate)
    ? candidate
    : resolve(packageRoot, "../../node_modules/typescript/bin/tsc");
}

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** The contract after somebody declared a third business answer. */
const widenedContract = sealContract({
  ...disclosureContract,
  outcomes: [
    ...disclosureContract.outcomes,
    {
      code: "ACCOUNT_CLOSED",
      kind: "business_outcome",
      title: "The membership is closed",
      summary: "The record exists and the membership has been closed.",
      terminal: true,
      payload: [],
      stableUnderRetry: true,
      callerAction: "inform-user",
      retryable: "never",
      agentGuidance: "Tell the member the account is closed and offer to reopen it.",
    },
  ],
});

describe("adding an OutcomeDecl is a compile error at every existing call site", () => {
  it("compiles the generated module and its exhaustive call site", () => {
    const result = compileAgainst(disclosureContract);
    expect(result.output).toBe("");
    expect(result.ok).toBe(true);
  }, 120_000);

  it("REFUSES to compile the same call site once a third outcome is declared", () => {
    const result = compileAgainst(widenedContract);
    expect(result.ok).toBe(false);
    // It names the outcome the caller has never heard of, and it points at the exhaustiveness
    // assignment rather than at some incidental line.
    expect(result.output).toContain("ACCOUNT_CLOSED");
    expect(result.output).toContain("not assignable to type 'never'");
    expect(result.output).toContain("callsite.ts");
  }, 120_000);
});

describe("the compile-time assertions in this file are real", () => {
  // These exist so `pnpm test` reports the functions above as exercised rather than as dead code
  // vitest never touched. The assertion they carry is made by `tsc`, not by `expect`.
  it("keeps every guarded call site referenced", () => {
    expect([
      handleOne,
      handleTwoUnchanged,
      handleTwoUpdated,
      handleStatus,
      handleWidened,
    ]).toHaveLength(5);
  });

  it("agrees that a widened contract loses the literal discriminant", () => {
    // The runtime shadow of the type-level fact: `CapabilityContract["outcomes"]` is an array of
    // declarations, so nothing at the type level can enumerate them.
    const wide: CapabilityContract = disclosureContract;
    expect(wide.outcomes.map((o) => o.code)).toEqual(["MEMBER_NOT_FOUND", "MEMBER_RESTRICTED"]);
  });
});
