import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { AVAILABILITY_TYPE, SOURCE_ID } from "./map.ts";

const observationOf = (body: string, fetched: number): Observation => ({ id: body as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } });
const dates = (products: Record<string, string>): string => JSON.stringify({ type: AVAILABILITY_TYPE, products });
const AT = Date.parse("2026-11-26T13:50:00Z");

describe("checkCanary", () => {
  it("passes when the newest date of a product is the day of the fetch or the day before", () => {
    expect(checkCanary([observationOf(dates({ VIIRS_NOAA20_NRT: "2026-11-26", VIIRS_SNPP_NRT: "2026-11-02" }), AT)])).toEqual({
      pass: true,
      reason: "the newest data of the VIIRS products is of 2026-11-26, the day of the fetch is 2026-11-26",
    });
    expect(checkCanary([observationOf(dates({ VIIRS_NOAA21_NRT: "2026-11-25" }), Date.parse("2026-11-26T23:59:00Z"))]).pass).toBe(true);
  });

  it("fails for an old newest date, for no date and for no observation of the dates", () => {
    expect(checkCanary([observationOf(dates({ VIIRS_NOAA20_NRT: "2026-11-24" }), AT)])).toEqual({
      pass: false,
      reason: "the newest data of the VIIRS products is of 2026-11-24, 2 days before the day of the fetch: the limit is 1 day",
      late: true,
    });
    expect(checkCanary([observationOf(dates({}), AT)]).pass).toBe(false);
    expect(checkCanary([observationOf("{", AT), observationOf(JSON.stringify({ type: "hotspot" }), AT)])).toEqual({ pass: false, reason: "the fetch has no dates of the data" });
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no dates of the data" });
  });
});
