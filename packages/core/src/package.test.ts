import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the package file", () => {
  // A bundler keeps each module of a package with no `sideEffects` field. The zod schemas of this package then go into
  // each page that imports one name of it. This package has no code that runs on import, so the field is false.
  it("tells the bundlers that the package has no side effects", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { sideEffects?: unknown };
    expect(manifest.sideEffects).toBe(false);
  });
});
