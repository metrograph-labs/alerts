import { readFileSync } from "node:fs";
import { causeShareSchema, type CauseRead } from "@mark1russell7/alerts";
import { wilson } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";

import { CAUSE_READS, causeShareOf, causeSharesOf } from "./causes.ts";
import { priorsOf } from "./priors.ts";
import type { RatesFile } from "./rates.ts";

const read = (deaths: number, of: number): CauseRead => ({ deaths, of, source: `A source of ${deaths} in ${of}`, url: "https://example.org/source" });

describe("the share of a cause", () => {
  it("is the pooled share of the reads, with the hull of the Wilson interval and the share of each read", () => {
    const share = causeShareOf([read(9, 117), read(16, 129)]);
    const pooled = wilson(25, 246);
    expect(share.share.value).toBe(25 / 246);
    expect(share.share.low).toBe(Math.min(pooled.low, 9 / 117));
    expect(share.share.high).toBe(Math.max(pooled.high, 16 / 129));
  });

  it("holds the share of each read in its interval", () => {
    const share = causeShareOf([read(1, 100), read(40, 50)]);
    expect(share.share.low).toBeLessThanOrEqual(0.01);
    expect(share.share.high).toBeGreaterThanOrEqual(0.8);
  });

  it("gives a wide interval to a count of 0, not a point at 0", () => {
    const share = causeShareOf([read(0, 20)]);
    expect(share.share.value).toBe(0);
    expect(share.share.high).toBeGreaterThan(0.1);
  });

  it("refuses no read and a read with a count that is not valid", () => {
    expect(() => causeShareOf([])).toThrow(RangeError);
    expect(() => causeShareOf([read(5, 4)])).toThrow(/not valid/);
    expect(() => causeShareOf([read(1, 0)])).toThrow(/not valid/);
    expect(() => causeShareOf([read(1.5, 10)])).toThrow(/not valid/);
  });
});

describe("the cited table", () => {
  const shares = causeSharesOf(CAUSE_READS);

  it("gives a share that passes the schema of the core for each cause", () => {
    for (const causes of shares.values()) {
      for (const share of Object.values(causes)) expect(causeShareSchema.parse(share)).toEqual(share);
    }
  });

  it("gives the CO poisoning of tropical cyclones from the two CDC counts", () => {
    const co = shares.get("met.tropical")?.["co-poisoning"];
    expect(co?.reads.map((r) => [r.deaths, r.of])).toEqual([
      [9, 117],
      [16, 129],
    ]);
    expect(co?.share.value).toBeCloseTo(0.1016, 4);
  });

  it("goes into the priors of the kind", () => {
    const rates = JSON.parse(readFileSync(new URL("../data/rates.json", import.meta.url), "utf8")) as RatesFile;
    expect(priorsOf(rates).kinds["met.tropical"]?.causes).toEqual(shares.get("met.tropical"));
  });
});
