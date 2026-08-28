// BUILD UNIT 19: the SECOND TENANT, as a per-tenant overlay over the artifact recorded at the first.
//
// `sharePositionArtifact` in `corebank.ts` was recorded against riverbend. Nothing in it mentions
// summit, and after this unit nothing in it may: the base holds riverbend's words, this file holds
// summit's, and the merge is `@crr/core`'s `mergeOverlay` re-checked by all 28 linker checks.
//
// WHAT IS IN HERE, AND WHY EACH THING IS ALLOWED TO BE:
//
//   · `originAliases`   - where the tenant's instance actually lives. The one place in the whole
//                         schema where a host is legitimate.
//   · `routeBasePath`   - summit mounts the same product at `/cb`. A PREFIX, never the template:
//                         the overlay cannot retarget where a `navigate` goes.
//   · `vocabulary`      - twelve renamed labels. THE HINGE. Each token is replaced WHOLESALE, so
//                         summit's matchers are exactly as narrow as summit's screens.
//   · `stripTokens`     - the tenant's branding, removed by the label normalizer before comparison,
//                         so "Summit Community Bank" never has to be known to the shared registry.
//   · `steps[].settle`  - wait budgets, field-wise. Summit's instance sits behind a slower reverse
//                         proxy in this deployment; a settle ceiling is a per-tenant operational
//                         fact and says nothing about what the program means.
//
// WHAT IS NOT IN HERE, AND COULD NOT BE. No step, no instruction, no checkpoint, no detector, no
// outcome, no effect class. The overlay TYPE has no slot for any of them (`overlay.ts` is a
// `strictObject`), the merge refuses any field it does not recognise, and linker check 20 compares
// the semantic spine of every merged step against the base. Three independent refusals for one
// rule, because this is the document that gets reviewed to a config file's standard.
//
// NINE TOKENS ARE NOT REPLACED and that is the interesting half. `open-row-link` ("Open"),
// `subaccount-number-column` ("Acct"), `subaccount-opened-column` ("Opened"),
// `member-detail-heading`, and the five framework-printed banner/dialog tokens are byte-identical
// at both tenants. SPEC section 9.4 makes the point with `button:exit` on the green screen: some
// per-tenant differences need no overlay at all, and a fixture where everything differed would hide
// that.
//
// ALL DATA IS SYNTHETIC and no host here is real; the origin is the ephemeral loopback port the
// fixture server bound this process.

import { type Allowlist, type CapabilityOverlay, sealOverlay } from "@crr/core";

/** The tenant, as the catalog and the journal name it. */
export const SUMMIT_TENANT = {
  tenantId: "summit",
  appInstanceId: "summit-corebank-fixture",
} as const;

export const RIVERBEND_TENANT = {
  tenantId: "riverbend",
  appInstanceId: "riverbend-corebank-fixture",
} as const;

/** Summit's mount point under the fixture's single origin. Riverbend's is `""`. */
export const SUMMIT_BASE_PATH = "/cb";

/**
 * The twelve renamed labels, and this is the whole multi-tenant answer.
 *
 * Every one of these tokens is referenced from several places in the base artifact at once - a
 * descriptor, a container matcher, a row key, a checkpoint predicate and, for the three column
 * tokens, a table read. Replacing the token reaches all of them. The rejected alternative (SPEC
 * section 9.3) is adding summit's wording as an extra `oneOf` on each matcher, which has to be
 * done at every site separately AND permanently widens the base, so discrimination degrades
 * monotonically as tenants are added.
 */
const SUMMIT_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  "member-id-label": ["Member Number"],
  "search-button": ["Find"],
  "member-column": ["Member Number"],
  "name-column": ["Member Name"],
  // Read by the results grid's balance column AND by the share-account grid's, at both tenants.
  // One line here fixes both reads.
  "balance-column": ["Savings Balance"],
  "status-column": ["Acct Status"],
  "action-column": ["Select"],
  "subaccount-list-heading": ["Savings Accounts"],
  "subaccount-product-column": ["Savings Account"],
  "open-subaccount-button": ["Add Sub-Account"],
  "subaccount-type-label": ["Account Type"],
  "initial-deposit-label": ["Opening Deposit"],
};

/**
 * Everything about summit that is NOT a word: where the instance is, where the product is mounted,
 * and how long two of its screens are given to settle.
 *
 * Split out from the vocabulary so the acceptance test can run the two halves independently. That
 * is not a testing convenience - it is the only way the green run at summit means anything. A run
 * with NEITHER half would navigate to riverbend's paths and pass for the wrong reason; a run with
 * the routing half and no words is pointed squarely at summit and must fail, and the fact that it
 * fails at the first LABEL-ANCHORED target is what identifies the vocabulary as the load-bearing
 * part rather than the mount path.
 */
function summitRouting(origin: string): Record<string, unknown> {
  return {
    schemaVersion: "capability.overlay/v1",
    appliesTo: {
      artifactId: "corebank-member-share-position-web",
      // Open-ended `max`: a vocabulary override is not invalidated by the recorder emitting a new
      // artifact version, and pinning one would mean editing every tenant file on every re-record.
      // The linker still refuses a merge whose result does not link.
      version: { min: 1 },
    },
    tenantId: SUMMIT_TENANT.tenantId,
    appInstanceId: SUMMIT_TENANT.appInstanceId,

    originAliases: { corebank: origin },

    // The same vendor product, mounted at `/cb`. Applied to every route the program declares,
    // because a half-prefixed program navigates to a 404 that then classifies as an app error.
    routeBasePath: {
      "member-search": SUMMIT_BASE_PATH,
      "member-results": SUMMIT_BASE_PATH,
      "member-detail": SUMMIT_BASE_PATH,
      "subaccount-new": SUMMIT_BASE_PATH,
    },

    // WAIT BUDGETS. Non-semantic and per-tenant by nature: this instance sits behind a slower
    // reverse proxy than riverbend's, and the two steps that cross a WebForms postback are where
    // that shows up. Field-wise, so `stableSamples` and `pollIntervalMs` keep the base's values and
    // only the ceiling moves. A budget override cannot make a step pass that would otherwise fail a
    // checkpoint - it can only buy the surface more time to settle before the checkpoint is read.
    steps: {
      "submit-search": { settle: { maxWaitMs: 15_000 } },
      "open-member-record": { settle: { maxWaitMs: 15_000 } },
    },
  };
}

/**
 * The overlay, bound to a live origin.
 *
 * A function of the origin rather than a constant because the fixture binds an ephemeral port, and
 * the overlay's digest has to cover the origin it actually names - sealing a placeholder and then
 * mutating it would produce a document whose `effectiveDigest` describes bytes that never ran,
 * which is the one thing SPEC section 9.2 says the effective digest exists to prevent.
 */
export function summitOverlay(origin: string): CapabilityOverlay {
  return sealOverlay({
    ...summitRouting(origin),
    vocabulary: SUMMIT_VOCABULARY,
    // The tenant's own name, removed by `std.label@1` before any comparison. Both spellings,
    // longest first, because the normalizer removes a RUN of words and the short one would
    // otherwise leave "Community Bank" behind on a heading that carried the full name.
    stripTokens: ["Summit Community Bank", "Summit"],
  });
}

/** The negative control. See `summitRouting` for why it exists and what it is worth. */
export function summitRoutingOnlyOverlay(origin: string): CapabilityOverlay {
  return sealOverlay(summitRouting(origin));
}

/**
 * Summit's deployment allowlist.
 *
 * Separate from riverbend's because an allowlist is DEPLOYMENT policy, not part of the capability:
 * it says which routes this automation may touch at this app instance, and summit's instance serves
 * the product under `/cb`. Note what did not change - the origin ALIAS, the action kinds and the
 * effect ceiling are the capability's, identical at every tenant. Only the paths moved, and they
 * moved by exactly the prefix the overlay declares, which is the property `linkSummit` asserts.
 */
export const summitAllowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/cb/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/cb/search/results", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/cb/member/:memberId", maxEffect: "READ" },
    {
      originAlias: "corebank",
      pathPattern: "/cb/member/:memberId/subaccount/new",
      maxEffect: "READ",
    },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/**
 * The four screens both tenants serve, paired by NAME rather than by route.
 *
 * Paired by name on purpose: summit's routes carry a `/cb` prefix, so a pairing keyed on the route
 * would find nothing in common and report 100% divergence - which would be a measurement of the
 * mount point rather than of the product. The screens are the same screens; that is the premise the
 * whole overlay argument rests on, and it is stated here where a reader can disagree with it.
 */
export const CROSS_TENANT_SCREENS: readonly { readonly screen: string; readonly path: string }[] = [
  { screen: "member-search", path: "/search" },
  { screen: "member-results", path: "/search/results?memberId=10041" },
  { screen: "member-detail", path: "/member/10041" },
  { screen: "subaccount-new", path: "/member/10041/subaccount/new" },
];
