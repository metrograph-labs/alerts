import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
import { hourBody, HOUR_MS, SOURCE_ID } from "./map.ts";

const END = Date.parse("2026-11-18T18:00:00Z");
const observationOf = (body: string, fetched: number): Observation => ({ id: body as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } });

describe("checkCanary", () => {
  it("passes when the newest hour with a real demand ended at most NEWEST_MAX_AGE_MS before its fetch", () => {
    const fetched = END + 54 * 60_000;
    const result = checkCanary([observationOf(hourBody("2026-11-18T17", "PJM", 93360, 88483), fetched), observationOf(hourBody("2026-11-18T18", "PJM", 91951, 88126), fetched)]);
    expect(result).toEqual({ pass: true, reason: "the newest hour with a real demand ended at 2026-11-18T18:00:00Z, 0.9 hours before the fetch" });
    expect(checkCanary([observationOf(hourBody("2026-11-18T18", "PJM", 91951, 88126), END + NEWEST_MAX_AGE_MS)]).pass).toBe(true);
  });

  it("fails for an old newest hour, and does not count a zero, a placeholder or a body that is not an hour", () => {
    const fetched = END + NEWEST_MAX_AGE_MS + 1;
    expect(checkCanary([observationOf(hourBody("2026-11-18T18", "PJM", 91951, 88126), fetched)])).toEqual({
      pass: false,
      reason: `the newest hour with a real demand ended at 2026-11-18T18:00:00Z, 3.0 hours before the fetch: the limit is ${String(NEWEST_MAX_AGE_MS / HOUR_MS)} hours`,
      late: true,
    });
    const recent = END + 30 * 60_000;
    const others = [hourBody("2026-11-18T18", "LGEE", 0, 3702), hourBody("2026-11-18T18", "CISO", 23760, 23760), "{", "null", JSON.stringify({ hour: "2026-11-18T18", demand: "1" })];
    expect(checkCanary(others.map((body) => observationOf(body, recent)))).toEqual({ pass: false, reason: "the fetch has no hour with a real demand" });
    expect(checkCanary([...others.map((body) => observationOf(body, recent)), observationOf(hourBody("2026-11-18T14", "PJM", 98138, 92580), recent)]).pass).toBe(false);
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no hour with a real demand" });
  });
});
