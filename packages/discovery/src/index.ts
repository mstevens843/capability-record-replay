// `@crr/discovery` - the only package that may import a model SDK.
//
// It owns four things and nothing else: the provider PORT, the observe/decide/act LOOP that drives
// it, the filtered PROJECTION the model is shown, and the VCR that records and replays a run. What
// the loop produces (`DiscoveryRun`) is deliberately NOT an artifact: turning recorded steps into a
// typed, parameterized, content-addressed document is deterministic synthesis with no model in it,
// which is build unit 14's, and keeping the two apart is what lets synthesis be tested from a
// frozen run with no provider and no browser.
//
// Two contract tests in `@crr/core` read this directory off disk:
//   · `test/policy-chokepoint.test.ts` fails unless every `Surface.act` call site is immediately
//     preceded by a `check` on the same action whose decision is consulted. There is exactly one
//     such call site, in `loop.ts`.
//   · `test/no-locator-vocabulary.test.ts` fails on any locator vocabulary here. The model is shown
//     roles and accessible names; it has no way to write a selector because nothing in this package
//     can express one.
//
// The order below is the order a request travels: port, tools, projection, prompt, loop, journal,
// VCR, adapters.

// -- The port every adapter implements, and the token accounting that comes back with a turn.
export * from "./model-port.js";

// -- What the model can do (five tools) and what it is shown (the filtered Observation).
export * from "./tools.js";
export * from "./projection.js";
export * from "./prompt.js";

// -- The manual tool-use loop, and the event stream it leaves behind.
export * from "./loop.js";
export * from "./journal.js";

// -- Record and replay: the reason `pnpm test` needs no credentials.
export * from "./transcript.js";
export * from "./scripted-model.js";

// -- The shipping adapter. Importing it costs nothing; calling `turn` on it spends money.
export * from "./adapters/anthropic.js";

// -- The second provider (SPEC section 11 unit 23). Same caveat, and no SDK: it speaks the Chat
// -- Completions HTTP shape through an INJECTED fetch, so the package stays hermetic and the
// -- adapter stays testable with no network and no key.
export * from "./adapters/openai.js";

// -- SYNTHESIS (SPEC section 1.1): a recording becomes a contract and an artifact, deterministically
// -- and with no model in the loop. Ordered the way the pipeline runs: the substitution table that
// -- keeps values out of documents, then parameters, routes, locators, outputs, the fingerprint,
// -- what could not be decided without a person, and finally the emitter that assembles all of it.
export * from "./synthesis/values.js";
export * from "./synthesis/parameters.js";
export * from "./synthesis/routes.js";
export * from "./synthesis/descriptors.js";
export * from "./synthesis/outputs.js";
export * from "./synthesis/fingerprint.js";
export * from "./synthesis/report.js";
export * from "./synthesis/emit.js";
