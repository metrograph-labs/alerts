import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { API_UNIT, DEMAND, hourBody, HOUR_FIELDS, isPlaceholder, mapObservation, periodEnd, periodText, SOURCE_ID, ZONE_SYSTEM, zoneOf } from "./map.ts";

const observationOf = (body: string): Observation => ({ id: "o-1" as ObservationId, source: SOURCE_ID, fetched: 0, contentType: "application/json", body, transport: { latency: 0 } });

describe("periodEnd and periodText", () => {
  it("reads a period of the API as the end of its hour in UTC, and writes it back", () => {
    const end = Date.parse("2026-11-18T18:00:00Z");
    expect(periodEnd("2026-11-18T18")).toBe(end);
    expect(periodText(end)).toBe("2026-11-18T18");
    expect(periodText(end + 59 * 60_000)).toBe("2026-11-18T18");
  });

  it("gives undefined for each text that is not one whole hour in UTC", () => {
    for (const value of ["2026-11-18T24", "2026-02-30T01", "2026-11-18T18:00", "2026-11-18", "2026-11-18T18Z", " 2026-11-18T18", 2026, null, undefined]) expect(periodEnd(value)).toBeUndefined();
  });
});

describe("hourBody", () => {
  it("writes the fields of HOUR_FIELDS in their order, with null for a missing value", () => {
    const body = hourBody("2026-11-18T18", "PJM", 91951, null);
    expect(Object.keys(JSON.parse(body) as object)).toEqual([...HOUR_FIELDS]);
    expect(body).toBe('{"hour":"2026-11-18T18","respondent":"PJM","unit":"megawatthours","demand":91951,"forecast":null}');
  });
});

describe("isPlaceholder", () => {
  it("is true only for a demand that equals a known forecast", () => {
    expect(isPlaceholder(23760, 23760)).toBe(true);
    expect(isPlaceholder(23760, 23761)).toBe(false);
    expect(isPlaceholder(23760, null)).toBe(false);
  });
});

describe("mapObservation", () => {
  it("gives one reading of the demand with the forecast as its expected value, in the zone of the balancing authority", () => {
    const result = mapObservation(observationOf(hourBody("2026-11-18T18", "PJM", 91951, 88126)));
    expect(result).toEqual({
      reports: [],
      problems: [],
      readings: [{ source: SOURCE_ID, measure: DEMAND, series: "PJM", at: Date.parse("2026-11-18T18:00:00Z"), value: 91951, area: { type: "zone", system: ZONE_SYSTEM, code: "PJM" }, observation: "o-1", expected: 88126 }],
    });
    expect(zoneOf("PJM")).toEqual({ type: "zone", system: "eia-ba", code: "PJM" });
  });

  it("gives no reading and a note when the hour has no forecast above 0, and each reading passes its declaration (AL-158)", () => {
    for (const forecast of [null, 0, -5]) {
      const result = mapObservation(observationOf(hourBody("2026-11-18T18", "SCEG", 2353, forecast)));
      expect(result.readings).toBeUndefined();
      expect(result.reports).toEqual([]);
      expect(result.problems).toMatchObject([{ path: "forecast" }]);
      expect(result.problems[0]?.fatal).not.toBe(true);
    }
  });

  it("gives no reading and a note for a demand that is not above 0, or that is a placeholder", () => {
    for (const [demand, forecast] of [
      [0, 3702],
      [null, 3702],
      [-1, 3702],
      [23760, 23760],
    ] as const) {
      const result = mapObservation(observationOf(hourBody("2026-11-18T18", "LGEE", demand, forecast)));
      expect(result.readings).toBeUndefined();
      expect(result.reports).toEqual([]);
      expect(result.problems).toMatchObject([{ path: "demand" }]);
      expect(result.problems[0]?.fatal).not.toBe(true);
    }
  });

  it("gives a fatal problem for a bad hour, a different unit, a body that is not JSON and a body that is not one hour", () => {
    const fatal = (body: string) => mapObservation(observationOf(body)).problems.filter((problem) => problem.fatal === true).map((problem) => problem.path);
    expect(fatal(hourBody("2026-11-18T25", "PJM", 1, 2))).toEqual(["hour"]);
    expect(fatal(JSON.stringify({ hour: "2026-11-18T18", respondent: "PJM", unit: "MWh", demand: 1, forecast: 2 }))).toEqual(["unit"]);
    expect(fatal("{")).toEqual([""]);
    expect(fatal(JSON.stringify({ period: "2026-11-18T18", respondent: "PJM", type: "D", value: "1", "value-units": API_UNIT }))).toEqual([""]);
    expect(fatal(JSON.stringify({ response: { frequency: "daily" } }))).toEqual([""]);
    expect(fatal("null")).toEqual([""]);
  });
});
