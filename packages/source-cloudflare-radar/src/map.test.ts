import { readFileSync } from "node:fs";
import { incidents, knownKind, matchPlaces, normalize, type Observation, type ObservationId, type PlaceId, type Report } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { ANOMALIES_SOURCE, GRID_COLLAPSE_KIND, OUTAGE_CENTER, OUTAGE_KIND, OUTAGES_SOURCE } from "./feed.ts";
import { mapAnomaly, mapOutage, RADAR_CREDIT } from "./map.ts";

/** The real answers and the pages of chosen real records (`fixtures/README.md`). */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
type Record = { readonly [field: string]: unknown };
const outages = (name: string): readonly Record[] => (JSON.parse(fixture(name)) as { result: { annotations: Record[] } }).result.annotations;
const anomalies = (name: string): readonly Record[] => (JSON.parse(fixture(name)) as { result: { trafficAnomalies: Record[] } }).result.trafficAnomalies;
const OPEN_OUTAGE = outages("outages-20261118.json")[0]!;
const OPEN_ANOMALY = anomalies("anomalies-20261118.json")[0]!;
const CHOSEN_OUTAGES = outages("outages-chosen-20261118.json");
const CHOSEN_ANOMALIES = anomalies("anomalies-chosen-20261118.json");
const outage = (id: string): Record => CHOSEN_OUTAGES.find((each) => each["id"] === id)!;
const anomaly = (uuid: string): Record => CHOSEN_ANOMALIES.find((each) => each["uuid"] === uuid)!;

const FETCHED = Date.parse("2026-11-18T14:54:06Z");

/** This function gives an observation of one record, as the fetch makes it. */
function observationOf(source: Observation["source"], record: unknown): Observation {
  return { id: "o-1" as ObservationId, source, fetched: FETCHED, contentType: "application/json", body: JSON.stringify(record), transport: { latency: 0 } };
}

/** This function gives the one report of an outage, and checks that the map gives no problem other than a note. */
function outageReport(record: unknown): Report {
  const result = mapOutage(observationOf(OUTAGES_SOURCE, record));
  expect(result.problems.filter((problem) => problem.fatal || problem.lossy === true)).toEqual([]);
  expect(result.reports).toHaveLength(1);
  return result.reports[0]!;
}

/** This function gives the one report of an anomaly, and checks that the map gives no problem other than a note. */
function anomalyReport(record: unknown): Report {
  const result = mapAnomaly(observationOf(ANOMALIES_SOURCE, record));
  expect(result.problems.filter((problem) => problem.fatal || problem.lossy === true)).toEqual([]);
  expect(result.reports).toHaveLength(1);
  return result.reports[0]!;
}

describe("mapOutage", () => {
  it("maps the open outage of a platform to a cloud outage of Azure, with each region and the names of the status page of Azure", () => {
    const report = outageReport(OPEN_OUTAGE);
    expect(report).toMatchObject({
      source: OUTAGES_SOURCE,
      origin: "cloudflare",
      key: "1749",
      kind: { code: "infra.cloud.outage" },
      severity: "moderate",
      urgency: "immediate",
      certainty: "observed",
      sent: Date.parse("2026-11-12T16:17:00Z"),
      effective: Date.parse("2026-11-12T16:17:00Z"),
      received: FETCHED,
      areas: [],
      correlation: [{ system: "cloudflare-radar-outage", id: "1749" }],
      sender: "Cloudflare Radar",
      headline: "Cloudflare Radar: outage of a platform (technical problem): Microsoft Azure (80 regions)",
      web: OUTAGE_CENTER,
    });
    expect(report.ends).toBeUndefined();
    expect(report.description).toMatch(/^A global Microsoft 365 disruption/);
    expect(report.about[0]).toEqual({ system: "domain", id: "azure.microsoft.com", label: "Microsoft Azure" });
    expect(report.about).toHaveLength(81);
    const regions = report.about.map((subject) => subject.id);
    // Radar names the region France Central with its service tag `centralfrance`.
    expect(regions).toContain("azure/francecentral");
    expect(regions).not.toContain("azure/centralfrance");
    expect(regions).toContain("azure/westeurope");
    expect(regions).toContain("azure/global");
    expect(report.about.find((subject) => subject.id === "azure/francecentral")?.label).toBe("Microsoft Azure centralfrance");
    expect(report.parameters).toMatchObject({ cause: ["TECHNICAL_PROBLEM"], scope: ["PLATFORM"], dataSource: ["HTTP_ORIGINS"], credit: [RADAR_CREDIT] });
    expect(report.parameters["origin"]).toHaveLength(80);
  });

  it("maps the outage of a network in a country, with the country as its area and the network as its subject", () => {
    const report = outageReport(outage("1747"));
    expect(report).toMatchObject({
      kind: { code: "infra.internet.outage" },
      severity: "minor",
      areas: [{ type: "code", system: "iso3166", code: "DO" }],
      areaText: "Dominican Republic",
      about: [{ system: "asn", id: "6400", label: "Claro Dominicana (AS6400)" }],
      headline: "Cloudflare Radar: outage of a network (technical problem): Dominican Republic",
      web: "https://x.com/CloudflareRadar/status/2119021204161826981",
      ends: Date.parse("2026-11-06T18:45:00Z"),
    });
  });

  it("maps an outage of a region with only a GeoNames id to that region and not to its country", () => {
    const report = outageReport(outage("1744"));
    // Coverage note: no place has a GeoNames code yet, so this report goes to no place. It does not go to each place of the country.
    expect(report).toMatchObject({ severity: "moderate", areas: [{ type: "code", system: "geonames", code: "686966" }], about: [] });
    expect(matchPlaces(report, [{ id: "p" as PlaceId, codes: [{ system: "iso3166", code: "UA" }], bufferKm: 0 }])).toEqual([]);
    expect(matchPlaces(report, [{ id: "p" as PlaceId, codes: [{ system: "geonames", code: "686966" }], bufferKm: 0 }])).toHaveLength(1);
    expect(report.areaText).toBe("Zhytomyr Oblast, Ukraine");
    expect(report.headline).toBe("Cloudflare Radar: regional internet outage (power outage): Zhytomyr Oblast, Ukraine");
  });

  it("maps a nationwide outage with the cause power outage to an internet outage and a grid collapse, in one incident", () => {
    // The real regional outage 1744 (a power outage) as a nationwide outage of its country. A regional one gives one report.
    const record = { ...outage("1744"), outage: { outageCause: "POWER_OUTAGE", outageType: "NATIONWIDE" }, geoIds: [], entities: [], locations: ["UA"], locationsDetails: [{ code: "UA", name: "Ukraine" }] };
    const result = mapOutage(observationOf(OUTAGES_SOURCE, record));
    expect(result.problems.filter((problem) => problem.fatal || problem.lossy === true)).toEqual([]);
    const [internet, power, ...others] = result.reports;
    expect(others).toEqual([]);
    expect(internet).toMatchObject({ key: "1744", kind: { code: OUTAGE_KIND }, severity: "severe", certainty: "observed" });
    expect(power).toMatchObject({ key: "1744/power", kind: { code: GRID_COLLAPSE_KIND }, severity: "severe", certainty: "likely", areas: [{ type: "code", system: "iso3166", code: "UA" }] });
    expect(power?.correlation).toEqual(internet?.correlation);
    expect(power?.headline).toBe("Cloudflare Radar: nationwide power outage (internet outage of the whole country): Ukraine");
    expect(knownKind(GRID_COLLAPSE_KIND)).toBe(true);
    expect(incidents(normalize({ reports: result.reports }), FETCHED)).toHaveLength(1);
  });

  it("maps an outage that an authority ordered to a shutdown, with the countries of the record and not of its networks", () => {
    const report = outageReport(outage("1687"));
    expect(report.kind.code).toBe("infra.internet.shutdown");
    expect(report.areas).toEqual([{ type: "code", system: "iso3166", code: "IQ" }]);
    expect(report.about.map((subject) => subject.id)).toEqual(["199739", "203214", "51684", "58322", "59588"]);
    expect(report.web).toBe(OUTAGE_CENTER);
    expect(report.description).toBe("Exam shutdown");
  });

  it("maps the outage of a region of Google Cloud to the region and the domain of the service", () => {
    const report = outageReport(outage("1727"));
    expect(report.kind.code).toBe("infra.cloud.outage");
    expect(report.about).toEqual([
      { system: "domain", id: "cloud.google.com", label: "Google Cloud" },
      { system: "provider-region", id: "gcp/europe-west2", label: "Google Cloud europe-west2" },
    ]);
    expect(report.headline).toBe("Cloudflare Radar: outage of a platform (technical problem): Google Cloud europe-west2");
  });

  it("gives no area to the outage of a network with no place: the country of the network is not an area", () => {
    const report = outageReport(outage("1730"));
    expect(report.areas).toEqual([]);
    expect(report.areaText).toBeUndefined();
    expect(report.description).toBeUndefined();
    expect(report.headline).toBe("Cloudflare Radar: outage of a network (military action): DON-FTTH (AS41039)");
  });

  it("gives the severity unknown and a lossy problem for an unknown scope, and a note for an unknown cause or provider", () => {
    const record = { ...outage("1727"), outage: { outageCause: "SOLAR_FLARE", outageType: "GALACTIC" }, origins: ["acme-north-1"], originsDetails: [] };
    const result = mapOutage(observationOf(OUTAGES_SOURCE, record));
    expect(result.reports[0]).toMatchObject({ severity: "unknown", kind: { code: "infra.internet.outage" }, about: [] });
    expect(result.problems.map((problem) => [problem.path, problem.lossy === true])).toEqual([
      ["outage.outageType", true],
      ["outage.outageCause", false],
      ["origins", false],
    ]);
  });

  it("gives a fatal problem and no report for a body that is not one outage or an outage with no start", () => {
    expect(mapOutage(observationOf(OUTAGES_SOURCE, "x")).problems[0]).toMatchObject({ fatal: true });
    expect(mapOutage({ ...observationOf(OUTAGES_SOURCE, {}), body: "{" }).problems[0]).toMatchObject({ fatal: true, message: "the body is not JSON" });
    const result = mapOutage(observationOf(OUTAGES_SOURCE, { ...outage("1747"), startDate: null }));
    expect(result.reports).toEqual([]);
    expect(result.problems[0]).toMatchObject({ path: "startDate", fatal: true });
  });

  it("gives only known kinds", () => {
    for (const record of [OPEN_OUTAGE, ...CHOSEN_OUTAGES]) expect(knownKind(outageReport(record).kind.code)).toBe(true);
  });
});

describe("mapAnomaly", () => {
  it("maps the open anomaly of a network to a likely internet outage of that network, with no area", () => {
    const report = anomalyReport(OPEN_ANOMALY);
    expect(report).toMatchObject({
      source: ANOMALIES_SOURCE,
      key: "c595977b-aa94-4659-bb59-45d1884015f0",
      kind: { code: "infra.internet.outage" },
      severity: "minor",
      certainty: "likely",
      sent: Date.parse("2026-11-17T00:15:00Z"),
      areas: [],
      about: [{ system: "asn", id: "10030", label: "CELCOMNET-AP (AS10030)" }],
      correlation: [],
      headline: "Cloudflare Radar: a drop of traffic: CELCOMNET-AP (AS10030), Malaysia",
      web: "https://radar.cloudflare.com/traffic",
    });
    expect(report.areaText).toBeUndefined();
    expect(report.parameters).toMatchObject({ type: ["AS"], status: ["TP"], dataSource: ["HTTP", "NET"], credit: [RADAR_CREDIT] });
  });

  it("gives the shared key of the outage that an anomaly names, so the outage and the anomaly make one incident", () => {
    const network = anomalyReport(anomaly("e5a243d0-42f7-4f38-a574-63284f08921f"));
    expect(network.correlation).toEqual(outageReport(outage("1747")).correlation);
    expect(network.parameters["outage"]).toEqual(["1747"]);
  });

  it("maps the anomaly of a cloud region to a cloud outage with the region and the domain, with no area", () => {
    const google = anomalyReport(anomaly("4cb4fb16-0be1-4e2b-bb13-d4a86cdf3a5c"));
    expect(google).toMatchObject({ kind: { code: "infra.cloud.outage" }, areas: [], correlation: [{ system: "cloudflare-radar-outage", id: "1727" }] });
    expect(google.about.map((subject) => subject.id)).toEqual(["cloud.google.com", "gcp/europe-west2"]);
    const oracle = anomalyReport(anomaly("e02a5ade-2ab9-4e52-8aed-31792bb446b3"));
    // No source reads Oracle Cloud, so the report has the region and no domain.
    expect(oracle.about).toEqual([{ system: "provider-region", id: "oci/eu-frankfurt-1", label: "Oracle Cloud eu-frankfurt-1" }]);
    expect(oracle.headline).toBe("Cloudflare Radar: a drop of traffic: Oracle Cloud eu-frankfurt-1");
  });

  it("gives the certainty possible to an anomaly that nobody checked, and the middle severity to the anomaly of a country", () => {
    expect(anomalyReport(anomaly("f2ecf7cb-1e7d-4be9-b2b8-3b662716025e"))).toMatchObject({ certainty: "possible", areas: [] });
    expect(anomalyReport(anomaly("c944b2a9-c863-4f9d-8c9d-99b20c19f429"))).toMatchObject({ severity: "moderate", certainty: "likely", areas: [{ type: "code", system: "iso3166", code: "AW" }], areaText: "Aruba", about: [], headline: "Cloudflare Radar: a drop of traffic: Aruba" });
  });

  it("gives the severity and the certainty unknown with lossy problems for an unknown type and status", () => {
    const result = mapAnomaly(observationOf(ANOMALIES_SOURCE, { ...OPEN_ANOMALY, type: "PLANET", status: "MAYBE" }));
    expect(result.reports[0]).toMatchObject({ severity: "unknown", certainty: "unknown" });
    expect(result.problems.map((problem) => [problem.path, problem.lossy === true])).toEqual([
      ["type", true],
      ["status", true],
    ]);
  });

  it("gives a fatal problem and no report for a record with no id or no start", () => {
    expect(mapAnomaly(observationOf(ANOMALIES_SOURCE, { type: "AS" })).problems[0]).toMatchObject({ fatal: true });
    expect(mapAnomaly(observationOf(ANOMALIES_SOURCE, { ...OPEN_ANOMALY, startDate: "" })).problems[0]).toMatchObject({ path: "startDate", fatal: true });
  });
});
