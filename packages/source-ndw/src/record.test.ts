import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { matchPlaces, type Observation, type ObservationId, type PlaceId, type WatchedPlace } from "@mark1russell7/alerts";
import type { Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createNdwFetch, readFile } from "./fetch.ts";
import { mapObservation } from "./map.ts";
import { LINE_BUFFER_KM, POINT_RADIUS_KM, reachesPlace, RECORD_FIELDS, RECORD_KIND, RECORD_SYSTEM, recordAreas, recordBody, type LocatedRecord } from "./record.ts";

/** The real text of a situation publication of NDW, cut to six situations (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/actueel-beeld-20261125T0112Z.xml", import.meta.url));
const LIVE_AT = Date.parse("2026-11-25T01:12:30Z");

/** The closure of the fixture: a carriageway closure for road maintenance, on a short line. */
const CLOSURE = "NDW18_0140b614-b73b-4b72-a87e-98c9f9e7a9d5";
/** The obstruction of the fixture: a vehicle obstruction at one point. */
const OBSTRUCTION = "TSN01_6b05df1a46886_REC";

/** This function gives a place of the tests at a position, with a buffer. */
const place = (id: string, lon: number, lat: number, bufferKm = 0): WatchedPlace => ({ id: id as PlaceId, codes: [{ system: "iso3166", code: "NL" }], at: [lon, lat], bufferKm });

/** A place 0.13 km to the north of the middle of the closure, and a place 1 km to the north. */
const NEAR = place("near", 4.6102, 51.8155);
const FAR = place("far", 4.6102, 51.8233);

const records = (): LocatedRecord[] => {
  const read = readFile(LIVE);
  if (!read.ok) throw new Error(read.reason);
  return [...read.records];
};

const observe = (body: string): Observation => ({ id: "o" as ObservationId, source: "ndw" as Observation["source"], fetched: LIVE_AT, contentType: "application/json", body, transport: { latency: 0 } });

const fetchWith = (replies: readonly Reply[]) => {
  let index = 0;
  const transport: Transport = async () => replies[Math.min(index++, replies.length - 1)]!;
  let time = LIVE_AT;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  return createNdwFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: "https://ndw.example.test", minIntervalMs: 0, timeoutMs: 1000 });
};
const reply = (xml: Buffer | string): Reply => ({ status: 200, statusText: "OK", headers: { "content-type": "application/x-gzip", etag: '"v1"' }, body: "", bytes: gzipSync(xml) });

describe("reportRecords", () => {
  it("gives the valid accidents, closures and obstructions of the real publication that have coordinates", () => {
    // The fixture has a second closure. Its location names only a code with no coordinate, so it gives no report.
    expect(records().map((record) => [record.id, record.location.shape])).toEqual([
      [CLOSURE, "line"],
      [OBSTRUCTION, "point"],
    ]);
  });
});

describe("recordBody", () => {
  it("gives the fields in their order, with no time of the publication", () => {
    const body = JSON.parse(recordBody(records()[0]!, "nl")) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([...RECORD_FIELDS]);
    expect(body).toMatchObject({ country: "nl", record: CLOSURE, version: "1", type: "RoadOrCarriagewayOrLaneManagement", kind: "carriagewayClosures", group: "closure", end: "2026-12-04T15:00:00.000Z", shape: "line" });
    expect(body["points"]).toEqual([
      [4.609521, 51.814385],
      [4.610235, 51.81435],
      [4.610842, 51.814266],
    ]);
  });
});

describe("reachesPlace", () => {
  it("keeps a record within the buffer of a place with a position, and no record for a place with no position", () => {
    const closure = records()[0]!.location;
    expect(reachesPlace(closure, [NEAR])).toBe(true);
    expect(reachesPlace(closure, [FAR])).toBe(false);
    expect(reachesPlace(closure, [{ ...FAR, bufferKm: 1 }])).toBe(true);
    expect(reachesPlace(closure, [{ id: "none" as PlaceId, codes: [], bufferKm: 100 }])).toBe(false);
  });
});

describe("the reports of the records", () => {
  it("gives a report of a closure whose area the core matches with a near place and not with a far place", () => {
    const mapped = mapObservation(observe(recordBody(records()[0]!, "nl")));
    expect(mapped.problems).toEqual([]);
    const [report] = mapped.reports;
    if (report === undefined) throw new Error("no report");
    expect(report).toMatchObject({
      source: "ndw",
      origin: "ndw",
      key: `${CLOSURE}:1`,
      correlation: [{ system: RECORD_SYSTEM, id: CLOSURE }],
      kind: { code: RECORD_KIND },
      severity: "minor",
      urgency: "immediate",
      certainty: "observed",
      response: ["avoid"],
      sent: Date.parse("2026-11-13T13:37:17.291Z"),
      ends: Date.parse("2026-12-04T15:00:00Z"),
      headline: "Road closure",
      parameters: { cause: ["roadMaintenance"], datexType: ["carriagewayClosures"], license: ["CC0 1.0"] },
    });
    expect(report.areas.every((area) => area.type === "polygon")).toBe(true);
    expect(matchPlaces(report, [NEAR, FAR]).map((match) => match.place)).toEqual(["near"]);
    expect(matchPlaces(report, [{ ...FAR, bufferKm: 1 }]).map((match) => match.place)).toEqual(["far"]);
  });

  it("gives a report of an obstruction with a circle around its point", () => {
    const [report] = mapObservation(observe(recordBody(records()[1]!, "nl"))).reports;
    expect(report).toMatchObject({ key: `${OBSTRUCTION}:1`, severity: "unknown", response: ["monitor"], headline: "Obstruction on a road", areas: [{ type: "circle", center: [3.6406782, 51.47778], radiusKm: POINT_RADIUS_KM }] });
  });

  it("gives areas that hold each point of a line", () => {
    const points = records()[0]!.location.points.map((point): [number, number] => [point.longitude, point.latitude]);
    const areas = recordAreas("line", points);
    const places = points.map((point, index) => place(`p${String(index)}`, point[0], point[1]));
    expect(matchPlaces({ areas }, places)).toHaveLength(points.length);
    expect(LINE_BUFFER_KM).toBeGreaterThan(0);
  });

  it("gives a fatal problem and no report for a body of another country, another group, no location or a bad time", () => {
    const body = JSON.parse(recordBody(records()[0]!, "nl")) as Record<string, unknown>;
    const cases: Record<string, unknown>[] = [
      { ...body, country: "de" },
      { ...body, license: "other" },
      { ...body, group: "works" },
      { ...body, points: [] },
      { ...body, points: [[200, 0]] },
      { ...body, shape: "area" },
      { ...body, updated: "yesterday" },
      { ...body, version: 1 },
    ];
    for (const item of cases) {
      const mapped = mapObservation(observe(JSON.stringify(item)));
      expect(mapped.reports, JSON.stringify(item).slice(0, 80)).toEqual([]);
      expect(mapped.problems.some((problem) => problem.fatal)).toBe(true);
    }
  });
});

describe("the fetch of the records", () => {
  it("gives one observation for each record near a place, after the counts, and the same id for a later publication", async () => {
    const later = LIVE.toString("utf8").replace(/<com:publicationTime>[^<]+</, "<com:publicationTime>2026-11-25T01:13:00Z<");
    const fetch = fetchWith([reply(LIVE), reply(later)]);
    const first = await fetch({ watch: { places: [NEAR] } });
    const second = await fetch({ watch: { places: [NEAR] } });
    const bodies = (first.ok ? first.observations : []).map((observation) => JSON.parse(observation.body) as Record<string, unknown>);
    expect(bodies.map((body) => body["record"] ?? "counts")).toEqual(["counts", CLOSURE]);
    const ids = [first, second].map((outcome) => (outcome.ok ? outcome.observations[1]?.id : undefined));
    expect(ids[0]).toBeTypeOf("string");
    expect(ids[1]).toBe(ids[0]);
  });

  it("gives only the counts for a place with no position and for a place far from each record", async () => {
    const outcome = await fetchWith([reply(LIVE)])({ watch: { places: [{ id: "none" as PlaceId, codes: [], bufferKm: 100 }, place("far", 5.5, 53.4)] } });
    expect(outcome.ok ? outcome.observations.length : 0).toBe(1);
  });
});
