import { observationId, type Observation } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
import { bomTime, METHODS, SOURCE_ID, type Method } from "./map.ts";

const observationOf = (method: Method, item: unknown, fetched: number): Observation => {
  const body = JSON.stringify({ method, item });
  const url = `https://sws.bom.test/api/v1/${method}`;
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url, body }), source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { url, status: 200, latency: 1 } };
};

const START = bomTime("2026-11-17 18:00:00")!;
const kIndex = (fetched: number, valid_time = "2026-11-17 18:00:00") => observationOf(METHODS.kIndex, { index: 1, valid_time, analysis_time: "2026-11-17 19:59:33" }, fetched);

describe("checkCanary", () => {
  it("passes when the newest period of the K index started at most 6 hours before the fetch", () => {
    expect(checkCanary([kIndex(START + 7_200_000)])).toEqual({ pass: true, reason: "the newest period of the K index starts at 2026-11-17 18:00:00 UTC, 2.0 hours before the fetch", age: 7_200_000, limit: NEWEST_MAX_AGE_MS });
    expect(checkCanary([kIndex(START + NEWEST_MAX_AGE_MS)]).pass).toBe(true);
  });

  it("fails for an old K index, and for a fetch with no K index", () => {
    expect(checkCanary([kIndex(START + NEWEST_MAX_AGE_MS + 1000)])).toMatchObject({ pass: false, late: true });
    expect(checkCanary([kIndex(START + NEWEST_MAX_AGE_MS + 1000)]).reason).toContain("the limit is 6 hours");
    const alert = observationOf(METHODS.alert, { start_time: "2026-11-17 19:45:00", g_scale: 1 }, START);
    expect(checkCanary([alert])).toEqual({ pass: false, reason: "the fetch has no K index of the Australian region" });
    expect(checkCanary([kIndex(START, "soon")]).pass).toBe(false);
  });

  it("reads the newest of two values", () => {
    const fetched = START + 4 * 3_600_000;
    expect(checkCanary([kIndex(fetched, "2026-11-17 12:00:00"), kIndex(fetched)]).pass).toBe(true);
  });
});
