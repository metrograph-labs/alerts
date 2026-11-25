import { readFileSync } from "node:fs";
import { incidents, knownKind, matchPlaces, normalize, observationId, reportSchema, type Observation, type PlaceId, type Report } from "@mark1russell7/alerts";
import { ACTIVE_LAW, bandDiscs, FELT_INTENSITY, intensityAt, lawAt } from "@mark1russell7/alerts-quake";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventBody, readAnswer } from "./fetch.ts";
import { intensityGridOf, shakeContours, type ShakeContours } from "./shakemap.ts";
import { EARTHQUAKE_KIND, EVENT_SYSTEM, eventIds, mapObservation, NUCLEAR_KIND, REPORT_LIFE_MS, SOURCE_ID, USGS_ORIGIN } from "./map.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const featuresOf = (text: string): Record<string, unknown>[] => (JSON.parse(text) as { features: Record<string, unknown>[] }).features;

/** The real feed of the USGS: the 48 earthquakes of magnitude 2.5 or more of one day. */
const FEED = fixture("feed-2.5_day-20261116T0327Z.geojson");
const FEATURES = featuresOf(FEED);
const URL_OF_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";
const FETCHED = Date.parse("2026-11-16T03:27:40Z");

const featureOf = (features: readonly Record<string, unknown>[], id: string): Record<string, unknown> => {
  const found = features.find((feature) => feature["id"] === id);
  if (found === undefined) throw new Error(`no event ${id}`);
  return found;
};
const withProperties = (feature: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> => ({
  ...feature,
  properties: { ...(feature["properties"] as object), ...properties },
});
const pointOf = (feature: Record<string, unknown>): [number, number, number] => (feature["geometry"] as { coordinates: [number, number, number] }).coordinates;
/** This function makes the observation of one feature, as the fetch makes it. */
const observationOf = (feature: unknown): Observation => {
  const body = eventBody(feature);
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_FEED, body }), source: SOURCE_ID, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } };
};
/** This function maps one feature, and expects one report or more and no problem. */
const mapAll = (feature: unknown): readonly Report[] => {
  const result = mapObservation(observationOf(feature));
  expect(result.problems).toEqual([]);
  expect(result.reports.length).toBeGreaterThan(0);
  return result.reports;
};
const radiusOf = (report: Report): number => {
  const [area] = report.areas;
  if (area?.type !== "circle" || report.areas.length !== 1) throw new Error("the report has no one circle");
  return area.radiusKm;
};

/** The M5.5 event in the Philippines, depth 9.971 km, with an intensity map (MMI 6.399). */
const PHILIPPINES = featureOf(FEATURES, "us7000tyek");
/** An M3.5 event in Alaska with two ids: the id of the Alaska network and the id of the national network. */
const ALASKA = featureOf(FEATURES, "aka2026wqrlbd");
/** The M7.8 event in Turkey on 2023-02-06, depth 10 km, from the event query of the USGS. Its intensity map gives MMI 9.537. */
const PAZARCIK = featureOf(featuresOf(fixture("query-us6000jllz.geojson")), "us6000jllz");
/** The M6.3 nuclear test in North Korea on 2017-09-03, depth 0 km, from the event query of the USGS. Its intensity map gives MMI 5.85. */
const NUCLEAR_TEST = featureOf(featuresOf(fixture("query-us2000aert.geojson")), "us2000aert");

describe("mapObservation", () => {
  it("maps each event of the real feed to one valid report for each band, with nested discs and no problem", () => {
    const observations = readAnswer({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: FEED }, URL_OF_FEED, FETCHED, 40)?.observations ?? [];
    expect(observations).toHaveLength(48);
    for (const observation of observations) {
      const result = mapObservation(observation);
      expect(result.problems).toEqual([]);
      expect(result.reports.length).toBeGreaterThan(0);
      for (const report of result.reports) {
        expect(reportSchema.parse(report)).toEqual(report);
        expect(report).toMatchObject({ source: SOURCE_ID, origin: USGS_ORIGIN, status: "actual", op: "alert", urgency: "past", observation: observation.id });
        expect(knownKind(report.kind.code)).toBe(true);
        expect(report.expires).toBe(report.sent + REPORT_LIFE_MS);
      }
      // The reports come from the strongest band, so each disc holds the disc before it. The last band is the felt band.
      const radii = result.reports.map(radiusOf);
      expect([...radii].sort((a, b) => a - b)).toEqual(radii);
      expect(result.reports.at(-1)?.severity).toBe("minor");
      expect(new Set(result.reports.map((report) => report.key)).size).toBe(result.reports.length);
    }
  });

  it("maps the fields of one event: a disc for each band, with the law moved to the intensity map", () => {
    const reports = mapAll(PHILIPPINES);
    const properties = PHILIPPINES["properties"] as Record<string, unknown>;
    const bias = 6.399 - intensityAt(ACTIVE_LAW, 5.5, 9.971);
    const discs = bandDiscs(ACTIVE_LAW, 5.5, 9.971, bias);
    expect(reports.map((report) => report.severity)).toEqual(["moderate", "minor"]);
    expect(reports.map((report) => report.areas)).toEqual(discs.map((disc) => [{ type: "circle", center: [126.2, 9.7595], radiusKm: disc.radiusKm }]));
    expect(radiusOf(reports[1] as Report)).toBeGreaterThan(100);
    expect(reports[0]).toMatchObject({
      key: `us7000tyek@${observationOf(PHILIPPINES).id}/moderate`,
      kind: { code: EARTHQUAKE_KIND, label: "Earthquake" },
      categories: ["geo"],
      certainty: "observed",
      sent: properties["time"],
      onset: properties["time"],
      received: FETCHED,
      areaText: properties["place"],
      sender: "us",
      headline: properties["title"],
      web: properties["url"],
      references: [],
      response: [],
      about: [],
    });
    expect(reports[0]?.parameters).toEqual({
      magnitude: ["5.5"],
      magnitudeType: [properties["magType"]],
      depthKm: ["9.971"],
      strongestIntensity: ["6.4"],
      intensitySource: ["shakemap"],
      intensityBias: [bias.toFixed(2)],
      intensityLaw: [ACTIVE_LAW.id],
      bandIntensity: ["5.5"],
      bandShape: ["disc"],
      bandRadiusKm: [String(discs[0]?.radiusKm)],
      tsunami: ["0"],
      ...(typeof properties["alert"] === "string" ? { pager: [properties["alert"]] } : {}),
    });
  });

  it("uses the law with no bias when the event has no intensity map", () => {
    const quiet = FEATURES.find((feature) => (feature["properties"] as { mmi: unknown }).mmi === null && (feature["properties"] as { mag: number }).mag >= 4);
    if (quiet === undefined) throw new Error("no event of magnitude 4 or more with no intensity map");
    const [lon, lat, depth] = pointOf(quiet);
    const magnitude = (quiet["properties"] as { mag: number }).mag;
    const law = lawAt([lon, lat]);
    const reports = mapAll(quiet);
    expect(reports.map((report) => [report.severity, radiusOf(report)])).toEqual(bandDiscs(law, magnitude, depth).map((disc) => [disc.severity, disc.radiusKm]));
    expect(reports[0]?.parameters).toMatchObject({ strongestIntensity: [intensityAt(law, magnitude, Math.max(0, depth)).toFixed(1)], intensitySource: ["law"], intensityBias: ["0.00"] });
    expect(mapAll(withProperties(quiet, { mmi: 8.1 }))[0]?.severity).toBe("extreme");
  });

  it("keeps one report of the felt band, with a disc of radius 0, for an event that the law does not give as felt", () => {
    const deep = { ...withProperties(ALASKA, { mag: 2.5, mmi: null }), geometry: { type: "Point", coordinates: [-150, 61.2, 40] } };
    const reports = mapAll(deep);
    expect(reports.map((report) => [report.severity, radiusOf(report), report.parameters["bandIntensity"]])).toEqual([["minor", 0, [String(FELT_INTENSITY)]]]);
  });

  it("gives each id of the event as a correlation key of each report, so the copies of two networks join", () => {
    expect(eventIds(",aka2026wqrlbd,us7000tyfd,")).toEqual(["aka2026wqrlbd", "us7000tyfd"]);
    expect(eventIds(",us1,,us1,US 2,")).toEqual(["us1"]);
    const correlation = [
      { system: EVENT_SYSTEM, id: "aka2026wqrlbd" },
      { system: EVENT_SYSTEM, id: "us7000tyfd" },
    ];
    for (const report of mapAll(ALASKA)) expect(report.correlation).toEqual(correlation);
    for (const report of mapAll(withProperties(ALASKA, { ids: "" }))) expect(report.correlation).toEqual([{ system: EVENT_SYSTEM, id: "aka2026wqrlbd" }]);
  });

  it("gives new reports for a new version of an event, in the same incident", () => {
    const one = mapAll(PAZARCIK);
    const two = mapAll(withProperties(PAZARCIK, { mag: 7.7, mmi: 9.2 }));
    const ids = (reports: readonly Report[]): string[] => reports.map((report) => report.id);
    expect(ids(two).filter((id) => ids(one).includes(id))).toEqual([]);
    expect(incidents(normalize({ reports: [...one, ...two] }), FETCHED)).toHaveLength(1);
    expect(ids(mapAll(withProperties(PAZARCIK, { felt: 40, cdi: 3.1, sig: 2900 })))).toEqual(ids(one));
  });

  it("gives the certainty of the status of the solution", () => {
    const certainties = (feature: Record<string, unknown>): string[] => mapAll(feature).map((report) => report.certainty);
    expect(new Set(certainties(withProperties(PAZARCIK, { status: "automatic" })))).toEqual(new Set(["likely"]));
    expect(new Set(certainties(withProperties(PAZARCIK, { status: "reviewed" })))).toEqual(new Set(["observed"]));
    const result = mapObservation(observationOf(withProperties(PAZARCIK, { status: "preliminary" })));
    expect(result.reports.map((report) => report.certainty)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(result.problems).toEqual([{ path: "status", message: 'the status "preliminary" is not known: the certainty is unknown', fatal: false, lossy: true }]);
  });

  it("gives no report and no problem for an event that is not an earthquake, or a deleted event", () => {
    for (const properties of [{ type: "quarry blast" }, { type: "explosion" }, { status: "deleted" }]) {
      expect(mapObservation(observationOf(withProperties(ALASKA, properties)))).toEqual({ reports: [], problems: [] });
    }
  });

  it("maps a nuclear test to one extreme report of a nuclear detonation, with the felt disc as its area", () => {
    const properties = NUCLEAR_TEST["properties"] as Record<string, unknown>;
    const [lon, lat, depth] = pointOf(NUCLEAR_TEST);
    const law = lawAt([lon, lat]);
    const discs = bandDiscs(law, 6.3, depth, 5.85 - intensityAt(law, 6.3, depth));
    const reports = mapAll(NUCLEAR_TEST);
    expect(reports).toHaveLength(1);
    const report = reports[0] as Report;
    expect(report).toMatchObject({
      key: `us2000aert@${observationOf(NUCLEAR_TEST).id}/nuclear`,
      kind: { code: NUCLEAR_KIND },
      severity: "extreme",
      urgency: "immediate",
      certainty: "observed",
      headline: properties["title"],
      areaText: properties["place"],
    });
    expect(knownKind(report.kind.code)).toBe(true);
    expect(radiusOf(report)).toBe(Math.max(...discs.map((disc) => disc.radiusKm)));
    expect(reportSchema.parse(report)).toEqual(report);
  });

  it("joins the earthquake version and the nuclear version of one event in one incident of a nuclear detonation", () => {
    const earthquake = mapAll(withProperties(NUCLEAR_TEST, { type: "earthquake", status: "automatic" }));
    expect(new Set(earthquake.map((report) => report.kind.code))).toEqual(new Set([EARTHQUAKE_KIND]));
    const found = incidents(normalize({ reports: [...earthquake, ...mapAll(NUCLEAR_TEST)] }), FETCHED);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind.code).toBe(NUCLEAR_KIND);
  });

  it("gives a fatal problem and no report for an event with no time, magnitude, point or title", () => {
    const cases: [Record<string, unknown>, string][] = [
      [withProperties(ALASKA, { time: null }), "time"],
      [withProperties(ALASKA, { mag: null }), "mag"],
      [withProperties(ALASKA, { title: "" }), "title"],
      [{ ...ALASKA, id: "US 7" }, "id"],
      [{ ...ALASKA, geometry: { type: "Point", coordinates: [200, 61, 9] } }, "coordinates"],
      [{ ...ALASKA, geometry: { type: "Point", coordinates: [-149, 61] } }, "coordinates"],
    ];
    for (const [feature, path] of cases) {
      const result = mapObservation(observationOf(feature));
      expect(result.reports).toEqual([]);
      expect(result.problems.map((problem) => [problem.path, problem.fatal])).toEqual([[path, true]]);
    }
  });

  it("gives a fatal problem for a body that is not JSON, or JSON that is not an event of the feed", () => {
    const body = (text: string): Observation => ({ ...observationOf(ALASKA), body: text });
    expect(mapObservation(body("{"))).toEqual({ reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] });
    expect(mapObservation(body(JSON.stringify({ error: "Service unavailable" }))).problems[0]?.message).toContain("format changed");
    expect(mapObservation(body("[1]")).problems[0]?.fatal).toBe(true);
  });

  it("does not throw for each JSON body, and each report is valid", () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const result = mapObservation({ ...observationOf(ALASKA), body: text });
        for (const report of result.reports) expect(reportSchema.parse(report)).toEqual(report);
        for (const problem of result.problems) expect(typeof problem.path).toBe("string");
      }),
    );
  });
});

describe("the bands of the shaking at a place", () => {
  // One degree of latitude is 111.19 km. A place on the meridian of the epicenter is at this distance from it.
  const placeAt = (report: Report, id: string, km: number, bufferKm = 0) => {
    const [area] = report.areas;
    if (area?.type !== "circle") throw new Error("no circle");
    return { id: id as PlaceId, at: [area.center[0], area.center[1] + km / 111.19] as [number, number], codes: [], bufferKm };
  };
  /** This function gives the severity at a place: the severity of the smallest disc that holds it. The reports come from the strongest band. */
  const severityAt = (reports: readonly Report[], km: number): string | undefined =>
    reports.find((report) => matchPlaces(report, [placeAt(report, "p", km)]).length > 0)?.severity;

  it("gives a near place the extreme band and a far place the felt band of the M7.8 event", () => {
    const reports = mapAll(PAZARCIK);
    // The law agrees with the intensity map of the USGS at the epicenter: 9.60 and 9.537.
    expect(Math.abs(intensityAt(lawAt([37.0143, 37.2256]), 7.8, 10) - 9.537)).toBeLessThan(0.1);
    expect(reports.map((report) => report.severity)).toEqual(["extreme", "severe", "moderate", "minor"]);
    expect(reports.map((report) => Math.round(radiusOf(report)))).toEqual([40, 76, 137, 522]);
    expect([20, 60, 100, 300, 600].map((km) => severityAt(reports, km))).toEqual(["extreme", "severe", "moderate", "minor", undefined]);
  });

  it("matches a place in the felt disc, and no place outside it", () => {
    const felt = mapAll(PHILIPPINES).at(-1) as Report;
    const radius = radiusOf(felt);
    const places = [placeAt(felt, "in", radius - 2), placeAt(felt, "out", radius + 2), placeAt(felt, "near", radius + 2, 5)];
    expect(matchPlaces({ areas: felt.areas }, places).map((match) => match.place)).toEqual(["in", "near"]);
  });
});

describe("mapObservation with the ShakeMap contours", () => {
  /** The real event us6000ude6 (M4.1, MMI 5.23) with the contours of its real low-resolution grid. */
  const detail = JSON.parse(fixture("detail-us6000ude6.geojson")) as Record<string, unknown> & { properties: Record<string, unknown> };
  const { products: _products, ...properties } = detail.properties;
  const EVENT = { ...detail, id: "us6000ude6", properties };
  const grid = intensityGridOf(JSON.parse(fixture("shakemap-us6000ude6-mmi-low.covjson")));
  if (grid === undefined) throw new Error("the fixture has no grid");
  const CONTOURS = shakeContours("1795616312537", grid);
  const withShake = (contours: unknown): Observation => {
    const body = JSON.stringify({ ...JSON.parse(eventBody(EVENT)), shakemap: contours });
    return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_FEED, body }), source: SOURCE_ID, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } };
  };

  it("gives the region of the grid as the area of a band that the grid reaches", () => {
    const { reports, problems } = mapObservation(withShake(CONTOURS));
    expect(problems).toEqual([]);
    // The felt band of the grid has one polygon for each separate region, and each polygon is one area.
    const felt = CONTOURS.bands.find((band) => band.from === FELT_INTENSITY);
    expect(felt?.polygons.length).toBeGreaterThan(0);
    expect(reports.map((report) => [report.severity, report.areas.length, report.parameters["bandShape"], report.parameters["bandRadiusKm"]])).toEqual([["minor", felt?.polygons.length, ["shakemap"], undefined]]);
    expect(reports[0]?.areas.every((area) => area.type === "polygon")).toBe(true);
    expect(reports[0]?.parameters["shakemapVersion"]).toEqual(["1795616312537"]);
    expect(reportSchema.safeParse(reports[0]).success).toBe(true);
    const epicenter = { id: "epicenter" as PlaceId, at: [-104.8395, 36.9498] as [number, number], codes: [], bufferKm: 0 };
    const far = { id: "far" as PlaceId, at: [-105.9, 36.1] as [number, number], codes: [], bufferKm: 0 };
    expect(matchPlaces({ areas: reports[0]?.areas ?? [] }, [epicenter, far]).map((match) => match.place)).toEqual(["epicenter"]);
  });

  it("keeps the disc of a band that the grid does not reach", () => {
    // The feed gives MMI 6.0, but the low-resolution grid reaches only the felt band.
    const strong = { ...EVENT, properties: { ...properties, mmi: 6 } };
    const body = JSON.stringify({ ...JSON.parse(eventBody(strong)), shakemap: CONTOURS });
    const { reports } = mapObservation({ ...withShake(CONTOURS), body });
    expect(reports.map((report) => [report.severity, report.parameters["bandShape"]])).toEqual([
      ["moderate", ["disc"]],
      ["minor", ["shakemap"]],
    ]);
  });

  it("uses the discs, with a problem, for contours with a different structure", () => {
    const broken: ShakeContours = { version: "1", bands: [{ from: 4.2, polygons: [] }] };
    const { reports, problems } = mapObservation(withShake(broken));
    expect(problems).toEqual([{ path: "shakemap", message: expect.stringContaining("the map uses the discs") as string, fatal: false, lossy: true }]);
    expect(reports.map((report) => report.parameters["bandShape"])).toEqual([["disc"]]);
  });

  it("gives a nuclear test the region of the weakest band", () => {
    const test = { ...EVENT, properties: { ...properties, type: "nuclear explosion" } };
    const body = JSON.stringify({ ...JSON.parse(eventBody(test)), shakemap: CONTOURS });
    const { reports } = mapObservation({ ...withShake(CONTOURS), body });
    expect(reports.map((report) => [report.kind.code, report.areas[0]?.type, report.parameters["bandIntensity"]])).toEqual([[NUCLEAR_KIND, "polygon", [String(FELT_INTENSITY)]]]);
  });
});
