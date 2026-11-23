import { describe, expect, it } from "vitest";

import * as entry from "./index.ts";

describe("the entry", () => {
  it("gives the map function and the reader of the rows", () => {
    expect(entry.mapObservation).toBeTypeOf("function");
    expect(entry.eventOf).toBeTypeOf("function");
    expect(entry.GDELT_KINDS).toEqual(["security.civil-unrest", "security.armed-conflict"]);
  });
});
