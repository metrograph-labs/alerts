import { observationId, type Observation } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
import { entryBody } from "./fetch.ts";
import { intervalText, SOURCE_ID } from "./map.ts";

const observationOf = (body: string, fetched: number): Observation => ({
  id: observationId({ source: SOURCE_ID, contentType: "application/json", url: "u", body }),
  source: SOURCE_ID,
  fetched,
  contentType: "application/json",
  body,
  transport: { latency: 1 },
});
const START = Date.parse("2026-11-17T00:00:00Z");
const interval = (start: number, fetched: number) => observationOf(entryBody({ datetime: intervalText(start), Kp: 1, status: "pre" }), fetched);

describe("checkCanary", () => {
  it("passes when the newest interval started at most 6 hours before its fetch", () => {
    expect(checkCanary([interval(START - 10_800_000, START + 60_000), interval(START, START + 60_000)])).toEqual({
      pass: true,
      reason: "the newest interval of the index Kp starts at 2026-11-17T00:00:00Z, 0.0 hours before the fetch",
    });
    expect(checkCanary([interval(START, START + NEWEST_MAX_AGE_MS)]).pass).toBe(true);
  });

  it("fails for an old series, for no interval and for a body that is not one interval", () => {
    expect(checkCanary([interval(START, START + NEWEST_MAX_AGE_MS + 1)])).toEqual({
      pass: false,
      reason: "the newest interval of the index Kp starts at 2026-11-17T00:00:00Z, 6.0 hours before the fetch: the limit is 6 hours",
      late: true,
    });
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no interval of the index Kp of the past 6 hours" });
    expect(checkCanary([observationOf("{", START), observationOf("[1]", START), observationOf('{"datetime":"soon"}', START)]).pass).toBe(false);
  });
});
