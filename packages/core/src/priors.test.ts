import { describe, expect, it } from "vitest";
import { committedPriors } from "./priors.ts";
import { scorePriorsSchema } from "./schemas.ts";
import data from "./data/priors.json" with { type: "json" };

describe("the entry priors", () => {
  it("gives the committed file, checked with the schema", () => {
    expect(committedPriors()).toEqual(scorePriorsSchema.parse(data));
  });

  it("gives the same object at each call", () => {
    expect(committedPriors()).toBe(committedPriors());
  });

  it("gives the deaths and injuries of one event of a kind, with an interval that holds the value", () => {
    const tornado = committedPriors().kinds["met.tornado"];
    for (const estimate of [tornado?.deaths, tornado?.injuries]) {
      expect(estimate?.low).toBeLessThanOrEqual(estimate?.value ?? Number.NaN);
      expect(estimate?.value).toBeLessThanOrEqual(estimate?.high ?? Number.NaN);
    }
  });
});
