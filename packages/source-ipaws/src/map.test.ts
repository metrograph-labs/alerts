import { readFileSync } from "node:fs";
import { capMessageKey, carriages, incidents, normalize, reportId, unknownKinds, type Observation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import { EVENT_CODES, NAME_ALIASES, NWS_API_SOURCE, parseVtec, PHENOMENA, vtecKey } from "@mark1russell7/alerts-format-nws";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IPAWS_DESCRIPTOR } from "./descriptor.ts";
import { WEA_EXPECTATION } from "./expectation.ts";
import { mapObservation, NWS_SENDER, ORIGINS, originOf, SOURCE_ID } from "./map.ts";

/**
 * The real messages of one event of a Texas office (KEWX, flash flood warning 0108): the IPAWS copy
 * and the NWS API copy of the first message and of its extension. Their one home is the package `format-cap`.
 */
const PAIRS = new URL("../../format-cap/fixtures/pairs/", import.meta.url);
const pair = (name: string): string => readFileSync(new URL(name, PAIRS), "utf8");
const NEW_IPAWS = pair("kewx-ff-w-0108-new.ipaws.xml");
const EXT_IPAWS = pair("kewx-ff-w-0108-ext.ipaws.xml");
const NEW_API = JSON.parse(pair("kewx-ff-w-0108-new.nws-api.json")) as { properties: Record<string, any> };
const EXT_API = JSON.parse(pair("kewx-ff-w-0108-ext.nws-api.json")) as { properties: Record<string, any> };
const FETCHED = Date.parse("2026-11-08T19:23:40Z");

const observe = (body: string, url = "https://ipaws.test/public/recent/2026-11-08T19:00:00Z"): Observation => ({
  id: `observation-${String(body.length)}` as ObservationId,
  source: SOURCE_ID,
  fetched: FETCHED,
  contentType: "application/xml",
  body,
  transport: { url, status: 200, latency: 0 },
});

const mapOne = (body: string, languages?: readonly string[]): { report: Report; problems: readonly unknown[] } => {
  const result = mapObservation(observe(body), languages);
  expect(result.reports).toHaveLength(1);
  return { report: result.reports[0] as Report, problems: result.problems };
};

/** The codes of the areas of a report, as `system:code`, in order. */
const codesOf = (report: Report): string[] => report.areas.flatMap((area) => (area.type === "code" ? [`${area.system}:${area.code}`] : [])).sort();

/** The correlation key of the NWS API copy: its operational VTEC and its sent time. */
const apiKeyOf = (copy: { properties: Record<string, any> }): string => {
  const vtec = parseVtec(copy.properties["parameters"]["VTEC"][0] as string);
  if (vtec === undefined) throw new Error("the fixture has no VTEC");
  return vtecKey(vtec, Date.parse(copy.properties["sent"] as string)).id;
};

describe("the map of the IPAWS copies of the KEWX flash flood warning", () => {
  it("maps the first message to one report with no problem", () => {
    const { report, problems } = mapOne(NEW_IPAWS);
    expect(problems).toEqual([]);
    expect(report).toMatchObject({
      id: reportId({ source: SOURCE_ID, key: `${NEW_API.properties["id"] as string}.IPAWS`, sent: Date.parse("2026-11-08T13:23:00-06:00") }),
      source: SOURCE_ID,
      origin: ORIGINS.nws,
      key: `${NEW_API.properties["id"] as string}.IPAWS`,
      references: [],
      status: "actual",
      op: "alert",
      categories: ["met"],
      severity: "severe",
      urgency: "immediate",
      certainty: "likely",
      response: ["avoid"],
      sent: Date.parse("2026-11-08T13:23:00-06:00"),
      received: FETCHED,
      expires: Date.parse("2026-11-08T20:00:00-06:00"),
      sender: "NWS Austin/San Antonio TX",
      observation: observe(NEW_IPAWS).id,
      about: [],
    });
    expect(report.kind.code).toBe(PHENOMENA["FF"]?.code);
    expect(report.parameters["WEAHandling"]).toEqual(["Imminent Threat"]);
    expect(report.parameters["eventCode.NationalWeatherService"]).toEqual(["FFW"]);
    expect(report.headline).toMatch(/^Flash Flood Warning issued November 8 at 1:23PM CST/);
  });

  it("gives the VTEC key of the NWS API copy, so the two copies join one incident", () => {
    for (const [ipaws, api] of [
      [NEW_IPAWS, NEW_API],
      [EXT_IPAWS, EXT_API],
    ] as const) {
      const { report } = mapOne(ipaws);
      expect(report.correlation.filter((key) => key.system === "vtec").map((key) => key.id)).toEqual([apiKeyOf(api)]);
    }
  });

  it("gives the region codes of the NWS API copy, and the polygon in the order of the core", () => {
    const { report } = mapOne(NEW_IPAWS);
    const geocode = NEW_API.properties["geocode"] as { UGC: string[]; SAME: string[] };
    expect(codesOf(report)).toEqual([...geocode.UGC.map((code) => `ugc:${code}`), ...geocode.SAME.map((code) => `same:${code}`)].sort());
    // The message of the NWS has one area element in the chosen language: each area has its key.
    expect(new Set(report.areas.map((area) => (area.type === "place" ? "" : area.block)))).toEqual(new Set(["info[0].area[0]"]));
    const polygons = report.areas.filter((area) => area.type === "polygon");
    expect(polygons).toHaveLength(1);
    const ring = polygons[0]?.type === "polygon" ? polygons[0].rings[0] : undefined;
    // Texas: the longitude is about -100, the latitude about 30
    expect(ring?.every(([lon, lat]) => lon < -98 && lon > -102 && lat > 28 && lat < 31)).toBe(true);
  });

  it("maps the extension to an update that references the first message", () => {
    const { report, problems } = mapOne(EXT_IPAWS);
    expect(problems).toEqual([]);
    expect(report.op).toBe("update");
    expect(report.references).toEqual([`${NEW_API.properties["id"] as string}.IPAWS`]);
  });

  it("gives the Spanish block when the configuration asks for it first", () => {
    const { report, problems } = mapOne(NEW_IPAWS, ["es-US", "en-US"]);
    expect(problems).toEqual([]);
    expect(report.parameters["language"]).toEqual(["es-US"]);
    // The NWS gives the English headline in both blocks. Only the WEA text is in Spanish.
    expect(report.parameters["CMAMtext"]).toEqual(["SNM: AVISO DE INUNDACIONES REPENTINAS hasta 8:00 PM CST. Evite areas inundadas."]);
    expect(report.correlation).toEqual(mapOne(NEW_IPAWS).report.correlation);
    expect(codesOf(report)).toEqual(codesOf(mapOne(NEW_IPAWS).report));
  });

  it("does not read the transport: two URLs that differ only in the time give equal reports", () => {
    const first = mapObservation(observe(NEW_IPAWS, "https://ipaws.test/public/recent/2026-11-08T19:00:00Z"));
    const second = mapObservation(observe(NEW_IPAWS, "https://ipaws.test/public/recent/2026-11-08T19:01:00Z"));
    expect(second).toEqual(first);
  });

  it("is deterministic: the same observation gives the same reports", () => {
    expect(mapObservation(observe(EXT_IPAWS))).toEqual(mapObservation(observe(EXT_IPAWS)));
  });
});

describe("the expectation of the WEA copies, in the core", () => {
  /** A report of the NWS API source with the facts of its fixture that the core reads. */
  const apiReport = (copy: { properties: Record<string, any> }, received: number): Report => {
    const sent = Date.parse(copy.properties["sent"] as string);
    const vtec = parseVtec(copy.properties["parameters"]["VTEC"][0] as string);
    if (vtec === undefined) throw new Error("the fixture has no VTEC");
    return {
      ...mapOne(NEW_IPAWS).report,
      id: reportId({ source: NWS_API_SOURCE, key: copy.properties["id"] as string, sent }),
      source: NWS_API_SOURCE,
      key: copy.properties["id"] as string,
      correlation: [vtecKey(vtec, sent)],
      sent,
      received,
      parameters: { WEAHandling: copy.properties["parameters"]["WEAHandling"] as string[] },
      observation: "observation-api" as ObservationId,
    };
  };

  it("finds the IPAWS copy of the NWS API report in its incident, with its delay", () => {
    const api = apiReport(NEW_API, FETCHED - 20_000);
    const ipaws = mapOne(NEW_IPAWS).report;
    const state = normalize({ reports: [api, ipaws] });
    const checks = carriages(state, incidents(state, FETCHED + 60_000), [WEA_EXPECTATION]);
    expect(checks).toEqual([{ expectation: "nws-api.ipaws", report: api.id, started: FETCHED - 20_000, arrived: FETCHED }]);
  });

  it("names the two sources and the filter that the lead gave", () => {
    expect(WEA_EXPECTATION).toEqual({
      id: "nws-api.ipaws",
      from: "nws-api" as SourceId,
      to: SOURCE_ID,
      when: { statuses: ["actual"], parameters: ["WEAHandling"] },
    });
  });
});

/** A message of a different authority. It is not a real message: the sender is a test domain and the status is Test. */
const authority = (geocodes: string, extra = ""): string =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>TEST-1</identifier><sender>alerts@example.org</sender><sent>2026-11-15T00:00:00-00:00</sent><status>Test</status><msgType>Alert</msgType><scope>Public</scope>${extra}<info><category>Safety</category><event>Test Message</event><urgency>Unknown</urgency><severity>Unknown</severity><certainty>Unknown</certainty><area><areaDesc>A test area</areaDesc>${geocodes}</area></info></alert>`;

describe("the map of other messages", () => {
  it("gives the authority origin to a message of a different sender", () => {
    const { report } = mapOne(authority("<geocode><valueName>SAME</valueName><value>020173</value></geocode>"));
    expect(report.origin).toBe(ORIGINS.authority);
    expect(report.status).toBe("test");
    // A message with no VTEC has only the key of its CAP message.
    expect(report.correlation).toEqual([capMessageKey({ sender: "alerts@example.org", identifier: "TEST-1", sent: Date.parse("2026-11-15T00:00:00Z") })]);
    expect(codesOf(report)).toEqual(["same:020173"]);
    expect(IPAWS_DESCRIPTOR.origins).toEqual([ORIGINS.nws, ORIGINS.authority]);
  });

  it("reads the deprecated certainty Very Likely of CAP 1.0 as likely, with no problem", () => {
    const { report, problems } = mapOne(authority("<geocode><valueName>SAME</valueName><value>020173</value></geocode>").replace("<certainty>Unknown</certainty>", "<certainty>Very Likely</certainty>"));
    expect(report.certainty).toBe("likely");
    expect(problems).toEqual([]);
  });

  it("knows the NWS by its sender, with no change of case", () => {
    expect(originOf(NWS_SENDER)).toBe("nws");
    expect(originOf(" W-NWS.Webmaster@NOAA.gov ")).toBe("nws");
    expect(originOf("nws@example.org")).toBe("ipaws-authority");
  });

  it("gives a lossy problem for an unknown geocode, and does not make an area of it", () => {
    const { report, problems } = mapOne(authority("<geocode><valueName>FIPS6</valueName><value>020173</value></geocode>"));
    expect(codesOf(report)).toEqual([]);
    expect(problems).toEqual([{ path: "info[0].area[0].geocode", message: 'the map function does not know the geocode "FIPS6"', fatal: false, lossy: true }]);
  });

  it("gives one report for each block of the chosen language, with the key of the message and its own areas", () => {
    const one = authority("<geocode><valueName>SAME</valueName><value>048019</value></geocode>");
    const two = one.replace(
      "</info></alert>",
      "</info><info><category>Safety</category><event>Test Message</event><urgency>Unknown</urgency><severity>Unknown</severity><certainty>Unknown</certainty><area><areaDesc>A second area</areaDesc><geocode><valueName>SAME</valueName><value>020173</value></geocode></area></info></alert>",
    );
    const result = mapObservation(observe(two));
    expect(result.problems).toEqual([]);
    expect(result.reports.map(codesOf)).toEqual([["same:048019"], ["same:020173"]]);
    expect(result.reports.map((report) => report.areaText)).toEqual(["A test area", "A second area"]);
    // Each report has the key of the message, so a later reference to the message ends each of them.
    expect(new Set(result.reports.map((report) => report.key))).toEqual(new Set(["TEST-1"]));
    const sent = Date.parse("2026-11-15T00:00:00Z");
    expect(result.reports.map((report) => report.id)).toEqual([0, 1].map((index) => reportId({ source: SOURCE_ID, key: "TEST-1", sent, part: `info[${String(index)}]` })));
    // A message of one block keeps the id of a report with no part.
    expect(mapOne(one).report.id).toBe(reportId({ source: SOURCE_ID, key: "TEST-1", sent }));
  });

  it("gives each area of an NWS message the key of its CAP area element, and no key for another sender", () => {
    const same = "<geocode><valueName>SAME</valueName><value>020173</value></geocode>";
    const body = authority(`<polygon>37.6,-97.5 37.6,-97.2 37.8,-97.2 37.6,-97.5</polygon>${same}${same}</area><area><areaDesc>A second area</areaDesc>${same}`);
    const blocksOf = (report: Report): string[] => report.areas.map((area) => (area.type === "place" ? "" : `${area.block ?? "none"} ${area.type}`));
    // The NWS: the shapes of an area element decide for it, and each code is in the report one time for each element.
    const nws = mapOne(body.replace("<sender>alerts@example.org</sender>", `<sender>${NWS_SENDER}</sender>`));
    expect(nws.report.origin).toBe(ORIGINS.nws);
    expect(blocksOf(nws.report)).toEqual(["info[0].area[0] polygon", "info[0].area[0] code", "info[0].area[1] code"]);
    // Another sender can mean the union of the parts of an element, as CAP tells. Its areas keep the union rule.
    const other = mapOne(body);
    expect(other.problems).toEqual([]);
    expect(blocksOf(other.report)).toEqual(["none polygon", "none code"]);
  });

  it("gives no report and no problem for an acknowledgment", () => {
    expect(mapObservation(observe(authority("").replace("<msgType>Alert</msgType>", "<msgType>Ack</msgType>")))).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem for a body that is not a CAP message, and does not throw", () => {
    for (const body of ["", "<html><body>Attention Required</body></html>", "<alert>", "\u0000"]) {
      const result = mapObservation(observe(body));
      expect(result.reports, body).toEqual([]);
      expect(result.problems.some((problem) => problem.fatal), body).toBe(true);
    }
  });

  it("gives a fatal problem for a message with no identifier or no sent time", () => {
    for (const body of [authority("").replace("<identifier>TEST-1</identifier>", ""), authority("").replace("2026-11-15T00:00:00-00:00", "yesterday")]) {
      const result = mapObservation(observe(body));
      expect(result.reports).toEqual([]);
      expect(result.problems.some((problem) => problem.fatal)).toBe(true);
    }
  });
});

/** A message of a different authority with a SAME event code and an event name. The two texts have no XML characters. */
const withEvent = (sameCode: string, name: string): string =>
  authority("<geocode><valueName>SAME</valueName><value>020173</value></geocode>")
    .replace("<event>Test Message</event>", `<event>${name}</event>`)
    .replace("</certainty>", `</certainty><eventCode><valueName>SAME</valueName><value>${sameCode}</value></eventCode>`);

// The gate of the taxonomy: a code with a typo does not match the life-safety class, so it can stop a wake.
describe("the gate of the taxonomy", () => {
  const kindOf = (body: string): string => mapOne(body).report.kind.code;

  it("gives only codes of the taxonomy for the real messages and for each SAME event code", () => {
    const real = [NEW_IPAWS, EXT_IPAWS].map(kindOf);
    const same = Object.keys(EVENT_CODES).map((code) => kindOf(withEvent(code, "Test Message")));
    expect(real).toEqual([PHENOMENA["FF"]?.code, PHENOMENA["FF"]?.code]);
    expect(same).toHaveLength(Object.keys(EVENT_CODES).length);
    expect(unknownKinds([...real, ...same])).toEqual([]);
  });

  it("gives a code of the taxonomy for each SAME code and event name, also for an input that no table knows", () => {
    const code = fc.oneof(fc.constantFrom(...Object.keys(EVENT_CODES)), fc.stringMatching(/^[A-Z]{3}$/));
    const name = fc.oneof(fc.constantFrom(...Object.keys(NAME_ALIASES)), fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,30}$/));
    fc.assert(fc.property(code, name, (c, n) => unknownKinds([kindOf(withEvent(c, n))]).length === 0));
    // No table knows the event, so the report has the kind of its CAP category, Safety.
    expect(kindOf(withEvent("ZZZ", "No Such Event"))).toBe("safety");
  });
});
