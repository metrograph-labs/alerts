import { checkWith, sourceDescriptorSchema, type Observation, type ObservationId } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary, countBody, createNdwSource, FETCH_INTERVAL_MS, MIN_INTERVAL_MS, NDW_DESCRIPTOR, NDW_MEASURES, NDW_ORIGIN, PUBLISHED_MAX_AGE_MS, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const PUBLISHED = Date.parse("2026-11-25T01:12:00.002Z");
const GROUPS = { accident: 0, congestion: 0, obstruction: 1, closure: 2, works: 0, conditions: 0, other: 5 };
const observe = (fetched: number, body = countBody(PUBLISHED, "nl", GROUPS, 0, 0)): Observation => ({
  id: "o" as ObservationId,
  source: SOURCE_ID,
  fetched,
  contentType: "application/json",
  body,
  transport: { latency: 0 },
});

describe("createNdwSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createNdwSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }), userAgent: "alerts-tests" });
    expect(source.describe()).toEqual(NDW_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    expect(source.map({ observation: observe(PUBLISHED) }).readings?.length).toBe(7);
  });

  it("describes a poll each 5 minutes with no key, no kind and seven count measures of the country, and passes the schema of the core", () => {
    expect(checkWith(sourceDescriptorSchema, NDW_DESCRIPTOR).tag).toBe("ok");
    expect(NDW_DESCRIPTOR).toMatchObject({ id: SOURCE_ID, origins: [NDW_ORIGIN], dependsOn: ["provider:ndw"], kinds: [], coverage: [], transport: "poll", interval: FETCH_INTERVAL_MS, auth: "none" });
    expect(NDW_MEASURES.map((measure) => measure.id)).toEqual(["records", "accidents", "congestion", "obstructions", "closures", "works", "conditions"]);
    for (const measure of NDW_MEASURES) expect(measure).toMatchObject({ dimension: "road-events", unit: "{record}", area: "code", moves: "rise", cadence: FETCH_INTERVAL_MS });
    expect(new Set(NDW_MEASURES.map((measure) => measure.title)).size).toBe(NDW_MEASURES.length);
    expect(FETCH_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
  });
});

describe("checkCanary", () => {
  it("passes for a publication at most 10 minutes before its fetch, and fails after", () => {
    expect(checkCanary([observe(PUBLISHED + PUBLISHED_MAX_AGE_MS)]).pass).toBe(true);
    const old = checkCanary([observe(PUBLISHED + PUBLISHED_MAX_AGE_MS + 1)]);
    expect(old.pass).toBe(false);
    expect(old.reason).toContain("2026-11-25T01:12:00.002Z");
  });

  it("uses the newest publication of the fetch, and fails for a fetch with no publication", () => {
    const older = observe(PUBLISHED + 60_000, countBody(PUBLISHED - 3_600_000, "nl", GROUPS, 0, 0));
    expect(checkCanary([older, observe(PUBLISHED + 60_000)]).pass).toBe(true);
    expect(checkCanary([observe(PUBLISHED, "not json")]).pass).toBe(false);
  });
});
