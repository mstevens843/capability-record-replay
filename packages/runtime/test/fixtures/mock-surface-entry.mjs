// A JS re-export of the frozen corpus, so the CLI's `--surface` module - which is loaded by URL at
// run time and is therefore not compiled by vitest's TypeScript transform - can reach it.
//
// The CLI takes its driver as a PARAMETER rather than a dependency, which is the same claim the
// package makes about itself everywhere else. The cost is exactly this: a `--surface` module is
// plain JavaScript. `examples/` ships the browser one.
export { screens, IDS } from "./mock-flow.ts";
