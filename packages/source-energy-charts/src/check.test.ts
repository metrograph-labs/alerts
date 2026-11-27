import { observationId, type Observation } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
import { minuteBody, SECONDS, SOURCE_ID } from "./map.ts";

const observationOf = (body: string, fetched: number): Observation => ({
  id: observationId({ source: SOURCE_ID, contentType: "application/json", url: "u", body }),
  source: SOURCE_ID,
  fetched,
  contentType: "application/json",
  body,
  transport: { latency: 1 },
});
const START = Date.parse("2026-11-18T03:08:00Z");
const minute = (start: number, fetched: number) => observationOf(minuteBody(start, Array.from({ length: SECONDS }, () => 50)), fetched);

describe("checkCanary", () => {
  it("passes when the newest minute started at most 6 minutes before its fetch", () => {
    expect(checkCanary([minute(START - 60_000, START + 150_000), minute(START, START + 150_000)])).toEqual({
      pass: true,
      reason: "the newest minute of the grid frequency starts at 2026-11-18T03:08:00Z, 2.5 minutes before the fetch",
      age: 150_000,
      limit: NEWEST_MAX_AGE_MS,
    });
    expect(checkCanary([minute(START, START + NEWEST_MAX_AGE_MS)]).pass).toBe(true);
  });

  it("fails for an old series, for no minute and for a body that is not one minute", () => {
    expect(checkCanary([minute(START, START + NEWEST_MAX_AGE_MS + 1)])).toEqual({
      pass: false,
      reason: "the newest minute of the grid frequency starts at 2026-11-18T03:08:00Z, 6.0 minutes before the fetch: the limit is 6 minutes",
      late: true,
      age: NEWEST_MAX_AGE_MS + 1,
      limit: NEWEST_MAX_AGE_MS,
    });
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no complete minute of the grid frequency" });
    expect(checkCanary([observationOf("{", START), observationOf("[1]", START), observationOf('{"minute":"soon"}', START)]).pass).toBe(false);
  });
});
