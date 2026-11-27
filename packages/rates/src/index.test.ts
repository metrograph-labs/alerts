import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the readers, the measures, the gate and the summary", () => {
    const names = [
      "readCow",
      "tallyCow",
      "sumDetails",
      "detailsFiles",
      "ratesFile",
      "checkRates",
      "ratesSummary",
      "measureYears",
      "priorsOf",
      "causeShareOf",
      "causeSharesOf",
      "committedPriors",
      "readWatchwarn",
      "watchwarnQuery",
      "alertWindows",
      "AlertTally",
      "placeAll",
      "HarmJoin",
      "underSection",
    ] as const;
    for (const name of names) {
      expect(entry[name], name).toBeTypeOf("function");
    }
  });
});
