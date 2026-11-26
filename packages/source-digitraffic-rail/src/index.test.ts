import { checkWith, sourceDescriptorSchema, type Observation, type ObservationId } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary, createRailSource, FETCH_INTERVAL_MS, FINTRAFFIC_ORIGIN, MIN_INTERVAL_MS, NEWEST_MAX_AGE_MS, RAIL_DESCRIPTOR, RAIL_MEASURES, railBody, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const NEWEST = Date.parse("2026-11-25T13:32:43.000Z");
const SERIES = { commuter: { running: 3, late: 1, cancelled: 3 }, "long-distance": { running: 3, late: 2, cancelled: 1 } };
const observe = (fetched: number, body = railBody(NEWEST, "2026-11-25", 9, SERIES)): Observation => ({
  id: "o" as ObservationId,
  source: SOURCE_ID,
  fetched,
  contentType: "application/json",
  body,
  transport: { latency: 0 },
});

describe("createRailSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createRailSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }), userAgent: "alerts-tests" });
    expect(source.describe()).toEqual(RAIL_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    expect(source.map({ observation: observe(NEWEST) }).readings?.length).toBe(6);
  });

  it("describes a poll each 5 minutes with no key, no kind and three train counts of the country, and passes the schema of the core", () => {
    expect(checkWith(sourceDescriptorSchema, RAIL_DESCRIPTOR).tag).toBe("ok");
    expect(RAIL_DESCRIPTOR).toMatchObject({ id: SOURCE_ID, origins: [FINTRAFFIC_ORIGIN], dependsOn: ["provider:fintraffic"], kinds: [], coverage: [], transport: "poll", interval: FETCH_INTERVAL_MS, auth: "none" });
    expect(RAIL_MEASURES.map((measure) => [measure.id, measure.moves])).toEqual([
      ["running", "drop"],
      ["late", "rise"],
      ["cancelled", "rise"],
    ]);
    for (const measure of RAIL_MEASURES) expect(measure).toMatchObject({ dimension: "rail", unit: "{train}", area: "code", baseline: "none", cadence: FETCH_INTERVAL_MS });
    expect(new Set(RAIL_MEASURES.map((measure) => measure.title)).size).toBe(RAIL_MEASURES.length);
    expect(FETCH_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });
});

describe("checkCanary", () => {
  it("passes for an actual time at most 30 minutes before its fetch, and fails after", () => {
    expect(checkCanary([observe(NEWEST + NEWEST_MAX_AGE_MS)]).pass).toBe(true);
    const old = checkCanary([observe(NEWEST + NEWEST_MAX_AGE_MS + 1)]);
    expect(old.pass).toBe(false);
    expect(old.reason).toContain("2026-11-25T13:32:43.000Z");
  });

  it("passes for an actual time after the fetch, uses the newest time, and fails for a fetch with no actual time", () => {
    expect(checkCanary([observe(NEWEST - 84_000)]).pass).toBe(true);
    const older = observe(NEWEST + 60_000, railBody(NEWEST - 3_600_000, "2026-11-25", 9, SERIES));
    expect(checkCanary([older, observe(NEWEST + 60_000)]).pass).toBe(true);
    expect(checkCanary([observe(NEWEST, railBody(undefined, "2026-11-25", 0, SERIES))]).pass).toBe(false);
    expect(checkCanary([observe(NEWEST, "not json")]).pass).toBe(false);
  });
});
