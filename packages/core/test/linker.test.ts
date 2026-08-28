// The linker's acceptance criterion, from SPEC section 11 build unit 7:
//
//     28 tests, one per check, each with a fixture that must fail it and one that must pass.
//
// The pairing is the whole design of this file. A test that only shows a refusal proves the linker
// says no; a test that only shows an acceptance proves it says yes. Neither alone shows that the
// check DISCRIMINATES, and a check that refuses everything is worth exactly as little as one that
// refuses nothing - which is the same argument the conformance suite's mutants make one level up.
//
// Two habits worth naming, because they are what makes the fixtures honest:
//
//   · Every mutated artifact is RESEALED. An edited document fails check 2 on its digest, which is
//     correct and is check 2's own test - but if the other twenty-seven fixtures were left unsealed
//     they would all fail on the digest and nothing below check 2 would ever have been exercised.
//     Resealing is the repair an author would actually make, and it is what puts each fixture in
//     front of the check it is aimed at.
//   · A failing fixture asserts the expected check is PRESENT, not that it is alone. Some mistakes
//     genuinely trip two checks - deleting an extraction leaves both an unproduced output and a
//     stale effect summary - and asserting exclusivity would be asserting that the linker reports
//     less than it knows.

import { describe, expect, it } from "vitest";
import {
  type Allowlist,
  LINK_CHECK_COUNT,
  type LinkRequest,
  type LinkResult,
  MOCK_SURFACE_CAPABILITIES,
  PRE_FLIGHT_FAILURES,
  type SurfaceCapabilities,
  artifactDigestOf,
  contractDigestOf,
  link,
  overlayDigestOf,
  surfaceFeaturesOf,
} from "../src/index.js";
import {
  memberLookupArtifact,
  memberLookupContract,
  summitOverlay,
} from "./fixtures/member-lookup.js";
import {
  type JsonRecord,
  SPEC_10_REJECTIONS,
  buildRejection,
} from "./fixtures/spec-10-rejections.js";

// ---------------------------------------------------------------------------------------------
// The world the linker is asked about
// ---------------------------------------------------------------------------------------------

const TRUSTED_KEY = "ops-approval-key-1";

/** A trust store that says yes. The bytes of an ed25519 signature are not what this file tests -
 *  WHICH digest was signed and WHOSE key signed it are, and both are document questions. */
const trust = { trustedKeyIds: [TRUSTED_KEY], verifySignature: () => true };

const allowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/members/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" },
    // The Summit tenant mounts the same product under /cb.
    { originAlias: "corebank", pathPattern: "/cb/members/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/cb/members/:memberId", maxEffect: "READ" },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

const pin = {
  name: memberLookupContract.name,
  version: memberLookupContract.version,
  contractDigest: memberLookupContract.digest,
};

const GOOD_ARGS = { memberId: "400123" } as const;

function request(overrides: Partial<LinkRequest> = {}): LinkRequest {
  return {
    contract: memberLookupContract,
    artifact: memberLookupArtifact,
    overlay: summitOverlay,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: GOOD_ARGS,
    invocation: pin,
    mode: "replay",
    allowlist,
    trust,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------------------------

const clone = <T>(value: T): T => structuredClone(value) as T;

const steps = (doc: JsonRecord): JsonRecord[] => (doc.flow as JsonRecord).steps as JsonRecord[];
const step = (doc: JsonRecord, id: string): JsonRecord =>
  steps(doc).find((s) => s.id === id) as JsonRecord;

/**
 * Recompute an artifact's content address after an edit, and re-point the approval at it.
 *
 * The approval is re-pointed rather than dropped because the fixtures link in `replay` mode: an
 * approval over a stale digest is check 27's finding, and it would mask every other check.
 */
function resealArtifact(doc: JsonRecord): JsonRecord {
  const { digest: _stale, ...rest } = doc;
  void _stale;
  const digest = artifactDigestOf(rest);
  const lifecycle = rest.lifecycle as JsonRecord | undefined;
  const approval = lifecycle?.approval as JsonRecord | null | undefined;
  if (approval !== null && approval !== undefined) approval.over = digest;
  return { ...rest, digest };
}

function artifactWith(mutate: (doc: JsonRecord) => void): JsonRecord {
  const doc = clone(memberLookupArtifact) as unknown as JsonRecord;
  mutate(doc);
  return resealArtifact(doc);
}

function overlayWith(mutate: (doc: JsonRecord) => void): JsonRecord {
  const doc = clone(summitOverlay) as unknown as JsonRecord;
  mutate(doc);
  const { digest: _stale, ...rest } = doc;
  void _stale;
  return { ...rest, digest: overlayDigestOf(rest) };
}

/**
 * A contract edit, with the artifact and the caller re-pinned to it.
 *
 * Editing a contract on its own changes its digest, so the artifact's `implements` and the caller's
 * pin both go stale and checks 3 and 4 fire alongside whatever the edit was aimed at. Re-pinning is
 * what an author would do, and it is what puts the fixture in front of the check it is testing.
 */
function withContract(mutate: (doc: JsonRecord) => void): Partial<LinkRequest> {
  const doc = clone(memberLookupContract) as unknown as JsonRecord;
  mutate(doc);
  const { digest: _stale, ...rest } = doc;
  void _stale;
  const contract: JsonRecord = { ...rest, digest: contractDigestOf(rest) };
  const artifact = artifactWith((a) => {
    (a.implements as JsonRecord).contractDigest = contract.digest;
    (a.implements as JsonRecord).version = contract.version;
  });
  return {
    contract,
    artifact,
    invocation: {
      name: contract.name as string,
      version: contract.version as string,
      contractDigest: contract.digest as string,
    },
  };
}

const checksOf = (result: LinkResult): readonly number[] =>
  result.ok ? [] : [...new Set(result.errors.map((e) => e.check))];

/** The failure, with the linker's own messages attached, so a broken assertion says WHY. */
function explain(result: LinkResult): string {
  return result.ok
    ? "linked with no errors"
    : result.errors.map((e) => `${e.check}/${e.code}: ${e.message}`).join("\n");
}

function expectRefusedBy(result: LinkResult, check: number): void {
  expect(result.ok, explain(result)).toBe(false);
  expect(checksOf(result), explain(result)).toContain(check);
}

function expectLinked(result: LinkResult): void {
  expect(result.ok ? null : explain(result)).toBeNull();
}

// ---------------------------------------------------------------------------------------------
// One test per check
// ---------------------------------------------------------------------------------------------

describe("the linker performs SPEC section 10's twenty-eight checks", () => {
  it("1: refuses a schema version this engine does not run, rather than ignoring it", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            d.schemaVersion = "capability.artifact/v2";
          }),
        }),
      ),
      1,
    );
    expectLinked(link(request()));
  });

  it("2: refuses an approved artifact that was edited after it was sealed", () => {
    // Deliberately NOT resealed - the edit is the point, and the digest is what notices it.
    const edited = clone(memberLookupArtifact) as unknown as JsonRecord;
    (step(edited, "submit-search").settle as JsonRecord).maxWaitMs = 30_000;
    expectRefusedBy(link(request({ artifact: edited })), 2);

    // The same edit, sealed by whoever made it: an artifact is allowed to change, it is not allowed
    // to change silently.
    expectLinked(link(request({ artifact: resealArtifact(edited) })));
  });

  it("3: refuses an artifact recorded against a different contract document", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (d.implements as JsonRecord).contractDigest = `sha256:${"1".repeat(64)}`;
          }),
        }),
      ),
      3,
    );
    expectLinked(link(request()));
  });

  it("4: refuses a caller whose generated types were built from an older contract", () => {
    const stale = link(
      request({ invocation: { ...pin, contractDigest: `sha256:${"2".repeat(64)}` } }),
    );
    expectRefusedBy(stale, 4);
    // The one failure class that tells the caller to regenerate rather than to retry.
    expect(stale.ok ? null : stale.failure).toBe("contract-stale");
    expectLinked(link(request()));
  });

  it("5: refuses a value read from a step that does not run strictly earlier", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "enter-member-id").instruction as JsonRecord).value = {
              from: "output",
              step: "read-savings-balance",
              output: "memberName",
            };
          }),
        }),
      ),
      5,
    );
    // And a parameter nothing declares.
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "enter-member-id").instruction as JsonRecord).value = {
              from: "param",
              param: "socialSecurityNumber",
            };
          }),
        }),
      ),
      5,
    );
    expectLinked(link(request()));
  });

  it("6: refuses one output written by two steps, and a step reading an outcome's own capture", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const read = step(d, "read-savings-balance").extract as JsonRecord[];
            (step(d, "submit-search").extract as JsonRecord[]).push(clone(read[1] as JsonRecord));
          }),
        }),
      ),
      6,
    );

    // An outcome's bindings live in a terminal namespace: the run ENDED there, so nothing downstream
    // can have read them.
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "read-savings-balance").precondition as JsonRecord) = {
              kind: "value-matches",
              where: { role: "status" },
              matcher: {
                mode: "exact",
                value: "x",
                normalize: "std.text@1",
              },
            };
            const extract = step(d, "read-savings-balance").extract as JsonRecord[];
            (extract[0] as JsonRecord).where = {
              cell: {
                table: {
                  path: [
                    {
                      kind: "frame",
                      name: { mode: "exact", value: "content", normalize: "std.text@1" },
                    },
                  ],
                },
                rowKey: {
                  columnHeader: { mode: "token", token: "member-column", normalize: "std.label@1" },
                  value: { from: "output", step: "open-member-row", output: "restrictionCode" },
                },
                columnHeader: { mode: "token", token: "balance-column", normalize: "std.label@1" },
              },
            };
          }),
        }),
      ),
      6,
    );
    expectLinked(link(request()));
  });

  it("7: refuses a contract output no step produces", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "read-savings-balance").extract as JsonRecord[]).splice(0, 1);
          }),
        }),
      ),
      7,
    );
    // And an output whose parser yields a different type than the contract promised.
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const extract = step(d, "read-savings-balance").extract as JsonRecord[];
            (extract[1] as JsonRecord).parse = "integer@1";
          }),
        }),
      ),
      7,
    );
    expectLinked(link(request()));
  });

  it("8: refuses an undeclared outcome code, and a declared outcome no step can detect", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "submit-search").outcomes as JsonRecord[])[0]!.code = "MEMBER_ASLEEP";
          }),
        }),
      ),
      8,
    );

    // The Q2 mitigation. Per-step scoping catches "detected where it is impossible"; this catches
    // its cost - a scoping mistake that silently disabled a detector, leaving the caller promised an
    // answer this program can never give.
    const unreachable = link(
      request({
        artifact: artifactWith((d) => {
          (step(d, "open-member-row").outcomes as JsonRecord[]).length = 0;
        }),
      }),
    );
    expectRefusedBy(unreachable, 8);
    expect(explain(unreachable)).toContain("MEMBER_RESTRICTED");
    expectLinked(link(request()));
  });

  it("9: refuses a priority tie an overlay introduced into a step's own declared set", () => {
    const collision = overlayWith((d) => {
      const added = (d.addRecoveries as JsonRecord)["submit-search"] as JsonRecord[];
      // The base step already declares DISMISS_KEEPALIVE_DIALOG at priority 10.
      (added[0] as JsonRecord).priority = 10;
    });
    expectRefusedBy(link(request({ overlay: collision })), 9);
    expectLinked(link(request()));
  });

  it("10: refuses a matcher carrying a stylesheet selector instead of a name a person reads", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const target = step(d, "submit-search").target as JsonRecord;
            (target.descriptors as JsonRecord[])[0]!.name = {
              mode: "exact",
              value: "#ctl00_g_9a1 > td:nth-child(3) a",
              normalize: "std.text@1",
            };
          }),
        }),
      ),
      10,
    );
    // A tenant's own vocabulary is matcher text too, and the overlay is where a real locator is most
    // likely to be pasted in.
    expectRefusedBy(
      link(
        request({
          overlay: overlayWith((d) => {
            (d.vocabulary as JsonRecord)["search-button"] = ["table.grid input#q"];
          }),
        }),
      ),
      10,
    );
    expectLinked(link(request()));
  });

  it("11: refuses a target the overlay left with too little independent evidence", () => {
    // SPEC section 9.2's own example: a link error at load with a clear message, rather than a
    // target-underdetermined at step six in production.
    const overDisabled = overlayWith((d) => {
      (d.steps as JsonRecord)["submit-search"] = {
        disableDescriptors: ["search-by-name"],
      };
    });
    const refused = link(request({ overlay: overDisabled }));
    expectRefusedBy(refused, 11);
    expect(explain(refused)).toContain("after the overlay merge");

    // And the converse, which matters just as much: a base whose quorum only stands up because one
    // tenant's overlay props it up is a capability that silently does not exist at every other
    // tenant.
    const propped = link(
      request({
        artifact: artifactWith((d) => {
          const target = step(d, "submit-search").target as JsonRecord;
          (target.descriptors as JsonRecord[]).splice(1, 1);
        }),
      }),
    );
    expectRefusedBy(propped, 11);
    expect(explain(propped)).toContain("as stored");
    expectLinked(link(request()));
  });

  it("12: refuses a geometric descriptor anchored to another geometric descriptor", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const target = step(d, "submit-search").target as JsonRecord;
            const geometric = (target.descriptors as JsonRecord[])[1] as JsonRecord;
            geometric.anchor = clone(geometric);
          }),
        }),
      ),
      12,
    );
    expectLinked(link(request()));
  });

  it("13: recomputes the effect summary rather than believing the document's copy", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (d.effects as JsonRecord).maxEffect = "WRITE_REVERSIBLE";
          }),
        }),
      ),
      13,
    );
    // The contract's own claim is re-derived from the steps too, so a hand-edited contract cannot
    // say an irreversible capability needs no approval.
    expectRefusedBy(
      link(
        request(
          withContract((d) => {
            d.effect = "WRITE_IRREVERSIBLE";
            d.requiresApproval = true;
          }),
        ),
      ),
      13,
    );
    expectLinked(link(request()));
  });

  it("14: refuses a detector written with the member number in it", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "submit-search").outcomes as JsonRecord[])[0]!.detect = {
              kind: "text-present",
              text: {
                mode: "contains",
                value: "No member found for 400123456",
                normalize: "std.text@1",
              },
            };
          }),
        }),
      ),
      14,
    );
    expectLinked(link(request()));
  });

  it("15: refuses a budget that cannot cover the program's own declared recoveries", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (d.budgets as JsonRecord).maxActions = 2;
          }),
        }),
      ),
      15,
    );
    // A program that declares recoveries and budgets none of them could never apply one.
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (d.budgets as JsonRecord).maxTotalRemediations = 0;
          }),
        }),
      ),
      15,
    );
    expectLinked(link(request()));
  });

  it("16: refuses a remedy that is really a flow", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const ambient = (d.flow as JsonRecord).ambient as JsonRecord[];
            (ambient[1] as JsonRecord).afterRemedy = "advance";
          }),
        }),
      ),
      16,
    );
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const ambient = (d.flow as JsonRecord).ambient as JsonRecord[];
            const remedy = (ambient[1] as JsonRecord).remedy as JsonRecord;
            const one = (remedy.instructions as JsonRecord[])[0] as JsonRecord;
            remedy.instructions = [one, one, one, one, one];
          }),
        }),
      ),
      16,
    );
    expectLinked(link(request()));
  });

  it("17: refuses a program this surface cannot run, at LOAD time", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (d.target as JsonRecord).requires = ["accessibility-tree", "character-grid"];
          }),
        }),
      ),
      17,
    );

    // The message a driver's own advertisement produces: "this program needs a descriptor kind this
    // surface cannot resolve", said before a browser is launched rather than at step six.
    const noTables: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      resolvableDescriptors: MOCK_SURFACE_CAPABILITIES.resolvableDescriptors.filter(
        (k) => k !== "table-cell",
      ),
    };
    const refused = link(request({ capabilities: noTables }));
    expectRefusedBy(refused, 17);
    expect(explain(refused)).toContain("table-cell");
    expectLinked(link(request()));
  });

  it("18: refuses a predicate past its depth ceiling, and an unregistered function id", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "open-search").expect as JsonRecord).predicate = {
              all: [{ any: [{ not: { all: [{ any: [{ kind: "settled" }] }] } }] }],
            };
          }),
        }),
      ),
      18,
    );
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const extract = step(d, "read-savings-balance").extract as JsonRecord[];
            (extract[0] as JsonRecord).normalize = "std.text@2";
          }),
        }),
      ),
      18,
    );
    // Exactly at the ceiling, which pins the boundary rather than assuming it: `all[any[not[leaf]]]`
    // is the deepest shape anyone has needed to write, and it must still link.
    expectLinked(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "open-search").expect as JsonRecord).predicate = {
              all: [{ any: [{ not: { kind: "settled" } }] }],
            };
          }),
        }),
      ),
    );
    expectLinked(link(request()));
  });

  it("19: refuses a restart from a step nobody declared safe to re-enter", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const recovery = (step(d, "submit-search").recoveries as JsonRecord[])[0] as JsonRecord;
            recovery.resume = "restart-from-checkpoint";
            recovery.resumeAt = "enter-member-id";
          }),
        }),
      ),
      19,
    );
    expectLinked(link(request()));
  });

  it("20: refuses an overlay that would change what the capability means", () => {
    expectRefusedBy(
      link(
        request({
          overlay: overlayWith((d) => {
            (d.steps as JsonRecord)["submit-search"] = { effect: "WRITE_IRREVERSIBLE" };
          }),
        }),
      ),
      20,
    );
    // And one that patches an id the base artifact does not have, which is how a rename turns an
    // overlay into a file that silently does nothing.
    expectRefusedBy(
      link(
        request({
          overlay: overlayWith((d) => {
            (d.steps as JsonRecord)["submit-searhc"] = { settle: { maxWaitMs: 20_000 } };
          }),
        }),
      ),
      20,
    );
    expectLinked(link(request()));
  });

  it("21: refuses a program that hardcodes a function key the driver should choose", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            step(d, "submit-search").instruction = { kind: "pressKey", key: "F5" };
          }),
        }),
      ),
      21,
    );
    expectLinked(link(request()));
  });

  it("22: refuses an outcome detector that may fire early or against an unsettled screen", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "submit-search").outcomes as JsonRecord[])[0]!.phase = "pre";
          }),
        }),
      ),
      22,
    );
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "submit-search").outcomes as JsonRecord[])[0]!.requiresSettled = false;
          }),
        }),
      ),
      22,
    );
    expectLinked(link(request()));
  });

  it("23: refuses allowUnsettled outside the environment band", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            (step(d, "submit-search").recoveries as JsonRecord[])[0]!.allowUnsettled = true;
          }),
        }),
      ),
      23,
    );
    expectLinked(link(request()));
  });

  it("24: refuses a table read whose truncation would be silent", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            step(d, "read-savings-balance").instruction = { kind: "readTable" };
          }),
        }),
      ),
      24,
    );
    expectLinked(link(request()));
  });

  it("25: refuses a step written with no postcondition", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const s = step(d, "submit-search");
            s.expect = undefined;
          }),
        }),
      ),
      25,
    );
    expectLinked(link(request()));
  });

  it("26: refuses a route the policy or the caller's allowlist does not permit", () => {
    expectRefusedBy(
      link(
        request({
          artifact: artifactWith((d) => {
            const routes = (d.flow as JsonRecord).routes as JsonRecord[];
            (routes[1] as JsonRecord).originAlias = "elsewhere";
          }),
        }),
      ),
      26,
    );
    const narrower: Allowlist = {
      ...allowlist,
      routes: allowlist.routes.filter((r) => !r.pathPattern.endsWith(":memberId")),
    };
    expectRefusedBy(link(request({ allowlist: narrower })), 26);
    expectLinked(link(request()));
  });

  it("27: refuses replay of an artifact that was never approved, or signed by an untrusted key", () => {
    const draft = artifactWith((d) => {
      (d.lifecycle as JsonRecord).status = "draft";
      (d.lifecycle as JsonRecord).approval = null;
    });
    expectRefusedBy(link(request({ artifact: draft })), 27);
    // The same document is fine for the verification replay that decides whether it may BECOME a
    // draft; requiring approval there would make the lifecycle unreachable.
    expectLinked(link(request({ artifact: draft, mode: "verification" })));

    expectRefusedBy(
      link(request({ trust: { trustedKeyIds: ["some-other-key"], verifySignature: () => true } })),
      27,
    );
    expectRefusedBy(
      link(request({ trust: { trustedKeyIds: [TRUSTED_KEY], verifySignature: () => false } })),
      27,
    );
    // An unverifiable approval is not an approval.
    expectRefusedBy(link(request({ trust: null })), 27);
    expectLinked(link(request()));
  });

  it("28: refuses an argument the contract does not accept, at a cost of zero actions", () => {
    const bad = link(request({ args: { memberId: "not-a-number" } }));
    expectRefusedBy(bad, 28);
    expect(bad.ok ? null : bad.failure).toBe("argument-invalid");
    expect(bad.ok ? null : bad.sideEffects).toBe("none-guaranteed");

    expectRefusedBy(link(request({ args: {} })), 28);
    expectRefusedBy(link(request({ args: { ...GOOD_ARGS, memberIdd: "400123" } })), 28);
    // Too short for the declared minimum, which is the cheapest classification there is: it touches
    // nothing.
    expectRefusedBy(link(request({ args: { memberId: "40" } })), 28);
    expectLinked(link(request()));
  });
});

// ---------------------------------------------------------------------------------------------
// The properties the four arms of a pre-flight refusal rest on
// ---------------------------------------------------------------------------------------------

describe("a refusal", () => {
  it("guarantees no side effects, whichever pre-flight class it is", () => {
    const failures = [
      link(
        request({
          artifact: artifactWith((d) => {
            d.schemaVersion = "capability.artifact/v2";
          }),
        }),
      ),
      link(request({ invocation: { ...pin, contractDigest: `sha256:${"3".repeat(64)}` } })),
      link(request({ args: { memberId: "nope" } })),
      link(
        request({
          artifact: artifactWith((d) => {
            (d.budgets as JsonRecord).maxActions = 1;
          }),
        }),
      ),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.sideEffects).toBe("none-guaranteed");
      expect(PRE_FLIGHT_FAILURES.has(result.failure)).toBe(true);
    }
  });

  it("reserves argument-invalid for a call that is the only thing wrong", () => {
    // Telling an agent "retry with a different member number" when the artifact is broken sends it
    // into a loop it can never exit.
    const both = link(
      request({
        args: { memberId: "nope" },
        artifact: artifactWith((d) => {
          (d.budgets as JsonRecord).maxActions = 1;
        }),
      }),
    );
    expect(both.ok ? null : both.failure).toBe("link-error");
  });

  it("names every check it fired, in spec order, so a report diffs against the spec", () => {
    const result = link(
      request({
        artifact: artifactWith((d) => {
          (d.effects as JsonRecord).maxEffect = "WRITE_REVERSIBLE";
          (step(d, "submit-search").outcomes as JsonRecord[])[0]!.phase = "pre";
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(checksOf(result)).toEqual([13, 22]);
    for (const error of result.errors) {
      expect(error.check).toBeGreaterThanOrEqual(1);
      expect(error.check).toBeLessThanOrEqual(LINK_CHECK_COUNT);
      expect(error.code).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("is a refusal and never an exception, whatever it is handed", () => {
    // A pre-flight gate that throws is the one failure a caller cannot see, cannot classify and
    // cannot report honestly - and `invoke` never rejects.
    const garbage: unknown[] = [
      null,
      42,
      "an artifact",
      {},
      { schemaVersion: "capability.artifact/v1" },
      { schemaVersion: "capability.artifact/v1", flow: { steps: [{ all: "oops" }] } },
    ];
    for (const contract of garbage) {
      for (const artifact of garbage) {
        const result = link({
          contract,
          artifact,
          overlay: artifact,
          capabilities: MOCK_SURFACE_CAPABILITIES,
          args: { memberId: 7 },
          mode: "replay",
        });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to check 1 when the schema refuses something no numbered check names", () => {
    // The backstop exists so that "unknown constructs are refused, never ignored" is true even for a
    // construct nobody thought to number.
    const result = link(
      request({
        artifact: artifactWith((d) => {
          step(d, "submit-search").sideChannel = { doSomethingClever: true };
        }),
      }),
    );
    expectRefusedBy(result, 1);
    expect(explain(result)).toContain("sideChannel");
  });
});

// ---------------------------------------------------------------------------------------------
// The shared corpus, linked
// ---------------------------------------------------------------------------------------------

describe("SPEC section 10's rejection corpus", () => {
  it("covers every numbered check", () => {
    const covered = [...new Set(SPEC_10_REJECTIONS.map((c) => c.check))].sort((a, b) => a - b);
    expect(covered).toEqual(Array.from({ length: LINK_CHECK_COUNT }, (_, i) => i + 1));
  });

  for (const rejection of SPEC_10_REJECTIONS) {
    it(`is refused by the linker: ${rejection.check}: ${rejection.what}`, () => {
      const doc = buildRejection(rejection);
      const result = link(
        request({
          contract: rejection.document === "contract" ? doc : memberLookupContract,
          artifact: rejection.document === "artifact" ? doc : memberLookupArtifact,
          overlay: rejection.document === "overlay" ? doc : summitOverlay,
        }),
      );
      expect(result.ok, explain(result)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// What the interpreter is handed when the link succeeds
// ---------------------------------------------------------------------------------------------

describe("a linked program", () => {
  const linked = link(request());
  if (!linked.ok) throw new Error(explain(linked));
  const program = linked.program;

  it("hands the classifier post-overlay facts as plain data", () => {
    // The classifier takes a value you can write to disk and load back. An artifact plus an overlay
    // plus a contract is three documents and a merge; the linker does the merge once.
    expect(program.facts.vocabulary["search-button"]).toEqual(["Find"]);
    expect(program.facts.vocabulary["member-column"]).toEqual(["Member ID"]);
    expect(program.facts.brandingTokens).toEqual(["Summit", "Summit Credit Union"]);
    expect(program.facts.routes.map((r) => r.path)).toEqual([
      "/cb/members/search",
      "/cb/members/:memberId",
    ]);
    expect(program.facts.maxEffect).toBe("READ");
    expect(program.facts.restartSafeUpToPc).toBe(5);
    expect(program.facts.resumePoints).toEqual(["open-search"]);
  });

  it("declares the type of every output a detector or an extraction can write", () => {
    // Contract outputs and outcome payload fields alike: the same extractor reads both, and
    // `enum@1` has to be able to refuse a value the caller's generated types could not hold.
    expect(Object.keys(program.facts.outputs).sort()).toEqual([
      "accountStatus",
      "memberName",
      "restrictionCode",
      "savingsBalance",
    ]);
    expect(program.facts.outputs.savingsBalance?.sensitivity).toBe("internal");
  });

  it("binds the caller's arguments and mints a handle for every sensitive one", () => {
    expect(program.bindings).toEqual([
      {
        name: "memberId",
        origin: "param",
        value: "400123",
        sensitivity: "sensitive",
        handle: "taint:memberId-1",
      },
    ]);
  });

  it("resolves each step's index, and the route a navigate would land on", () => {
    expect(program.steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(program.steps[0]?.route).toEqual({
      originAlias: "corebank",
      path: "/cb/members/search",
    });
    // The interpreter fills in where a non-navigate action actually landed; the linker does not
    // guess it.
    expect(program.steps[2]?.route).toBeNull();
  });

  it("records which descriptors the overlay took out of the quorum", () => {
    const disabled = link(
      request({
        overlay: overlayWith((d) => {
          (d.steps as JsonRecord)["open-member-row"] = {
            disableDescriptors: ["select-right-of-member-cell"],
            addDescriptors: [
              {
                id: "summit-select-by-name",
                kind: "role-name",
                evidenceSource: "accessibleName",
                role: "link",
                name: { mode: "token", token: "select-link", normalize: "std.label@1" },
              },
            ],
          };
        }),
      }),
    );
    expect(disabled.ok, explain(disabled)).toBe(true);
    if (!disabled.ok) return;
    // Recorded rather than elided: an overlay silently removing evidence is exactly what the
    // fingerprint exists to make visible.
    expect(disabled.program.disabledDescriptors).toEqual([
      { stepId: "open-member-row", descriptorId: "select-right-of-member-cell" },
    ]);
  });

  it("addresses the bytes that actually ran, not the base artifact's", () => {
    const base = link(request({ overlay: null }));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(program.effectiveDigest).not.toBe(program.artifact.digest);
    expect(program.effectiveDigest).not.toBe(base.program.effectiveDigest);
    expect(program.originBindings).toEqual({ corebank: "https://summit-cb.example.invalid" });
    expect(base.program.originBindings).toEqual({});
  });

  it("derives what a surface can offer from what it advertises it can do", () => {
    // A driver that simply asserted `geometry` while advertising no bounds unit would be believed,
    // and the whole point of check 17 is to catch that before a browser is launched.
    expect([...surfaceFeaturesOf(MOCK_SURFACE_CAPABILITIES)].sort()).toEqual([
      "accessibility-tree",
      "containers",
      "geometry",
      "native-dialog-channel",
      "route",
      "table-position",
    ]);
    const noGeometry: SurfaceCapabilities = { ...MOCK_SURFACE_CAPABILITIES, boundsUnit: null };
    expect(surfaceFeaturesOf(noGeometry)).not.toContain("geometry");
    const grid: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      kind: "terminal",
      boundsUnit: "cell",
    };
    expect(surfaceFeaturesOf(grid)).toContain("character-grid");
    expect(surfaceFeaturesOf(grid)).not.toContain("accessibility-tree");
  });
});
