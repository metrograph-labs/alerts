import { readFileSync } from "node:fs";
import { matchPlaces, type FetchOutcome, type PlaceId, type WatchedPlace } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { boxText, createFirmsFetch, DAY_RANGE, placeBoxes, PRODUCTS, readAvailability, readProduct, scanTime, VIIRS_HEADER, watchBoxes } from "./fetch.ts";
import { hotspotArea, SOURCE_ID } from "./map.ts";

/** A real answer of the area API for NOAA-21, cut to 7 rows (`fixtures/README.md`). */
const AREA = readFileSync(new URL("../fixtures/viirs-noaa21-area.csv", import.meta.url), "utf8");
/** The real answer of the dates of the data of 2026-11-26. */
const DATES = readFileSync(new URL("../fixtures/availability.csv", import.meta.url), "utf8");
const AT = Date.parse("2026-11-26T13:50:00Z");
const KEY = "0123456789abcdef0123456789abcdef";
const BASE = "https://firms.example.test";

/** This function gives a place of the tests at a position, with a buffer. */
const place = (id: string, lon: number, lat: number, bufferKm = 0): WatchedPlace => ({ id: id as PlaceId, codes: [], at: [lon, lat], bufferKm });
/** A place at the hotspot of the high confidence in the middle of the fire of the fixture, with a buffer of 1 km. */
const NEAR = place("near", 24.75465, 8.53907, 1);
/** A place 1 degree to the north of the fire. */
const FAR = place("far", 24.75465, 9.6, 1);

const csv = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "text/plain;charset=UTF-8" }, body });
const EMPTY = csv(`${VIIRS_HEADER}\n`);

/** This function makes a fetch whose transport gives `dates` for the dates, `area` for NOAA-21, and no row for each other product. */
const fetchWith = (area: Reply = csv(AREA), dates: Reply = csv(DATES)) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    if (exchange.url.includes("/data_availability/")) return dates;
    return exchange.url.includes("/VIIRS_NOAA21_NRT/") ? area : EMPTY;
  };
  let time = AT;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createFirmsFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", mapKey: KEY, baseUrl: BASE, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const bodiesOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations.map((observation) => JSON.parse(observation.body) as Record<string, unknown>) : []);
const idsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations.map((observation) => observation.id) : []);

describe("scanTime", () => {
  it("gives the time of a scan in UTC from a date and a time with no zero at the start", () => {
    expect(scanTime("2026-11-25", "1223")).toBe("2026-11-25T12:23:00Z");
    expect(scanTime("2026-11-26", "15")).toBe("2026-11-26T00:15:00Z");
    expect(scanTime("2026-11-26", "7")).toBe("2026-11-26T00:07:00Z");
  });

  it("gives undefined for a date or a time that is not valid", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["2026-11-26", "2460"],
      ["2026-02-30", "0100"],
      ["26-11-2026", "0100"],
      ["2026-11-26", "12345"],
      ["2026-11-26", ""],
    ];
    for (const [date, time] of cases) expect(scanTime(date, time), `${date} ${time}`).toBeUndefined();
  });
});

describe("readProduct", () => {
  it("gives each hotspot of the nominal and the high confidence of a real answer, and counts the hotspots of the low confidence", () => {
    const rows = readProduct("VIIRS_NOAA21_NRT", AREA);
    expect(rows?.invalid).toEqual([]);
    expect(rows?.low).toBe(1);
    expect(rows?.hotspots.map((hotspot) => hotspot.confidence)).toEqual(["h", "n", "h", "n", "n", "n"]);
    expect(rows?.hotspots[0]).toEqual({
      type: "hotspot",
      product: "VIIRS_NOAA21_NRT",
      latitude: 8.51397,
      longitude: 24.74526,
      scanned: "2026-11-25T12:23:00Z",
      satellite: "N21",
      instrument: "VIIRS",
      confidence: "h",
      version: "2.0NRT",
      frp: 15.79,
      scanKm: 0.47,
      trackKm: 0.64,
      daynight: "D",
    });
  });

  it("gives no hotspot for an answer with only the header, and undefined for an answer with a different header", () => {
    expect(readProduct("VIIRS_NOAA20_NRT", `${VIIRS_HEADER}\n`)).toEqual({ hotspots: [], low: 0, invalid: [] });
    expect(readProduct("VIIRS_NOAA20_NRT", "Invalid MAP_KEY.")).toBeUndefined();
    expect(readProduct("VIIRS_NOAA20_NRT", "")).toBeUndefined();
  });

  it("keeps each row that is not valid as text", () => {
    const rows = readProduct(
      "VIIRS_NOAA21_NRT",
      `${VIIRS_HEADER}\n1,2,3\n95,24,367,0.47,0.64,2026-11-25,1223,N21,VIIRS,h,2.0NRT,301.9,15.79,D\n8,24,367,0.47,0.64,2026-11-25,1223,N21,VIIRS,x,2.0NRT,301.9,15.79,D\n`,
    );
    expect(rows?.hotspots).toEqual([]);
    expect(rows?.invalid).toHaveLength(3);
  });

  it("does not throw for any text", () => {
    fc.assert(fc.property(fc.string(), (text) => void readProduct("VIIRS_NOAA20_NRT", `${VIIRS_HEADER}\n${text}`)));
  });
});

describe("readAvailability", () => {
  it("gives the newest date of each VIIRS product that the fetch reads", () => {
    expect(readAvailability(DATES)).toEqual({ VIIRS_NOAA20_NRT: "2026-11-26", VIIRS_NOAA21_NRT: "2026-11-26", VIIRS_SNPP_NRT: "2026-11-02" });
    expect(readAvailability("Invalid MAP_KEY.")).toBeUndefined();
  });
});

describe("the boxes of the places", () => {
  it("gives a box of whole degrees that holds the buffer of a place, and no box for a place with no position", () => {
    expect(placeBoxes(NEAR)).toEqual([{ west: 24, south: 8, east: 25, north: 9 }]);
    expect(placeBoxes({ id: "none" as PlaceId, codes: [], bufferKm: 10 })).toEqual([]);
  });

  it("gives two boxes for a buffer that crosses the antimeridian, and a box around the pole for a place near it", () => {
    expect(placeBoxes(place("east", 179.99, -16.5, 2))).toEqual([
      { west: 179, south: -17, east: 180, north: -16 },
      { west: -180, south: -17, east: -179, north: -16 },
    ]);
    expect(placeBoxes(place("pole", 10, 89.99, 5))).toEqual([{ west: -180, south: 89, east: 180, north: 90 }]);
  });

  it("gives one box for two places in one cell", () => {
    expect(watchBoxes([NEAR, place("other", 24.6, 8.6, 1)]).map(boxText)).toEqual(["24,8,25,9"]);
  });

  it("gives boxes of whole degrees that hold the place and the point at the reach of its buffer to the east and the north", () => {
    fc.assert(
      fc.property(fc.double({ min: -179, max: 179, noNaN: true }), fc.double({ min: -80, max: 80, noNaN: true }), fc.double({ min: 0, max: 50, noNaN: true }), (lon, lat, bufferKm) => {
        const boxes = placeBoxes(place("p", lon, lat, bufferKm));
        expect(boxes.length).toBeGreaterThan(0);
        for (const box of boxes) expect([box.west, box.south, box.east, box.north].every(Number.isInteger)).toBe(true);
        const holds = (x: number, y: number): boolean => boxes.some((box) => box.west <= x && x <= box.east && box.south <= y && y <= box.north);
        expect(holds(lon, lat)).toBe(true);
        // One degree of latitude is more than 110 km, so the reach to the north is less than the reach in degrees.
        expect(holds(lon, Math.min(90, lat + (bufferKm + 5) / 112))).toBe(true);
      }),
    );
  });
});

describe("createFirmsFetch", () => {
  it("reads the dates, then the hotspots of each product in the box of the place, with the key only in the path", async () => {
    const { fetch, sent } = fetchWith();
    const outcome = await fetch({ watch: { places: [NEAR] } });
    expect(sent.map((exchange) => exchange.url)).toEqual([
      `${BASE}/api/data_availability/csv/${KEY}/ALL`,
      ...PRODUCTS.map((product) => `${BASE}/api/area/csv/${KEY}/${product}/24,8,25,9/${String(DAY_RANGE)}`),
    ]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "text/csv" });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    // The two hotspots at the place: the high confidence at its point and the nominal confidence 0.46 km to the east.
    // The hotspot of the low confidence 0.47 km to the west gives no observation.
    expect(bodiesOf(outcome).map((body) => [body["type"], body["latitude"] ?? null, body["confidence"] ?? null])).toEqual([
      ["availability", null, null],
      ["hotspot", 8.53907, "h"],
      ["hotspot", 8.53961, "n"],
    ]);
    expect(bodiesOf(outcome)[0]).toEqual({ type: "availability", products: { VIIRS_NOAA20_NRT: "2026-11-26", VIIRS_NOAA21_NRT: "2026-11-26", VIIRS_SNPP_NRT: "2026-11-02" } });
    expect(outcome.ok && outcome.observations.every((observation) => observation.source === SOURCE_ID)).toBe(true);
  });

  it("gives only the hotspots that the matcher of the core matches with a place", async () => {
    const rows = readProduct("VIIRS_NOAA21_NRT", AREA)?.hotspots ?? [];
    const kept = bodiesOf(await fetchWith().fetch({ watch: { places: [NEAR] } }))
      .filter((body) => body["type"] === "hotspot")
      .map((body) => body["latitude"]);
    expect(kept).toEqual(rows.filter((hotspot) => matchPlaces({ areas: [hotspotArea(hotspot)] }, [NEAR]).length > 0).map((hotspot) => hotspot.latitude));
  });

  it("gives the same observation ids for the same rows, and only the dates for a far place or a place with no position", async () => {
    const first = idsOf(await fetchWith().fetch({ watch: { places: [NEAR] } }));
    expect(first).toHaveLength(3);
    expect(idsOf(await fetchWith().fetch({ watch: { places: [NEAR] } }))).toEqual(first);
    expect(bodiesOf(await fetchWith().fetch({ watch: { places: [FAR] } }))).toHaveLength(1);
    const { fetch, sent } = fetchWith();
    expect(bodiesOf(await fetch({ watch: { places: [{ id: "none" as PlaceId, codes: [], bufferKm: 100 }] } }))).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("gives an invalid key as an auth failure, with no key in the message", async () => {
    const outcome = await fetchWith(EMPTY, csv("Invalid MAP_KEY.", 400)).fetch({ watch: { places: [NEAR] } });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "auth" } });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("gives the answer of the limit as rate-limited, and an answer that is not the CSV as a server failure with no key", async () => {
    const limited = await fetchWith(csv("Exceeding allowed transaction limit.", 429)).fetch({ watch: { places: [NEAR] } });
    expect(limited).toMatchObject({ ok: false, failure: { kind: "rate-limited", retryAfter: 600_000 } });
    const other = await fetchWith(csv(`<html>${KEY}</html>`)).fetch({ watch: { places: [NEAR] } });
    expect(other).toMatchObject({ ok: false, failure: { kind: "server" } });
    expect(JSON.stringify(other)).not.toContain(KEY);
  });

  it("gives a fetch with a row that is not valid as not complete", async () => {
    expect(await fetchWith(csv(`${AREA}1,2,3\n`)).fetch({ watch: { places: [NEAR] } })).toMatchObject({ ok: true, complete: false });
  });
});
