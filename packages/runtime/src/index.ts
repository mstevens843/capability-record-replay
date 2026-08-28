// `@crr/runtime` - the impure half.
//
// Time, disk, sockets, randomness and the browser all live here, and they live here so that
// `@crr/core` can be a directory a source-scanning test proves has none of them. The line between
// the two packages is drawn on PURITY rather than on subject matter, because that is the boundary
// this design's central claim depends on and the only one a contract test can enforce.
//
// The order below is the order a run moves through: the ports that supply the impurity, the ledgers
// and the lease that bound it, the pieces of the cycle, the cycle itself, and the host that wraps
// it in a result contract.

// -- The impure ports. Everything `@crr/core` is not allowed to reach for, behind an interface a
// -- test can hand a fake to.
export * from "./clock.js";
export * from "./ids.js";
export * from "./session.js";
export * from "./approval.js";

// -- Durable state: what a run writes down and what it reads back, and the check that greps
// -- what was written for the values the run was given before any of it is published.
export * from "./journal.js";
export * from "./evidence.js";
export * from "./store.js";
export * from "./canary.js";

// -- The machinery of one step: the ledgers that bound it, the loop that waits, the lowering that
// -- turns an instruction into an action, and the lease that says who may dispatch it.
export * from "./budgets.js";
export * from "./lease.js";
export * from "./lower.js";
export * from "./postcondition.js";
export * from "./settle.js";

// -- The cycle, and the host that links, brokers a session, supervises a restart and returns one of
// -- four arms.
export * from "./interpreter.js";
export * from "./replay.js";

// -- Escalation: what a human can be asked to fix, the brief they are asked with, the desk that
// -- holds a live session open across an agent turn, the seven-step re-check that decides whether
// -- the run may continue, and the bare console a person drives all of it from.
export * from "./escalation.js";
export * from "./resume.js";
export * from "./intervention.js";
export * from "./console.js";

// -- The gate between the two halves: a recording is not a claim until it replays. Verification
// -- runs the artifact with the model out of the loop and grades what that establishes; the
// -- lifecycle turns a passing grade into a `draft` and a signed digest into an `approved`.
export * from "./verify.js";
export * from "./lifecycle.js";

// -- The production door: one of four arms typed by the caller's contract, the catalog an agent
// -- discovers capabilities in, the deliberately poorer projection a MODEL sees, and the codegen
// -- that keeps the caller's outcome switch exhaustive.
export * from "./invoke.js";
export * from "./tools.js";
export * from "./agent-view.js";
export * from "./catalog.js";
export * from "./codegen.js";
