import type { ArmProcess } from "@mark1russell7/rigor-bench/fresh";
import { describe, expect, it } from "vitest";
import { changeTable } from "../scripts/block-watch-memory.ts";

const MIB = 1_048_576;

/** This function gives the record of one child with its memory in MiB. */
function child(arm: string, round: number, rss: number, peak: number, heap: number): ArmProcess {
  return { arm, case: arm, round, position: 0, ms: 100, fields: { peakRss: peak * MIB, extra: { rss: rss * MIB, heap: heap * MIB } } };
}

describe("the memory of the watch of long blocks (AL-119)", () => {
  it("gives the change of each round in MiB", () => {
    const table = changeTable([child("off", 0, 100, 120, 30), child("on", 0, 104.5, 125, 30.1), child("on", 1, 105, 126, 30), child("off", 1, 101, 121, 30)]);
    expect(table).toContain("| 0 | 100.0 | 4.5 | 5.0 | 0.1 |");
    expect(table).toContain("| 1 | 101.0 | 4.0 | 5.0 | 0.0 |");
  });

  it("refuses a round with no child of an arm", () => {
    expect(() => changeTable([child("off", 0, 100, 120, 30)])).toThrow(/no child of the arm on/u);
  });
});
