// BUILD UNIT 19, the half that needs no browser: what the MERGE produces, and what it refuses.
//
// `browser-overlay.test.ts` proves the merged program runs at the second tenant. This file proves
// the things a running program cannot show you: that the overlay changed only what it is allowed to
// change, that the base artifact's bytes are untouched, that the linker re-runs all 29 checks over
// the merged document, and that four specific abuses are refused. Hermetic - no browser, no socket,
// no clock, no credential - so it runs on a machine with no Chromium and still holds the design up.
//
// The rule under test is one sentence, and it is the reason a per-tenant file can be reviewed to a
// config file's standard: AN OVERLAY MAY NOT CHANGE WHAT A CAPABILITY MEANS.

import {
  MOCK_SURFACE_CAPABILITIES,
  type RoutePattern,
  link,
  mergeOverlay,
  sealArtifact,
  sealOverlay,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { ed25519Trust } from "../src/approval.js";
import { SUMMIT_BASE_PATH, summitAllowlist, summitOverlay } from "./fixtures/corebank-summit.js";
import {
  APPROVER_KEY_ID,
  FIXTURE_MEMBER_ID,
  approverPublicKey,
  corebankAllowlist,
  sharePositionArtifact,
  sharePositionContract,
  sharePositionDraft,
} from "./fixtures/corebank.js";

/** A host this test never contacts. The linker does not resolve an origin; it only checks that the
 *  overlay bound one the artifact declares. */
const ORIGIN = "https://summit-cb.example.invalid";

const TRUST = () => ed25519Trust([{ keyId: APPROVER_KEY_ID, publicKey: approverPublicKey }]);

const linkWith = (overlay: unknown, allowlist = summitAllowlist) =>
  link({
    contract: sharePositionContract,
    artifact: sharePositionArtifact,
    overlay,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: FIXTURE_MEMBER_ID },
    mode: "replay",
    allowlist,
    trust: TRUST(),
  });

const explain = (result: ReturnType<typeof link>): string =>
  result.ok ? "linked" : JSON.stringify(result.errors, null, 2);

describe("the summit overlay merges, and the merged program links", () => {
  it("links under all 29 checks, over the merged document rather than the base", () => {
    const result = linkWith(summitOverlay(ORIGIN));
    expect(result.ok ? null : explain(result)).toBeNull();
  });

  it("leaves the BASE artifact byte-identical, and moves only the effective digest", () => {
    const withOverlay = linkWith(summitOverlay(ORIGIN));
    const without = linkWith(null, corebankAllowlist);
    expect(withOverlay.ok && without.ok).toBe(true);
    if (!withOverlay.ok || !without.ok) return;

    // The approval signature is over the ARTIFACT's digest, and it is still worth something at a
    // tenant the artifact was never recorded against. That is the property that makes an overlay
    // cheaper than a fork: forking would require a second approval.
    expect(withOverlay.program.artifact.digest).toBe(sharePositionArtifact.digest);
    expect(withOverlay.program.artifact.digest).toBe(without.program.artifact.digest);

    // `effectiveDigest = f(artifactDigest, overlayDigest, linkerVersion)`. Base (+) overlay means
    // the base digest alone cannot answer "which bytes actually ran", and in a regulated
    // environment that question has to be answerable after the fact.
    expect(withOverlay.program.effectiveDigest).not.toBe(without.program.effectiveDigest);
    expect(withOverlay.program.overlay?.digest).toBe(summitOverlay(ORIGIN).digest);
  });

  it("is deterministic: the same two documents merge to the same digest twice", () => {
    expect(summitOverlay(ORIGIN).digest).toBe(summitOverlay(ORIGIN).digest);
    const a = linkWith(summitOverlay(ORIGIN));
    const b = linkWith(summitOverlay(ORIGIN));
    expect(a.ok && b.ok && a.program.effectiveDigest === b.program.effectiveDigest).toBe(true);
  });

  it("prefixes every route with the tenant's mount point and changes nothing else about them", () => {
    const merged = mergeOverlay(sharePositionArtifact, summitOverlay(ORIGIN));
    expect(merged.problems).toEqual([]);
    const routes = (merged.document.flow as { routes: readonly RoutePattern[] }).routes;
    const base = sharePositionArtifact.flow.routes;

    expect(routes.map((r) => r.path)).toEqual([
      "/cb/search",
      "/cb/search/results",
      "/cb/member/:memberId",
      "/cb/member/:memberId/subaccount/new",
    ]);
    // The TEMPLATE is intact: `:memberId` is still a placeholder, not a value, so route
    // canonicalization still removes the member number from anything persisted.
    for (const [i, route] of routes.entries()) {
      const original = base[i] as RoutePattern;
      expect(route.id).toBe(original.id);
      expect(route.originAlias).toBe(original.originAlias);
      expect(route.frame).toBe(original.frame);
      expect(route.path).toBe(`${SUMMIT_BASE_PATH}${original.path}`);
    }
  });

  it("replaces a token's synonyms WHOLESALE, and leaves the tokens it does not name alone", () => {
    const merged = mergeOverlay(sharePositionArtifact, summitOverlay(ORIGIN));
    const vocabulary = (merged.document.flow as { vocabulary: Record<string, string[]> })
      .vocabulary;

    // Wholesale, not union. Riverbend's "Member ID" is GONE from summit's program, which is the
    // whole of SPEC section 9.3's argument: a union would leave the matcher able to resolve a field
    // labelled "Member ID" on a screen where the field this step wants is labelled "Member Number",
    // and it would do so silently.
    expect(vocabulary["member-id-label"]).toEqual(["Member Number"]);
    expect(vocabulary["balance-column"]).toEqual(["Savings Balance"]);
    // Untouched tokens keep the base's list. Twelve of twenty-one are replaced; the other nine are
    // identical at both tenants and are the evidence for SPEC section 9.4's "some per-tenant
    // differences need no overlay at all".
    expect(vocabulary["open-row-link"]).toEqual(["Open"]);
    expect(vocabulary["subaccount-number-column"]).toEqual(["Acct"]);
    expect(vocabulary["notice-dialog"]).toEqual(["System Notice"]);

    const replaced = Object.keys(
      (summitOverlay(ORIGIN).vocabulary ?? {}) as Record<string, unknown>,
    );
    expect(replaced).toHaveLength(12);
    expect(Object.keys(vocabulary)).toHaveLength(21);
  });

  it("overrides a wait budget field-wise, leaving the fields it omits at the base's values", () => {
    const merged = mergeOverlay(sharePositionArtifact, summitOverlay(ORIGIN));
    const steps = (merged.document.flow as { steps: Record<string, unknown>[] }).steps;
    const submit = steps.find((s) => s.id === "submit-search") as {
      settle: { maxWaitMs: number; stableSamples: number; pollIntervalMs: number };
    };
    expect(submit.settle.maxWaitMs).toBe(15_000);
    // Not clobbered. An overlay that replaced the whole settle policy could silently drop
    // `stableSamples` to 1 and turn "settled" into "observed once", which is a semantic change
    // wearing an operational costume.
    expect(submit.settle.stableSamples).toBe(2);
    expect(submit.settle.pollIntervalMs).toBe(120);
  });

  it("carries the tenant's branding words to the normalizer rather than to the registry", () => {
    const result = linkWith(summitOverlay(ORIGIN));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `std.label@1` strips these before comparing, so nothing in the shared registry - which every
    // tenant of every product uses - has to know the name of a credit union.
    expect(result.program.facts.brandingTokens).toEqual(["Summit Community Bank", "Summit"]);
  });
});

describe("the overlay is refused when it would change what the capability MEANS", () => {
  const routing = (patch: Record<string, unknown>): Readonly<Record<string, unknown>> => ({
    ...(summitOverlay(ORIGIN) as unknown as Record<string, unknown>),
    ...patch,
  });

  it("has no slot for a step's instruction: the schema refuses it before anything reads it", () => {
    // Three independent refusals guard this rule and this is the first of them - the type. A
    // per-tenant file that could retarget a step would be a supply-chain hole reviewed to a config
    // file's standard.
    expect(() =>
      sealOverlay(routing({ steps: { "submit-search": { instruction: { kind: "read" } } } })),
    ).toThrow();
  });

  it("has no slot for an outcome, so a tenant cannot invent a business answer for its callers", () => {
    // A caller compiled against `MEMBER_NOT_FOUND` must not receive a third value at one tenant and
    // not at another. A genuinely unique tenant answer is a contract bump for everyone.
    expect(() =>
      sealOverlay(
        routing({
          outcomes: [{ code: "MEMBER_DECEASED", kind: "business_outcome", terminal: true }],
        }),
      ),
    ).toThrow();
  });

  it("refuses to patch a step, a route, a token or an origin alias the artifact does not declare", () => {
    // The second refusal: the ids you patched have to exist. It needs BOTH documents in hand, which
    // is why it is the merge's job rather than the schema's - and it is where a typo in a
    // hand-written tenant file surfaces, at load, with the name that was misspelled.
    const merged = mergeOverlay(
      sharePositionArtifact,
      sealOverlay({
        ...(summitOverlay(ORIGIN) as unknown as Record<string, unknown>),
        originAliases: { corebank: ORIGIN, "core-bank-2": ORIGIN },
        routeBasePath: { "member-serach": "/cb" },
        vocabulary: { "member-id-lable": ["Member Number"] },
        steps: { "submit-serach": { settle: { maxWaitMs: 15_000 } } },
      }),
    );
    expect(merged.problems.map((p) => p.where).sort()).toEqual([
      "originAliases.core-bank-2",
      "routeBasePath.member-serach",
      "steps.submit-serach",
      "vocabulary.member-id-lable",
    ]);
    expect(merged.problems.every((p) => p.code === "overlay-unknown-id")).toBe(true);
  });

  it("refuses a merged program whose routes the tenant's allowlist does not cover", () => {
    // The third refusal: whatever the merge produced still has to pass every check. Summit's
    // program navigates to `/cb/search`, and riverbend's allowlist covers `/search` - so linking
    // the summit program against the wrong deployment's allowlist is a `link-error` in front of the
    // surface rather than a policy denial at step one.
    const result = linkWith(summitOverlay(ORIGIN), corebankAllowlist);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("link-error");
    expect(result.errors.map((e) => e.code)).toContain("route-not-in-allowlist");
  });
});

describe("check 7 covers the surface half of a table read", () => {
  // `ExtractSpec.columnHeaders` maps the CONTRACT's declared column name onto the header this
  // product prints. A key that names no declared column is never consulted, so the read silently
  // falls back to matching the contract's own name - which works at the tenant the artifact was
  // recorded on and fails at the next one. Caught at link, with the name that was misspelled.
  //
  // The DRAFT rather than the approved artifact, and re-sealed after the edit: an artifact edited
  // in place fails check 2 first (the digest notices), and check 2's finding would mask every
  // other check. Verification mode for the same reason - the edited document has no approval and
  // check 27 would fire before check 7 does.
  const withExtractPatch = (patch: Record<string, unknown>, stepId: string): unknown => {
    const document = JSON.parse(JSON.stringify(sharePositionDraft)) as {
      digest?: string;
      flow: { steps: { id: string; extract: Record<string, unknown>[] }[] };
    };
    const step = document.flow.steps.find((s) => s.id === stepId);
    Object.assign((step?.extract ?? [])[0] ?? {}, patch);
    document.digest = undefined;
    return sealArtifact(document as Record<string, unknown>);
  };

  const linkArtifact = (artifact: unknown) =>
    link({
      contract: sharePositionContract,
      artifact,
      capabilities: MOCK_SURFACE_CAPABILITIES,
      args: { memberId: FIXTURE_MEMBER_ID },
      mode: "verification",
      allowlist: corebankAllowlist,
      trust: TRUST(),
    });

  it("refuses a header map naming a column the declared table type does not have", () => {
    const result = linkArtifact(
      withExtractPatch(
        {
          columnHeaders: {
            "Share Ballance": { mode: "token", token: "balance-column", normalize: "std.label@1" },
          },
        },
        "read-share-accounts",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.check)).toContain(7);
    expect(JSON.stringify(result.errors)).toContain("Share Ballance");
  });

  it("refuses a header map on a scalar read, where nothing would ever consult it", () => {
    const result = linkArtifact(
      withExtractPatch(
        {
          columnHeaders: {
            memberName: { mode: "token", token: "name-column", normalize: "std.label@1" },
          },
        },
        "read-member-summary",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.check)).toContain(7);
  });

  it("links the artifact as shipped, which declares one for all four of its columns", () => {
    const result = linkArtifact(sharePositionDraft);
    expect(result.ok ? null : explain(result)).toBeNull();
  });
});
