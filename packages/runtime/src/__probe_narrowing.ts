// ############################################################################################
// DELETE THIS FILE. IT IS SCRATCH AND IT BREAKS THIS PACKAGE'S OWN BARREL CONTRACT TEST.
//
//     rm packages/runtime/src/__probe_narrowing.ts
//
// Written by a documentation-correction pass on 2026-08-29 to answer ONE question with tsc
// rather than with an opinion: does `JournalEvent` narrow on `type`? It does not - the
// `@ts-expect-error` below is SATISFIED, which is the proof, and `pnpm -F @crr/runtime
// typecheck` exits 0 with this file present. That is FINAL-STATUS section 7.12, confirmed.
//
// The agent that wrote it could not remove it: the user's settings carry a hard `Bash(rm *)` /
// `Bash(mv *)` deny, and routing around an explicit deny is not something it will do. While
// this file is here, `packages/runtime/test/barrel.test.ts` fails 3 tests - CORRECTLY, because
// a module in `src/` that the barrel does not re-export is precisely what that test exists to
// catch. The suite measures 1,984/1,984 with this file absent.
// ############################################################################################

import type { JournalEvent } from "@crr/core";

export function probe(e: JournalEvent): string {
  if (e.type === "run.started") {
    // @ts-expect-error - if the union discriminated on `type`, `tenantId` would be present here.
    return e.tenantId;
  }
  return "";
}
