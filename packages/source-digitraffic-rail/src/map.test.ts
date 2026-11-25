import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { mapObservation, newestOf, RAIL_AREA, railBody, SOURCE_ID, type RailBody, type SeriesCounts, type SeriesId } from "./map.ts";

const NEWEST = Date.parse("2026-11-25T13:32:43.000Z");
const FETCHED = Date.parse("2026-11-25T13:33:00.000Z");
const SERIES: Readonly<Record<SeriesId, SeriesCounts>> = { commuter: { running: 44, late: 7, cancelled: 25 }, "long-distance": { running: 41, late: 10, cancelled: 15 } };

const observe = (body: string, fetched = FETCHED): Observation => ({ id: "o1" as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 1 } });

/** This function gives the JSON text of a body with one field changed. */
const withField = (field: string, value: unknown): string => JSON.stringify({ ...(JSON.parse(railBody(NEWEST, "2026-11-25", 134, SERIES)) as RailBody), [field]: value });

describe("railBody", () => {
  it("gives the fields in their order and the series and measures in their order", () => {
    const shuffled = { "long-distance": { cancelled: 15, late: 10, running: 41 }, commuter: { late: 7, cancelled: 25, running: 44 } };
    expect(railBody(NEWEST, "2026-11-25", 134, shuffled)).toBe(
      '{"newest":"2026-11-25T13:32:43.000Z","date":"2026-11-25","license":"CC BY 4.0","trains":134,"series":{"commuter":{"running":44,"late":7,"cancelled":25},"long-distance":{"running":41,"late":10,"cancelled":15}}}',
    );
    expect(newestOf(railBody(NEWEST, "2026-11-25", 134, SERIES))).toBe(NEWEST);
    expect(JSON.parse(railBody(undefined, "2026-11-25", 0, SERIES))).toMatchObject({ newest: null });
  });
});

describe("newestOf", () => {
  it("gives undefined for a body with no time and for a body that is not of this source", () => {
    for (const body of ["", "[]", "{}", '{"newest":null}', '{"newest":"today"}', '{"newest":"2026-11-25T13:32:43Z"}', '{"newest":12}']) expect(newestOf(body), body).toBeUndefined();
  });
});

describe("mapObservation", () => {
  it("gives one reading of Finland for each measure of each series, at the newest actual time, and no report", () => {
    const mapped = mapObservation(observe(railBody(NEWEST, "2026-11-25", 134, SERIES)));
    expect(mapped.reports).toEqual([]);
    expect(mapped.problems).toEqual([]);
    expect(mapped.readings?.map((reading) => [reading.series, reading.measure, reading.value])).toEqual([
      ["commuter", "running", 44],
      ["commuter", "late", 7],
      ["commuter", "cancelled", 25],
      ["long-distance", "running", 41],
      ["long-distance", "late", 10],
      ["long-distance", "cancelled", 15],
    ]);
    for (const reading of mapped.readings ?? []) expect(reading).toMatchObject({ source: SOURCE_ID, at: NEWEST, area: RAIL_AREA, observation: "o1" });
  });

  it("gives the time of the fetch when no running train has an actual time, and when the actual time is after the fetch", () => {
    const empty = { commuter: { running: 0, late: 0, cancelled: 3 }, "long-distance": { running: 0, late: 0, cancelled: 0 } };
    expect(mapObservation(observe(railBody(undefined, "2026-11-25", 0, empty))).readings?.map((reading) => reading.at)).toEqual(Array(6).fill(FETCHED));
    expect(mapObservation(observe(railBody(NEWEST, "2026-11-25", 134, SERIES), NEWEST - 84_000)).readings?.[0]?.at).toBe(NEWEST - 84_000);
  });

  it("gives a fatal problem and no reading for a body that it does not understand", () => {
    const shared = { "long-distance": SERIES["long-distance"] };
    const bodies: Record<string, string> = {
      "": "not json",
      " ": "[]",
      newest: withField("newest", "yesterday"),
      date: withField("date", "25.11.2026"),
      license: withField("license", "CC0 1.0"),
      trains: withField("trains", -1),
      "series.commuter": withField("series", shared),
      "series.commuter.cancelled": withField("series", { ...shared, commuter: { running: 1, late: 0, cancelled: 0.5 } }),
      "series.commuter.late": withField("series", { ...shared, commuter: { running: 1, late: 2, cancelled: 0 } }),
      "trains ": withField("trains", 10),
    };
    for (const [path, body] of Object.entries(bodies)) {
      const mapped = mapObservation(observe(body));
      expect(mapped.readings, path).toBeUndefined();
      expect(mapped.problems.some((problem) => problem.fatal && problem.path === path.trim()), path).toBe(true);
    }
  });
});
