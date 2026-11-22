import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Many tests of testkit start a full runtime from a seeded home. One start takes about 5 s on a CI runner.
    testTimeout: 60_000,
  },
});
