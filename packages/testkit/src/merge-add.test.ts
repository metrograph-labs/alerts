import { firstArm } from "@mark1russell7/rigor-bench";
import { describe, expect, it } from "vitest";
import { add } from "@mark1russell7/alerts";
import { AA_PAIR, ARMS, KINDS, PAIR, SIZES, eventOf, jobsOf, readOf, rebuild, stateOf, stepOf, type BenchLine } from "../scripts/merge-add.ts";

// The lines of 5 jobs. One add costs `share` of a rebuild, and a rebuild grows by 10 times for each 10 times in size.
// The A/A pairs differ by at most 2 % in each round. Each job has its own global rounds, as `measure` gives them.
function linesOf(share: number): BenchLine[] {
  return ["1", "2", "3", "4", "5"].flatMap((job) =>
    KINDS.flatMap((kind, kindIndex) =>
      SIZES.flatMap((size, sizeIndex) =>
        Array.from({ length: 6 }, (_, index) => {
          const round = Number(job) * 6 + index;
          const id = `${kind}:${String(size)}`;
          const a = (size / 100) * (1 + 0.01 * ((round + sizeIndex + kindIndex) % 3));
          const first = firstArm(round);
          return [
            { record: "pair" as const, pair: PAIR, job, case: id, round, first, a, b: a * share * (1 + 0.01 * (round % 2)) },
            { record: "pair" as const, pair: AA_PAIR, job, case: id, round, first, a, b: a * (1 + 0.01 * ((round % 3) - 1)) },
          ];
        }).flat(),
      ),
    ),
  );
}

describe("the merge add bench", () => {
  it("builds a state with one delivery and one end mark for each 10 reports", () => {
    const state = stateOf(1_000);
    expect(state.reports).toHaveLength(1_000);
    expect(state.deliveries).toHaveLength(100);
    expect(state.ends).toHaveLength(100);
  });

  it("gives a step that adds its event, for each arm and each kind", () => {
    for (const arm of ARMS) for (const kind of KINDS) expect(() => stepOf(arm, kind, 1_000)).not.toThrow();
  });

  it("gives the same state from the add and from the rebuild", () => {
    const state = stateOf(1_000);
    for (const kind of KINDS) {
      const event = eventOf(kind, 1_000);
      expect(add(state, event)).toStrictEqual(rebuild(state, event));
    }
  });

  it("passes an add of a small share of a rebuild, and sees the rebuild as beyond the limit", () => {
    const jobs = jobsOf(linesOf(0.01));
    expect(jobs.map((job) => job.job)).toEqual(["1", "2", "3", "4", "5"]);
    const read = readOf(jobs, 0.05);
    expect(read.add.outcome).toBe("within");
    expect(read.flip.outcome).toBe("beyond");
    expect(read.bounds).toHaveLength(5);
    expect(read.runLimit).toBeGreaterThan(0.01);
    expect(read.runLimit).toBeLessThan(0.05);
    // The add has the growth of the rebuild in these lines: 10 times for each 10 times in size.
    for (const kind of KINDS) for (const step of read.growth[kind].steps) expect(step.median).toBeCloseTo(10, 0);
  });

  it("blocks an add that costs as much as a rebuild", () => {
    expect(readOf(jobsOf(linesOf(1)), 0.05).add.outcome).toBe("beyond");
  });
});
