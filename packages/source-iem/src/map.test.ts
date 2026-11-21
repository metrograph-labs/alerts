import { readFileSync } from "node:fs";
import { incidents, knownKind, normalize, observationId, UNKNOWN_KIND, unknownKinds, type Observation, type ObservationId, type Report } from "@mark1russell7/alerts";
import { NWS_ORIGIN, PHENOMENA, SIGNIFICANCE, vtecKey, parseVtec, type Vtec } from "@mark1russell7/alerts-format-nws";
import { mapObservation as mapNwsApi, SOURCE_ID as NWS_API_SOURCE } from "@mark1russell7/alerts-source-nws-api";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readAnswer, rowBody } from "./fetch.ts";
import { EVENT_PAGE, mapObservation, SOURCE_ID } from "./map.ts";

const fixture = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
/** The real list of IEM at the time of a flash flood warning of a Texas office, cut to the rows of TX and KS. */
const LIST_0108 = fixture("../fixtures/county-zone-20261108T1930Z.json");
const LIST_1115 = fixture("../fixtures/county-zone-20261115T1320Z.json");
/** The real NWS API copy of the NEW message of the same warning. Its home is the package `format-cap`. */
const NWS_NEW = fixture("../../format-cap/fixtures/pairs/kewx-ff-w-0108-new.nws-api.json");

const URL_OF_LIST = "https://mesonet.agron.iastate.edu/api/1/vtec/county_zone.json";
const FETCHED = Date.parse("2026-11-08T19:30:00Z");
const reply = (body: string) => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body });

/** This function gives the observations of a list, as the fetch makes them, for all states. */
const observationsOf = (list: string, fetched = FETCHED): Observation[] => readAnswer(reply(list), URL_OF_LIST, fetched, 40, undefined)?.observations ?? [];

/** This function makes the observation of one row, as the fetch makes it. */
const observationOfRow = (row: unknown, fetched = FETCHED): Observation => {
  const body = rowBody(row);
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_LIST, body }), source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } };
};

const mapOne = (observation: Observation): Report => {
  const result = mapObservation(observation);
  expect(result.problems).toEqual([]);
  expect(result.reports).toHaveLength(1);
  return result.reports[0] as Report;
};

/** A real row of the list: the warning of the Texas office in one county. */
const ROW = {
  index: 788,
  utc_product_issue: "2026-11-08T19:23:00Z",
  utc_issue: "2026-11-08T19:23:00Z",
  utc_expire: "2026-11-08T23:13:00Z",
  ph_sig: "FF.W",
  wfo: "EWX",
  eventid: 108,
  phenomena: "FF",
  significance: "W",
  ugc: "TXC019",
  nws_color: "#8B0000",
  event_label: "Flash Flood Warning",
};

describe("mapObservation", () => {
  it("maps each real row of the two lists to one report, with no problem and a known kind", () => {
    for (const list of [LIST_0108, LIST_1115]) {
      const observations = observationsOf(list);
      expect(observations.length).toBeGreaterThan(50);
      const reports = observations.map(mapOne);
      expect(unknownKinds(reports.map((report) => report.kind.code))).toEqual([]);
      for (const report of reports) {
        expect(report).toMatchObject({ source: SOURCE_ID, origin: NWS_ORIGIN, status: "actual", op: "alert", severity: "unknown", urgency: "unknown", certainty: "unknown" });
        expect(report.correlation).toHaveLength(1);
      }
    }
  });

  it("gives the VTEC key, the areas, the times and the page of the event", () => {
    const observation = observationOfRow(ROW);
    const report = mapOne(observation);
    expect(report.correlation).toEqual([{ system: "vtec", id: "KEWX.FF.W.0108.2026" }]);
    expect(report.key).toBe(`KEWX.FF.W.0108.2026.TXC019@${observation.id}`);
    expect(report.kind).toEqual({ code: report.kind.code, significance: "warning", label: "Flash Flood Warning" });
    expect(knownKind(report.kind.code)).toBe(true);
    expect(report.areas).toEqual([
      { type: "code", system: "ugc", code: "TXC019" },
      { type: "code", system: "same", code: "048019" },
    ]);
    expect(report).toMatchObject({
      sent: Date.parse("2026-11-08T19:23:00Z"),
      onset: Date.parse("2026-11-08T19:23:00Z"),
      expires: Date.parse("2026-11-08T23:13:00Z"),
      ends: Date.parse("2026-11-08T23:13:00Z"),
      received: FETCHED,
      sender: "KEWX",
      headline: "Flash Flood Warning by KEWX",
      web: `${EVENT_PAGE}2026-O-NEW-KEWX-FF-W-0108`,
      observation: observation.id,
    });
  });

  it("gives a zone only its UGC code, and an office of Alaska its own VTEC id", () => {
    const report = mapOne(observationOfRow({ ...ROW, wfo: "AFC", phenomena: "WS", significance: "A", eventid: 7, ugc: "AKZ101" }));
    expect(report.areas).toEqual([{ type: "code", system: "ugc", code: "AKZ101" }]);
    expect(report.correlation).toEqual([{ system: "vtec", id: "PAFC.WS.A.0007.2026" }]);
  });

  it("gives a zone of a fire weather event a fire zone code, and a county of that event its county code (AL-33)", () => {
    const fire = { ...ROW, wfo: "ICT", phenomena: "FW", significance: "W", eventid: 4, ph_sig: "FW.W", event_label: "Red Flag Warning" };
    expect(mapOne(observationOfRow({ ...fire, ugc: "KSZ083" })).areas).toEqual([{ type: "code", system: "ugc-fire", code: "KSZ083" }]);
    expect(mapOne(observationOfRow({ ...fire, ugc: "KSC173" })).areas).toEqual([
      { type: "code", system: "ugc", code: "KSC173" },
      { type: "code", system: "same", code: "020173" },
    ]);
  });

  it("gives the year of the earlier time of the row: the start or the product", () => {
    const kansas = { ...ROW, wfo: "TOP", phenomena: "WS", significance: "W", eventid: 3, ugc: "KSZ083", utc_expire: "2026-01-02T18:00:00Z" };
    // A start in the old year and a product in the new year
    const started = mapOne(observationOfRow({ ...kansas, utc_issue: "2025-12-31T22:00:00Z", utc_product_issue: "2026-01-01T03:00:00Z" }));
    expect(started.correlation).toEqual([{ system: "vtec", id: "KTOP.WS.W.0003.2025" }]);
    expect(started.web).toBe(`${EVENT_PAGE}2025-O-NEW-KTOP-WS-W-0003`);
    // A product in the old year with a start in the new year, as in section 2.1.6 of NWS Directive 10-1703
    const early = mapOne(observationOfRow({ ...kansas, utc_issue: "2026-01-02T00:00:00Z", utc_product_issue: "2025-12-31T21:00:00Z" }));
    expect(early.correlation).toEqual([{ system: "vtec", id: "KTOP.WS.W.0003.2025" }]);
  });

  it("gives no end for a row with no end", () => {
    const report = mapOne(observationOfRow({ ...ROW, utc_expire: null }));
    expect(report.expires).toBeUndefined();
    expect(report.ends).toBeUndefined();
  });

  it.each([
    ["wfo", "KEWX"],
    ["phenomena", "F"],
    ["significance", "w"],
    ["eventid", 0],
    ["eventid", "108"],
    ["ugc", "TX019"],
    ["utc_issue", null],
    ["utc_product_issue", "yesterday"],
  ])("makes no report when the field %s is %j", (field, value) => {
    const result = mapObservation(observationOfRow({ ...ROW, [field]: value }));
    expect(result.reports).toEqual([]);
    expect(result.problems.some((problem) => problem.fatal && problem.path === field)).toBe(true);
  });

  it("tells of a body that is not JSON, and of a body that is not a row", () => {
    const bad = (body: string) => mapObservation({ ...observationOfRow(ROW), body });
    expect(bad("{").problems).toEqual([{ path: "", message: "the body is not JSON", fatal: true }]);
    expect(bad(JSON.stringify({ error: "the database is down" })).problems[0]).toMatchObject({ fatal: true, message: expect.stringContaining("not a row") });
    expect(bad("[]").reports).toEqual([]);
  });
});

describe("the key of a report", () => {
  const rows = fc.record({
    wfo: fc.constantFrom("EWX", "TOP", "ICT", "AFC"),
    phenomena: fc.constantFrom("FF", "TO", "WS", "FG"),
    significance: fc.constantFrom("W", "A", "Y"),
    eventid: fc.integer({ min: 1, max: 9999 }),
    ugc: fc.constantFrom("TXC019", "TXZ205", "KSC173", "KSZ083"),
    utc_issue: fc.constantFrom("2026-11-08T19:23:00Z", "2026-11-08T19:23:00+00:00", "2026-12-31T23:00:00Z"),
    utc_expire: fc.constantFrom("2026-11-08T23:13:00Z", "2026-11-09T05:54:00Z", null),
    utc_product_issue: fc.constantFrom("2026-11-08T19:23:00Z", "2026-11-08T19:46:00Z"),
  });

  it("is new for each new body, so a row that changes never takes the report of the old row", () => {
    fc.assert(
      fc.property(rows, rows, (a, b) => {
        const one = mapOne(observationOfRow(a));
        const two = mapOne(observationOfRow(b));
        expect(one.id === two.id).toBe(rowBody(a) === rowBody(b));
      }),
    );
  });

  it("does not change with the fields that the body does not keep", () => {
    const one = mapOne(observationOfRow(ROW));
    const two = mapOne(observationOfRow({ ...ROW, index: 12, nws_color: "#000000", event_label: "Flash Flood Warning (changed)", added: true }));
    expect(two.id).toBe(one.id);
  });
});

describe("the gate of the taxonomy", () => {
  it("gives a known code for each VTEC phenomenon and significance of the tables", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(PHENOMENA)), fc.constantFrom(...Object.keys(SIGNIFICANCE)), (phenomena, significance) => {
        const report = mapOne(observationOfRow({ ...ROW, phenomena, significance }));
        expect(unknownKinds([report.kind.code])).toEqual([]);
      }),
    );
  });

  it("gives the unknown kind, and a lossy problem, for a phenomenon that the tables do not know", () => {
    const result = mapObservation(observationOfRow({ ...ROW, phenomena: "ZZ" }));
    expect(result.reports[0]?.kind).toEqual({ code: UNKNOWN_KIND, label: "ZZ.W" });
    expect(result.problems).toEqual([{ path: "phenomena", message: expect.stringContaining("ZZ.W") as string, fatal: false, lossy: true }]);
  });
});

describe("the IEM copy and the NWS API copy of one event, in the core", () => {
  const nwsObservation: Observation = {
    id: "observation-nws-api" as ObservationId,
    source: NWS_API_SOURCE,
    fetched: FETCHED - 60_000,
    contentType: "application/geo+json",
    body: NWS_NEW,
    transport: { latency: 0 },
  };

  it("are one incident with one origin, and the level of the NWS API copy", () => {
    const nws = mapNwsApi(nwsObservation).reports;
    expect(nws).toHaveLength(1);
    const iem = observationsOf(LIST_0108)
      .map(mapOne)
      .filter((report) => report.sender === "KEWX");
    expect(iem).toHaveLength(7);
    const vtec = parseVtec((JSON.parse(NWS_NEW) as { properties: { parameters: { VTEC: string[] } } }).properties.parameters.VTEC[0] ?? "") as Vtec;
    expect(iem.every((report) => report.correlation[0]?.id === vtecKey(vtec, report.sent).id)).toBe(true);

    const all = incidents(normalize({ reports: [...nws, ...iem] }), FETCHED);
    expect(all).toHaveLength(1);
    const [incident] = all;
    expect(incident).toMatchObject({ live: true, corroboration: 1, severity: "severe", urgency: "immediate", certainty: "likely" });
    expect(incident?.reports).toHaveLength(8);
    // The IEM copies alone give an incident of the same event with an unknown level
    expect(incidents(normalize({ reports: iem }), FETCHED)[0]).toMatchObject({ live: true, corroboration: 1, severity: "unknown" });
  });

  // A false end of the IEM rows is safe only while the NWS API copy stays a head. The rows replace that
  // copy when they are later and together name each of its codes. This gate holds the tie of the two times.
  it("stay live when each IEM row of the event ends, because the rows and the NWS API copy of one product have the same sent time", () => {
    const [api] = mapNwsApi(nwsObservation).reports;
    expect(api).toBeDefined();
    // The NWS API copy also has the key of its CAP message. An IEM row has only the VTEC key.
    const vtec = api?.correlation.filter((key) => key.system === "vtec");
    expect(vtec).toHaveLength(1);
    const rows = observationsOf(LIST_0108)
      .map(mapOne)
      .filter((report) => report.correlation.some((key) => key.id === vtec?.[0]?.id));
    expect(rows.map((row) => row.areas.find((area) => area.type === "code" && area.system === "ugc"))).toContainEqual({ type: "code", system: "ugc", code: "TXC137" });
    for (const row of rows) expect([row.origin, row.sent, row.correlation]).toEqual([api?.origin, api?.sent, vtec]);
    // The rows together name each code of the message, so only the tie keeps the message a head.
    const codes = (reports: readonly Report[]): string[] => [...new Set(reports.flatMap((report) => report.areas.flatMap((area) => (area.type === "code" ? [`${area.system}:${area.code}`] : []))))].sort();
    expect(codes(rows)).toEqual(codes(api === undefined ? [] : [api]));

    const ended = FETCHED + 4 * 60_000;
    const ends = rows.map((row) => ({ report: row.id, at: ended, ended: true }));
    expect(incidents(normalize({ reports: [...(api === undefined ? [] : [api]), ...rows], ends }), ended + 60_000)).toMatchObject([{ live: true, severity: "severe" }]);
    // The rows alone end with the list.
    expect(incidents(normalize({ reports: rows, ends }), ended + 60_000)).toMatchObject([{ live: false }]);
  });
});
