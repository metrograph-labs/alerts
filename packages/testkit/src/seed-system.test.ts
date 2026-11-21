import type { SourceDescriptor, SourceId } from "@mark1russell7/alerts";
import { EMPTY_RUNTIME } from "@mark1russell7/alerts-runtime";
import { random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { seedSystem, type SeedSystem, type SystemMix } from "./seed-system.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 1);

function sourceOf(id: string): SourceDescriptor {
  return { id: id as SourceId, title: id, origins: [id], dependsOn: [`provider:${id}`], uses: ["internet", "dns", "power"], kinds: ["met.fog"], coverage: "global", transport: "poll", interval: MINUTE, slowAfter: 10_000, auth: "none" };
}

const SOURCES = [sourceOf("seed-1"), sourceOf("seed-2"), sourceOf("seed-3")];
// A mix with no cause of a system line.
const QUIET: SystemMix = { outages: 0, outage: [MINUTE, MINUTE], down: 0, failure: 0, gaps: 0, gap: [MINUTE, MINUTE] };

function stageOf(mix: SystemMix): SeedSystem {
  return seedSystem(mix, random(1), { start: START, self: "seed-a", peer: "seed-b", sources: SOURCES, retention: {}, state: () => EMPTY_RUNTIME });
}

describe("seedSystem", () => {
  it("passes each fetch of a mix with no cause", () => {
    const system = stageOf(QUIET);
    for (let minute = 0; minute < 600; minute += 1) {
      for (const source of SOURCES) expect(system.fetch(source.id, START + minute * MINUTE)).toEqual({ turned: false });
    }
  });

  it("refuses each fetch of a down source, and the result turns only at its first fetch", () => {
    const system = stageOf({ ...QUIET, down: 1 });
    const results = [0, 1, 2].map((minute) => SOURCES.map((source) => system.fetch(source.id, START + minute * MINUTE)));
    const down = SOURCES.map((_, index) => results.map((row) => row[index]!)).filter((list) => list.some((result) => result.failure !== undefined));
    expect(down).toHaveLength(1);
    expect(down[0]!.map((result) => [result.failure?.kind, result.turned])).toEqual([["refused", true], ["refused", false], ["refused", false]]);
  });

  it("fails each fetch of each source in an outage of the cell, and passes the fetches out of it", () => {
    const system = stageOf({ ...QUIET, outages: 24, outage: [10 * MINUTE, 10 * MINUTE] });
    const failed = Array.from({ length: 2 * 1_440 }, (_, minute) => SOURCES.map((source) => system.fetch(source.id, START + minute * MINUTE).failure?.kind));
    for (const row of failed) expect(new Set(row.map((kind) => kind === undefined)).size).toBe(1);
    const minutes = failed.filter((row) => row[0] !== undefined).length;
    // Each outage has 10 minutes, and a mean of 1 hour comes after it. Thus 2 days have approximately 410 minutes of outages.
    expect(minutes).toBeGreaterThan(150);
    expect(minutes).toBeLessThan(600);
    for (const row of failed) for (const kind of row) if (kind !== undefined) expect(["network", "timeout"]).toContain(kind);
  });

  it("refuses a mix with a value out of its range", () => {
    expect(() => stageOf({ ...QUIET, failure: 1 })).toThrow(/chance failure/u);
    expect(() => stageOf({ ...QUIET, down: 1.5 })).toThrow(/integer/u);
    expect(() => stageOf({ ...QUIET, outages: -1 })).toThrow(/outages -1/u);
    expect(() => stageOf({ ...QUIET, gap: [0, MINUTE] })).toThrow(/shortest must be above 0/u);
  });
});
