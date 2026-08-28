// SPEC section 9.2's merge table, one test per row, plus the property the table depends on.
//
// The interesting claim is not any single row. It is that the merge is TOTAL - it always produces a
// program - and that the program it produces is then put back through every linker check. That
// ordering is what turns "an overlay disabled one descriptor too many" from a
// `target-underdetermined` at step six in production into a `link-error` at load with a message
// naming the descriptor. `linker.test.ts` check 11 is the other half of this file.

import { describe, expect, it } from "vitest";
import {
  type JsonObject,
  MOCK_SURFACE_CAPABILITIES,
  link,
  mergeOverlay,
  overlayDigestOf,
  safeParseOverlay,
} from "../src/index.js";
import {
  memberLookupArtifact,
  memberLookupContract,
  summitOverlay,
} from "./fixtures/member-lookup.js";

const clone = <T>(value: T): T => structuredClone(value) as T;

type Doc = { [key: string]: unknown };

function overlayWith(mutate: (doc: Doc) => void): Doc {
  const doc = clone(summitOverlay) as unknown as Doc;
  mutate(doc);
  const { digest: _stale, ...rest } = doc;
  void _stale;
  return { ...rest, digest: overlayDigestOf(rest) };
}

function merge(overlay: unknown = summitOverlay) {
  return mergeOverlay(memberLookupArtifact, overlay);
}

const flowOf = (doc: JsonObject) => doc.flow as JsonObject;
const stepsOf = (doc: JsonObject) => flowOf(doc).steps as JsonObject[];
const stepOf = (doc: JsonObject, id: string) => stepsOf(doc).find((s) => s.id === id) as JsonObject;
const routeOf = (doc: JsonObject, id: string) =>
  (flowOf(doc).routes as JsonObject[]).find((r) => r.id === id) as JsonObject;

const linkWith = (overlay: unknown) =>
  link({
    contract: memberLookupContract,
    artifact: memberLookupArtifact,
    overlay,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: "400123" },
    mode: "verification",
  });

const problems = (overlay: unknown): readonly string[] =>
  merge(overlay).problems.map((p) => `${p.code}: ${p.message}`);

describe("the merge rules of SPEC section 9.2", () => {
  it("replaces an origin alias the overlay names and leaves the rest alone", () => {
    const result = merge();
    expect(result.originBindings).toEqual({ corebank: "https://summit-cb.example.invalid" });
    // An alias the overlay never binds simply stays unbound here; the base artifact is deliberately
    // runnable against the tenant it was recorded on.
    expect(merge(null).originBindings).toEqual({});
  });

  it("prepends a route base path and cannot change the path template", () => {
    const merged = merge().document;
    expect(routeOf(merged, "member-search").path).toBe("/cb/members/search");
    // The parameter placeholder survives: an overlay moves where the app is mounted, never where a
    // navigate goes.
    expect(routeOf(merged, "member-detail").path).toBe("/cb/members/:memberId");
  });

  it("replaces a token's synonyms wholesale and keeps the ones it does not name", () => {
    const vocabulary = flowOf(merge().document).vocabulary as Record<string, readonly string[]>;
    expect(vocabulary["search-button"]).toEqual(["Find"]);
    expect(vocabulary["member-id-field"]).toEqual(["Member #"]);
    // Untouched by this tenant, so the base's list stands.
    expect(vocabulary["not-found-banner"]).toEqual(["No member found", "Member not on file"]);
  });

  it("refuses a token the base flow never declared, which would silently never be consulted", () => {
    expect(
      problems(
        overlayWith((d) => {
          (d.vocabulary as Doc)["serch-button"] = ["Find"];
        }),
      ),
    ).toEqual([
      "overlay-unknown-id: the overlay replaces the synonyms of label token serch-button, which the base flow does not declare",
    ]);
  });

  it("unions the branding words rather than replacing them", () => {
    expect(merge().stripTokens).toEqual(["Summit", "Summit Credit Union"]);
    expect(merge(null).stripTokens).toEqual([]);
  });

  it("appends an added descriptor and never edits a base one", () => {
    const target = stepOf(merge().document, "submit-search").target as JsonObject;
    expect((target.descriptors as JsonObject[]).map((d) => d.id)).toEqual([
      "search-by-name",
      "search-right-of-member-id",
      "summit-search-by-position",
    ]);
    expect(merge().addedDescriptors).toEqual([
      { stepId: "submit-search", descriptorId: "summit-search-by-position" },
    ]);

    // Re-using a base id would be an edit wearing an addition's clothes, and it would make the
    // approval signature over the base digest a signature over something this tenant never runs.
    expect(
      problems(
        overlayWith((d) => {
          const override = (d.steps as Doc)["submit-search"] as Doc;
          (override.addDescriptors as JsonObject[])[0]!.id = "search-by-name";
        }),
      ).join(),
    ).toContain("already declares that id");
  });

  it("removes a disabled descriptor and records that it was disabled", () => {
    const overlay = overlayWith((d) => {
      (d.steps as Doc)["submit-search"] = {
        addDescriptors: [
          {
            id: "summit-search-by-name",
            kind: "role-name",
            evidenceSource: "accessibleName",
            role: "button",
            name: { mode: "token", token: "search-button", normalize: "std.label@1" },
          },
        ],
        disableDescriptors: ["search-by-name"],
      };
    });
    const result = merge(overlay);
    const target = stepOf(result.document, "submit-search").target as JsonObject;
    expect((target.descriptors as JsonObject[]).map((d) => d.id)).toEqual([
      "search-right-of-member-id",
      "summit-search-by-name",
    ]);
    expect(result.disabledDescriptors).toEqual([
      { stepId: "submit-search", descriptorId: "search-by-name" },
    ]);
    expect(linkWith(overlay).ok).toBe(true);
  });

  it("refuses a descriptor id the base target does not declare", () => {
    expect(
      problems(
        overlayWith((d) => {
          (d.steps as Doc)["submit-search"] = { disableDescriptors: ["serch-by-name"] };
        }),
      ).join(),
    ).toContain("which the base target does not declare");
  });

  it("overrides settle and budgets field by field", () => {
    const settle = stepOf(merge().document, "submit-search").settle as JsonObject;
    expect(settle.maxWaitMs).toBe(20_000);
    // A value the overlay omits keeps the base's.
    expect(settle.stableSamples).toBe(2);
    expect(settle.pollIntervalMs).toBe(150);

    const overlay = overlayWith((d) => {
      const override = (d.steps as Doc)["submit-search"] as Doc;
      override.budgets = { maxRemediationCycles: 5 };
    });
    const budgets = stepOf(merge(overlay).document, "submit-search").budgets as JsonObject;
    expect(budgets.maxRemediationCycles).toBe(5);
    expect(budgets.perRecoveryMaxAttempts).toEqual({ DISMISS_KEEPALIVE_DIALOG: 2 });
  });

  it("replaces the header set of a named table, everywhere inside that step", () => {
    // The same grid is named by a descriptor, a row key, a checkpoint predicate and an extraction. A
    // correction that reached only one of them would leave the step half-retargeted, which is worse
    // than not correcting it - because it would still resolve.
    const overlay = overlayWith((d) => {
      (d.steps as Doc)["read-savings-balance"] = {
        tableHeaders: { "share-type-column": ["Share", "Current Bal", "State"] },
      };
    });
    const step = stepOf(merge(overlay).document, "read-savings-balance");
    const headerSets: unknown[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as JsonObject;
      if (record.kind === "table" && Array.isArray(record.headers)) {
        headerSets.push((record.headers as JsonObject[]).map((h) => h.value ?? h.token));
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(step);
    expect(headerSets.length).toBeGreaterThan(1);
    for (const set of headerSets) expect(set).toEqual(["Share", "Current Bal", "State"]);
    expect(linkWith(overlay).ok).toBe(true);
  });

  it("refuses a header correction for a table the step never names", () => {
    expect(
      problems(
        overlayWith((d) => {
          (d.steps as Doc)["read-savings-balance"] = {
            tableHeaders: { "loan-type-column": ["Loan"] },
          };
        }),
      ).join(),
    ).toContain("no container there is named by that header");
  });

  it("appends an added recovery to the step's own declared set", () => {
    const recoveries = stepOf(merge().document, "submit-search").recoveries as JsonObject[];
    expect(recoveries.map((r) => r.name)).toEqual([
      "DISMISS_KEEPALIVE_DIALOG",
      "DISMISS_TERMS_INTERSTITIAL",
    ]);
  });

  it("addresses nothing else at all", () => {
    // The type has no slot for an instruction, an outcome or a checkpoint. The merge ignores a field
    // it does not know, and the linker's check 20 is what turns that silence into a refusal.
    const overlay = overlayWith((d) => {
      (d.steps as Doc)["submit-search"] = {
        instruction: { kind: "navigate", route: "member-search" },
      };
    });
    const step = stepOf(merge(overlay).document, "submit-search");
    expect(step.instruction).toEqual({ kind: "activate" });
    expect(problems(overlay).join()).toContain("never what the step does");
  });
});

describe("the origin an alias is finally bound to", () => {
  // The ONE place in the schema where a host is legitimate, and the only field a per-tenant file
  // uses to say where a session is opened. Build unit 21 widened it from http(s) to four schemes
  // because binding an alias for a green screen otherwise meant writing a fictional `https://` host
  // into a document that will never make an HTTP request. Nothing in the engine parses this string,
  // so the widening is a change to what an author may TRUTHFULLY write and to nothing else.
  const bind = (origin: string) =>
    safeParseOverlay(
      overlayWith((doc) => {
        doc.originAliases = { corebank: origin };
      }),
    );

  it("takes a web origin, which is what every browser tenant needs", () => {
    expect(bind("https://summit-cb.example.invalid").success).toBe(true);
    expect(bind("http://127.0.0.1:8731").success).toBe(true);
  });

  it("takes a telnet or TN3270 authority, which is how a green screen is actually reached", () => {
    expect(bind("telnet://green.riverbend.example.invalid:23").success).toBe(true);
    expect(bind("tn3270://lpar1.summit.example.invalid:992").success).toBe(true);
  });

  it("still refuses a path, so an overlay cannot silently retarget every route in the program", () => {
    expect(bind("https://summit-cb.example.invalid/cb").success).toBe(false);
    expect(bind("telnet://green.example.invalid/session").success).toBe(false);
  });

  it("still refuses a scheme nobody opens a session over, and a bare host", () => {
    expect(bind("ftp://files.example.invalid").success).toBe(false);
    expect(bind("javascript:alert(1)").success).toBe(false);
    expect(bind("summit-cb.example.invalid").success).toBe(false);
  });
});

describe("the merge itself", () => {
  it("is a copy: the base document is never mutated", () => {
    const before = JSON.stringify(memberLookupArtifact);
    merge();
    expect(JSON.stringify(memberLookupArtifact)).toBe(before);
  });

  it("is deterministic, so its output can be hashed", () => {
    expect(JSON.stringify(merge().document)).toBe(JSON.stringify(merge().document));
  });

  it("is the identity when there is no overlay", () => {
    expect(merge(null).document).toEqual(JSON.parse(JSON.stringify(memberLookupArtifact)));
  });

  it("is total: a nonsense overlay produces a program plus problems, never an exception", () => {
    const nonsense = mergeOverlay(memberLookupArtifact, {
      steps: { "no-such-step": { addDescriptors: 7 } },
      addRecoveries: { "also-not-a-step": [] },
      routeBasePath: { nowhere: "/x" },
      originAliases: { unheard: "https://x.example.invalid" },
    });
    expect(stepsOf(nonsense.document)).toHaveLength(5);
    expect(nonsense.problems.map((p) => p.code)).toEqual([
      "overlay-unknown-id",
      "overlay-unknown-id",
      "overlay-unknown-id",
      "overlay-unknown-id",
    ]);
  });

  it("refuses to apply to an artifact it was not written for", () => {
    expect(
      problems(
        overlayWith((d) => {
          (d.appliesTo as Doc).version = { min: 4 };
        }),
      ).join(),
    ).toContain("applies from artifact version 4");
  });
});
