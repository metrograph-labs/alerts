import { quantileInterval, quantileSamples } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import { CANARY_AGE_WINDOW, CANARY_LIMIT_CEILING, CANARY_LIMITS, canaryLimit, judgeCanary, liveCanaryLimit, publishGaps } from "./canary-limit.ts";

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

describe("liveCanaryLimit (AL-207)", () => {
  const HAND = 60 * MINUTE;

  it("keeps four times the count of ages that a bound needs", () => {
    expect(CANARY_AGE_WINDOW).toBe(4 * 368);
    expect(CANARY_LIMIT_CEILING).toBe(2);
  });

  it("gives the hand limit for too few ages", () => {
    expect(liveCanaryLimit([], HAND)).toBe(HAND);
    expect(liveCanaryLimit(Array.from({ length: 367 }, () => 70 * MINUTE), HAND)).toBe(HAND);
  });

  it("gives the upper bound of the ages between the hand limit and its ceiling", () => {
    // 368 ages: the bound is the largest age.
    const ages = [...Array.from({ length: 367 }, () => 20 * MINUTE), 65 * MINUTE];
    expect(liveCanaryLimit(ages, HAND)).toBe(65 * MINUTE);
    // A bound below the hand limit gives the hand limit: a live limit never adds a failure.
    expect(liveCanaryLimit(Array.from({ length: 400 }, () => 20 * MINUTE), HAND)).toBe(HAND);
    // A bound past the ceiling gives the ceiling.
    expect(liveCanaryLimit(Array.from({ length: 400 }, () => 300 * MINUTE), HAND)).toBe(2 * HAND);
  });

  it("does not take the largest age as the bound when the window is full", () => {
    const ages = [...Array.from({ length: CANARY_AGE_WINDOW - 1 }, () => 61 * MINUTE), 110 * MINUTE];
    expect(liveCanaryLimit(ages, HAND)).toBe(61 * MINUTE);
  });

  it("ignores each age that is not a finite number of 0 or more", () => {
    const ages = [...Array.from({ length: 368 }, () => 62 * MINUTE), Number.NaN, -1, Number.POSITIVE_INFINITY];
    expect(liveCanaryLimit(ages, HAND)).toBe(62 * MINUTE);
  });
});

describe("judgeCanary (AL-207)", () => {
  const late = { pass: false, reason: "the newest file is 65 minutes old: the limit is 60 minutes", late: true, age: 65 * MINUTE, limit: 60 * MINUTE } as const;

  it("passes a late check with an age within the live limit, and keeps the text of the check", () => {
    expect(judgeCanary(late, 70 * MINUTE)).toEqual({
      pass: true,
      reason: "the newest file is 65 minutes old: the limit is 60 minutes. The live limit from the measured ages is 70 minutes: the check passes",
      age: 65 * MINUTE,
      limit: 70 * MINUTE,
    });
  });

  it("fails a check with an age past the live limit, as late", () => {
    const judged = judgeCanary({ ...late, age: 80 * MINUTE }, 70 * MINUTE);
    expect(judged.pass).toBe(false);
    expect(judged.late).toBe(true);
    expect(judged.limit).toBe(70 * MINUTE);
  });

  it("keeps a result with no age, with no limit, or with the same limit", () => {
    const other = { pass: false, reason: "the fetch has no item" } as const;
    expect(judgeCanary(other, 70 * MINUTE)).toBe(other);
    expect(judgeCanary(late, 60 * MINUTE)).toBe(late);
    const noLimit = { pass: true, reason: "a pass", age: MINUTE } as const;
    expect(judgeCanary(noLimit, 70 * MINUTE)).toBe(noLimit);
  });
});
