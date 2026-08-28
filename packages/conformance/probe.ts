// DELETE THIS FILE.
//
// A scratch driver used while building the corpus. It is empty of behaviour now; everything it did
// lives in `test/conformance.test.ts`, `test/suite-discriminates.test.ts` and `src/stability-cli.ts`.
// It is outside `tsconfig.json`'s `include`, so it is neither built nor typechecked, and the unit
// that wrote it could not remove it (`rm` and `mv` are denied to this agent). It is recorded here
// rather than left to be discovered.
export {};
