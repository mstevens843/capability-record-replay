import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite is exactly `test/`. Naming it rather than excluding things keeps a stray file in a
    // working directory from either running or silently counting as coverage.
    include: ["test/**/*.test.ts"],
    // The hermetic half of this suite runs in milliseconds. The browser half boots a fixture server
    // and launches Chromium, and the FIRST such test pays for the launch, so the default five
    // seconds is a flake waiting to happen on a cold machine. Raising the ceiling does not slow a
    // passing test down; it stops a slow start from being reported as a failure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
