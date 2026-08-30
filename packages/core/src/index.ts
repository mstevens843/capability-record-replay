// `@crr/core` - the pure half.
//
// No clock, no randomness, no I/O, no driver import, and no locator vocabulary. Those are not
// aspirations; they are what two source-scanning contract tests assert about this directory
// (`test/purity.test.ts`, `test/no-locator-vocabulary.test.ts`, SPEC section 1.3), and they are the
// reason the classifier can be exercised from a frozen observation on disk with no browser, no
// fixture and no session. Time, randomness and I/O are passed IN: `PolicyMoment.now`, `Timestamp`,
// `RunId`, `Observation`.
//
// The one dependency is `zod`, because SPEC section 2 makes the schema the single source of truth
// and `z.infer`s the types from it. Adding a second is a design conversation, and `test/purity.ts`
// is where it has to be had.
//
// The order below is the order the pipeline runs in, not alphabetical, because that is the only
// ordering that tells a reader anything: primitives are what documents are made of, documents are
// what the linker reads, and everything after the linker is a step of the replay loop.
//
// `test/barrel.test.ts` asserts that every module in `src/` appears here, that no name arrives by
// two routes (an ambiguous `export *` is silently DROPPED rather than reported), and that every
// value the modules declare is really reachable through this file at runtime.

// -- Primitives: the alphabet. Hashing, canonical JSON, branded ids, the value vocabulary, and the
// -- registry of normalizers/extractors/parsers a document is allowed to name.
// The identity alias that lets a schema constant carry a NAMED interface type, so the .d.ts
// printer emits `StepSchemaType` inside a parent schema instead of re-expanding the whole zod
// tree. That one line is worth 15,146,902 bytes of declarations; the file explains why.
export * from "./schema-identity.js";
export * from "./hash/sha256.js";
export * from "./canonical-json.js";
export * from "./digest.js";
export * from "./primitives.js";
export * from "./decimal.js";
export * from "./normalizers.js";
export * from "./extractors.js";
export * from "./parsers.js";
export * from "./registry.js";

// -- The three documents (SPEC section 0.4: three documents, three readers) and the shapes they are
// -- built from. `documents.js` is the front door: parse, seal, digest, approve, explain a refusal.
export * from "./text-safety.js";
export * from "./descriptor-kinds.js";
export * from "./matchers.js";
export * from "./descriptors.js";
export * from "./contract.js";
export * from "./artifact.js";
export * from "./overlay.js";
export * from "./documents.js";
// -- The REVIEW document: an input consumed once at promotion time, plus the pure proof that
// -- decides whether a human-authored detector is allowed to exist. Not a fourth document type -
// -- see the module header for why there is no fourth reader.
export * from "./promotion.js";

// -- The port, and a scripted implementation of it. `MockSurface` ships in `src/` rather than in
// -- `test/` on purpose: units in other packages (interpreter, discovery, conformance) cannot
// -- import a sibling package's test folder, and a mock that cannot cross a package boundary is a
// -- mock that gets copied.
export * from "./observation.js";
export * from "./surface.js";
export * from "./mock-surface.js";

// -- What a run produces: the four-armed result contract, the diagnostics a failure carries, the
// -- journal event stream, and the session/lease vocabulary the executor enforces against.
export * from "./diagnostics.js";
export * from "./result.js";
export * from "./journal.js";
export * from "./session.js";

// -- LINK: contract (+) artifact (+) overlay (+) capabilities (+) args, 29 checks, zero actions.
export * from "./document-walk.js";
export * from "./overlay-merge.js";
export * from "./effects.js";
export * from "./linker.js";

// -- RUN, as pure functions over one observation: resolve the target, ask the policy, classify what
// -- came back, extract the outputs, and render all of it in the words a person debugging it needs.
export * from "./evaluate.js";
export * from "./target-resolver.js";
export * from "./policy.js";
export * from "./policy-engine.js";
// -- The APPROVAL model, which the chokepoint above reads: the two subjects an approval can have,
// -- what one must carry and bind, and the pure verification that turns a signed document into
// -- permission to dispatch an action nobody can take back. See docs/design/APPROVAL-MODEL.md.
export * from "./approval.js";
export * from "./taint.js";
export * from "./masking.js";
export * from "./classify.js";
export * from "./render.js";

// -- REPORT: how far apart two tenants of one vendor product are. Not on the decision path - it
// -- decides nothing and ships no threshold (OPEN-QUESTIONS-RESOLVED Q4) - so it sits last, after
// -- everything a run consults.
export * from "./divergence.js";
