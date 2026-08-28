import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite is exactly `test/`. Naming it rather than excluding things keeps a stray file in a
    // working directory from either running or silently counting as coverage.
    include: ["test/**/*.test.ts"],
    // Everything here is hermetic except the transport tests, which spawn the fixture as a child
    // process. Those pay for a `node` start-up on a cold machine; five seconds is a flake waiting
    // to happen, and raising the ceiling costs a passing test nothing.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
