import { firstArm } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import { BASE_AA, HEAD_AA, PAIR, gateCases, limitsOf, memoryOf, readOf, retentionOf, sameIncidents, type BenchLine } from "../scripts/fold-pair.ts";

const HOUR = 3_600_000;
const CASES = ["168", "off"] as const;

// The lines of 5 jobs of 6 rounds. On the case 168 the head takes `share` of the base, and on the case off the same time.
// The A/A pairs differ by at most 2 % in each round. Each job has its own global rounds, as `measure` gives them.
function linesOf(share: number, headIncidents: (round: number) => string = () => "same"): BenchLine[] {
  return ["1", "2", "3", "4", "5"].flatMap((job) =>
    CASES.flatMap((name, caseIndex) =>
      Array.from({ length: 6 }, (_, index) => {
        const round = Number(job) * 6 + index;
        const first = firstArm(round);
        const a = (name === "168" ? 6_000 : 1_000) * (1 + 0.01 * ((round + caseIndex) % 3));
        const b = name === "168" ? a * share : a;
        const noise = 1 + 0.01 * ((round % 3) - 1);
        const fields = {
          a: { peakRss: 400_000_000 + round, extra: { incidents: "same", count: 10, heap: 150_000_000 } },
          b: { peakRss: 380_000_000 + round, extra: { incidents: headIncidents(round), count: 10, heap: 160_000_000 } },
        };
        return [
          { record: "pair" as const, pair: PAIR, job, case: name, round, first, a, b: b * (1 + 0.01 * (round % 2)), fields },
          { record: "pair" as const, pair: BASE_AA, job, case: name, round, first, a, b: a * noise },
          { record: "pair" as const, pair: HEAD_AA, job, case: name, round, first, a: b, b: b * noise },
        ];
      }).flat(),
    ),
  );
}

describe("the fold pair bench", () => {
  it("gives no retention for the case off, and a quiet horizon in hours for a number", () => {
    expect(retentionOf("off")).toBeUndefined();
    expect(retentionOf("6")).toEqual({ horizon: 168 * HOUR, life: 720 * HOUR, every: HOUR, quiet: 6 * HOUR });
    for (const bad of ["", "0", "-6", "six"]) expect(() => retentionOf(bad)).toThrow(RangeError);
  });

  it("reads the limit of each case, and refuses a bad pair", () => {
    expect(limitsOf(undefined).size).toBe(0);
    expect(limitsOf("").size).toBe(0);
    expect([...limitsOf("168=0.75, off=1.1")]).toEqual([
      ["168", 0.75],
      ["off", 1.1],
    ]);
    for (const bad of ["168", "168=0", "=0.5", "168=0.5=1", "168=0.5,168=0.6"]) expect(() => limitsOf(bad)).toThrow(RangeError);
  });

  it("passes the gate when the head cuts the case 168 below its limit and gives the same incidents", () => {
    const lines = linesOf(0.5);
    const reads = readOf(lines, limitsOf("168=0.75,off=1.1"));
    const cut = reads.find((read) => read.case === "168")!;
    expect(cut.verdict.outcome).toBe("within");
    expect(cut.flip?.outcome).toBe("beyond");
    expect(reads.find((read) => read.case === "off")!.flip).toBeUndefined();
    const cases = gateCases(reads, sameIncidents(lines), 5);
    expect(cases.map((item) => item.outcome)).toEqual(["within", "within", "within", "within"]);
  });

  it("gives no pass when the cut is too small, or with fewer than 5 jobs", () => {
    const small = linesOf(0.9);
    const reads = readOf(small, limitsOf("168=0.75"));
    expect(reads.find((read) => read.case === "168")!.verdict.outcome).toBe("beyond");
    const few = readOf(linesOf(0.5), limitsOf("168=0.75"));
    expect(gateCases(few, sameIncidents(linesOf(0.5)), 4)[0]!.outcome).toBe("cannot decide");
  });

  it("fails the gate when the two builds give different incidents in one record", () => {
    const lines = linesOf(0.5, (round) => (round === 13 ? "other" : "same"));
    const same = sameIncidents(lines);
    expect(same.find((item) => item.case === "168")).toEqual({ case: "168", records: 30, differ: 1, missing: 0 });
    expect(gateCases(readOf(lines, new Map()), same, 5)).toEqual([{ case: "same incidents", outcome: "beyond" }]);
  });

  it("gives the largest memory of each build on each case", () => {
    const memory = memoryOf(linesOf(0.5));
    expect(memory).toContainEqual({ case: "168", arm: "base", peakRssMb: 400, heapMb: 150 });
    expect(memory).toContainEqual({ case: "off", arm: "head", peakRssMb: 380, heapMb: 160 });
  });
});
