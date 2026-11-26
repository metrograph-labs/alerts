import type { ArmProcess } from "@mark1russell7/rigor-bench/fresh";
import { describe, expect, it } from "vitest";
import { caseId, childRecord, readCase, readRecords, readSizes, verdicts, verdictTable, type Arm, type ChildRecord } from "../scripts/start-snapshot-arms.ts";

const MIB = 1_048_576;

/** This function gives the record of one child. The time of the arm full grows as the log, and the arm snapshot stays flat. */
function record(job: string, arm: Arm, size: number, round: number): ChildRecord {
  const openMs = arm === "full" ? 20 * size + round : 900 + round;
  return { record: "child", job, arm, size, round, openMs, cpuMs: openMs * 0.9, peakRss: (arm === "full" ? 200 + size : 220) * MIB, events: size * 1000 };
}

const records = ["1", "2", "3", "4", "5"].flatMap((job) => [48, 480].flatMap((size) => [0, 1].flatMap((round) => [record(job, "full", size, round), record(job, "snapshot", size, round)])));

describe("the start with the snapshot and with no snapshot (AL-105)", () => {
  it("reads the case ids and the sizes", () => {
    expect(readCase(caseId("snapshot", 192))).toEqual({ arm: "snapshot", size: 192 });
    expect(() => readCase("warm-192")).toThrow(/not <arm>-<size in MB>/u);
    expect(readSizes("192, 48,96,48")).toEqual([48, 96, 192]);
    expect(() => readSizes("48")).toThrow(/2 or more sizes/u);
    expect(() => readSizes("48,0")).toThrow(/2 or more sizes/u);
  });

  it("makes the record of a child of freshArms", () => {
    const child: ArmProcess = { arm: "full", case: "full-96", round: 2, position: 1, ms: 5000, fields: { peakRss: 300 * MIB, extra: { cpuMs: 4800, logEvents: 96_000 } } };
    expect(childRecord("3", child)).toEqual({ record: "child", job: "3", arm: "full", size: 96, round: 2, openMs: 5000, cpuMs: 4800, peakRss: 300 * MIB, events: 96_000 });
    expect(() => childRecord("3", { ...child, fields: { peakRss: 1 } })).toThrow(/no number cpuMs/u);
  });

  it("gives the growth of each arm over the sizes of the log", () => {
    const of = (arm: Arm) => verdicts(records).find((each) => each.arm === arm && each.value === "openMs")!.verdict.steps[0]!;
    expect(of("full").exponent).toBeCloseTo(1, 1);
    expect(of("full").outcome).toBe("beyond");
    expect(Math.abs(of("snapshot").exponent)).toBeLessThan(0.05);
    expect(of("snapshot").outcome).not.toBe("beyond");
  });

  it("writes the table, and reads only the child lines of a file", () => {
    const text = [JSON.stringify({ record: "env", job: "1" }), ...records.map((each) => JSON.stringify(each)), "not a line"].join("\n");
    const read = readRecords([text]);
    expect(read).toHaveLength(records.length);
    const table = verdictTable(read);
    expect(table).toContain("| full | 48 | 10 | 961 |");
    expect(table).toContain("| snapshot | 480 | 10 | 901 |");
    expect(table).toContain("| full | openMs | 48 to 480 MB |");
  });
});
