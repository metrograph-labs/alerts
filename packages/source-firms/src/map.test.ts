import { readFileSync } from "node:fs";
import { DEFAULT_ASSESS_POLICY, matchPlaces, tableLevel, type Observation, type ObservationId, type PlaceId, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { readProduct } from "./fetch.ts";
import { AVAILABILITY_TYPE, CELL_SYSTEM, cellOf, FIRMS_CREDIT, HOTSPOT_FIELDS, HOTSPOT_KIND, HOTSPOT_LIFE_MS, hotspotBody, mapObservation, type HotspotBody } from "./map.ts";

/** A real answer of the area API for NOAA-21, cut to 7 rows (`fixtures/README.md`). */
const AREA = readFileSync(new URL("../fixtures/viirs-noaa21-area.csv", import.meta.url), "utf8");
const AT = Date.parse("2026-11-26T13:50:00Z");
const hotspots = (): readonly HotspotBody[] => readProduct("VIIRS_NOAA21_NRT", AREA)?.hotspots ?? [];
const observe = (body: string): Observation => ({ id: "o" as ObservationId, source: "firms" as Observation["source"], fetched: AT, contentType: "application/json", body, transport: { latency: 0 } });
/** A place at the hotspot of the high confidence in the middle of the fire of the fixture, with a buffer of 1 km. */
const NEAR: WatchedPlace = { id: "near" as PlaceId, codes: [], at: [24.75465, 8.53907], bufferKm: 1 };

describe("hotspotBody", () => {
  it("gives the fields in their order", () => {
    expect(Object.keys(JSON.parse(hotspotBody(hotspots()[0]!)) as object)).toEqual([...HOTSPOT_FIELDS]);
  });
});

describe("cellOf", () => {
  it("gives the south-west corner of the cell of 0.1 degree of a point", () => {
    expect(cellOf(8.53907, 24.75465)).toBe("8.5,24.7");
    expect(cellOf(-16.55, -179.99)).toBe("-16.6,-180.0");
    expect(cellOf(0.3, 0.7)).toBe("0.3,0.7");
  });
});

describe("mapObservation", () => {
  it("gives a report of a hotspot of the high confidence: urgent, likely, with a circle that holds its pixel", () => {
    const mapped = mapObservation(observe(hotspotBody(hotspots()[2]!)));
    expect(mapped.problems).toEqual([]);
    const [report] = mapped.reports;
    if (report === undefined) throw new Error("no report");
    const sent = Date.parse("2026-11-25T12:23:00Z");
    expect(report).toMatchObject({
      source: "firms",
      origin: "nasa",
      key: "VIIRS_NOAA21_NRT:2026-11-25T12:23:00Z:8.53907,24.75465",
      correlation: [{ system: CELL_SYSTEM, id: "8.5,24.7" }],
      kind: { code: HOTSPOT_KIND, label: "Satellite fire detection" },
      categories: ["fire"],
      severity: "moderate",
      urgency: "immediate",
      certainty: "likely",
      response: ["monitor"],
      sent,
      onset: sent,
      expires: sent + HOTSPOT_LIFE_MS,
      areas: [{ type: "circle", center: [24.75465, 8.53907] }],
      parameters: { satellite: ["NOAA-21"], confidence: ["high"], frp: ["79.73"], credit: [FIRMS_CREDIT] },
    });
    expect(report.description).toContain(FIRMS_CREDIT);
    expect(matchPlaces(report, [NEAR]).map((match) => match.place)).toEqual(["near"]);
  });

  it("gives a minor and possible report of a hotspot of the nominal confidence", () => {
    const [report] = mapObservation(observe(hotspotBody(hotspots()[1]!))).reports;
    expect(report).toMatchObject({ severity: "minor", certainty: "possible", parameters: { confidence: ["nominal"] } });
  });

  it("gives the two hotspots of the fire in one cell the same correlation key and different keys", () => {
    const [a, b] = [hotspots()[2]!, hotspots()[3]!].map((hotspot) => mapObservation(observe(hotspotBody(hotspot))).reports[0]);
    expect(a?.correlation).toEqual(b?.correlation);
    expect(a?.key).not.toBe(b?.key);
  });

  it("gives no hotspot the life-safety level of the core", () => {
    const levels = hotspots().map((hotspot) => {
      const [report] = mapObservation(observe(hotspotBody(hotspot))).reports;
      if (report === undefined) throw new Error("no report");
      return tableLevel(DEFAULT_ASSESS_POLICY, report, AT).level;
    });
    expect(new Set(levels)).toEqual(new Set(["urgent", "notice"]));
  });

  it("gives no report and no problem for the dates of the data", () => {
    expect(mapObservation(observe(JSON.stringify({ type: AVAILABILITY_TYPE, products: {} })))).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem and no report for a body that is not a valid hotspot", () => {
    const body = JSON.parse(hotspotBody(hotspots()[0]!)) as Record<string, unknown>;
    const changes: Record<string, unknown>[] = [{ type: "other" }, { latitude: 91 }, { longitude: "24" }, { scanned: "today" }, { confidence: "l" }, { scanKm: -1 }, { product: "" }, { frp: -2 }];
    for (const text of ["[]", "x", ...changes.map((change) => JSON.stringify({ ...body, ...change }))]) {
      const mapped = mapObservation(observe(text));
      expect(mapped.reports, text.slice(0, 60)).toEqual([]);
      expect(mapped.problems.some((problem) => problem.fatal)).toBe(true);
    }
  });
});
