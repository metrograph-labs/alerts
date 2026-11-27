import { quantileInterval, quantileSamples } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import { CANARY_LIMITS, canaryLimit, publishGaps } from "./canary-limit.ts";

const MINUTE = 60_000;

/** This function gives `count` publish times, one each `gap` from the time 0. */
function regular(count: number, gap: number): number[] {
  return Array.from({ length: count }, (_, index) => index * gap);
}

describe("publishGaps", () => {
  it("gives the gaps in the order of the times, with each time one time", () => {
    expect(publishGaps([30, 0, 10, 10, 30, 60])).toEqual([10, 20, 30]);
  });

  it("leaves out each time that is not a finite number", () => {
    expect(publishGaps([0, Number.NaN, 5, Number.POSITIVE_INFINITY])).toEqual([5]);
    expect(publishGaps([])).toEqual([]);
  });
});

describe("canaryLimit", () => {
  it("gives the upper bound of the 99th percentile of the gaps at the level 0.95, plus the margin", () => {
    expect(CANARY_LIMITS).toEqual({ quantile: 0.99, level: 0.95 });
    const needed = quantileSamples(CANARY_LIMITS.quantile, CANARY_LIMITS.level);
    expect(needed).toBe(368);
    // A record of 368 gaps of 10 minutes and one gap of 25 minutes: the bound is the largest gap.
    const times = [...regular(369, 10 * MINUTE), 368 * 10 * MINUTE + 25 * MINUTE];
    const gaps = publishGaps(times);
    expect(gaps).toHaveLength(369);
    expect(quantileInterval(gaps, 0.99, 0.95).high).toBe(25 * MINUTE);
    expect(canaryLimit(times, { margin: 5 * MINUTE })).toBe(30 * MINUTE);
  });

  it("gives no limit for a record with too few gaps for an upper bound", () => {
    expect(canaryLimit(regular(368, 10 * MINUTE), { margin: MINUTE })).toBeUndefined();
    expect(canaryLimit(regular(369, 10 * MINUTE), { margin: MINUTE })).toBe(11 * MINUTE);
    expect(canaryLimit([], { margin: MINUTE })).toBeUndefined();
  });

  it("takes a quantile and a level in place of the defaults", () => {
    // At the 90th percentile and the level 0.95, 36 gaps give a bound.
    expect(quantileSamples(0.9, 0.95)).toBe(36);
    const times = regular(37, 15 * MINUTE);
    expect(canaryLimit(times, { margin: 0 })).toBeUndefined();
    expect(canaryLimit(times, { margin: 0, quantile: 0.9, level: 0.95 })).toBe(15 * MINUTE);
    expect(canaryLimit(regular(36, 15 * MINUTE), { margin: 0, quantile: 0.9, level: 0.95 })).toBeUndefined();
  });

  it("gives the same limit for the same record in each order", () => {
    const times = [...regular(400, 7 * MINUTE), 400 * 7 * MINUTE + 3 * MINUTE];
    const reversed = [...times].reverse();
    expect(canaryLimit(reversed, { margin: MINUTE })).toBe(canaryLimit(times, { margin: MINUTE }));
  });
});
