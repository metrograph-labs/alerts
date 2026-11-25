import { readFileSync } from "node:fs";
import { incidents, normalize, observationId, type Observation, type Report } from "@mark1russell7/alerts";
import { GEOMAGNETIC_STORM_KIND, geomagneticLevel, POLEWARD_BY_LEVEL, SEVERITY_BY_LEVEL } from "@mark1russell7/alerts-space-weather";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entryBody, runsOf, type Entry } from "./fetch.ts";
import { GFZ_CREDIT, GFZ_ORIGIN, GFZ_SENDER, INTERVAL_MS, INTERVAL_SYSTEM, intervalStart, intervalText, mapObservation, REPORT_LIFE_MS, RUN_SYSTEM, SOURCE_ID } from "./map.ts";

/** The real answer of the storm of May 2024 (`fixtures/README.md`). */
const STORM = JSON.parse(readFileSync(new URL("../fixtures/kp-20240510-20240512.json", import.meta.url), "utf8")) as { Kp: number[]; datetime: string[]; status: string[] };
const ENTRIES: Entry[] = STORM.datetime.map((datetime, index) => ({ datetime, Kp: STORM.Kp[index], status: STORM.status[index] }));

const SERIES = "https://kp.gfz.test/app/json/?index=Kp";

/** This function gives the observation of one body, as the fetch gives it. */
const observationOf = (body: string, fetched: number): Observation => ({
  id: observationId({ source: SOURCE_ID, contentType: "application/json", url: SERIES, body }),
  source: SOURCE_ID,
  fetched,
  contentType: "application/json",
  body,
  transport: { url: SERIES, status: 200, latency: 1 },
});

/** The observations of each interval of the storm, with their runs, each fetched one hour after the start of its interval. */
const STORM_OBSERVATIONS = runsOf(ENTRIES).map(({ start, entry, run }) => observationOf(entryBody(entry, run), start + 3_600_000));

const reportsOf = (observations: readonly Observation[]): Report[] => observations.flatMap((observation) => mapObservation(observation).reports);

describe("mapObservation", () => {
  it("gives one report for each interval of G1 or more of the storm of May 2024, and no problem", () => {
    const results = STORM_OBSERVATIONS.map(mapObservation);
    expect(results.flatMap((result) => result.problems)).toEqual([]);
    const reported = results.flatMap((result) => result.reports.map((report) => report.parameters["interval"]![0]));
    expect(reported).toEqual(ENTRIES.filter((entry) => geomagneticLevel(entry["Kp"] as number)! >= 1).map((entry) => entry.datetime));
    expect(reported).toHaveLength(14);
  });

  it("gives the facts of the first interval of the storm: Kp 8- is G4", () => {
    const [report] = reportsOf(STORM_OBSERVATIONS.filter((observation) => observation.body.includes('"2024-05-10T15:00:00Z","Kp"')));
    const start = Date.parse("2024-05-10T15:00:00Z");
    expect(report).toMatchObject({
      source: SOURCE_ID,
      origin: GFZ_ORIGIN,
      references: [],
      correlation: [{ system: RUN_SYSTEM, id: "2024-05-10T15:00:00Z" }],
      status: "actual",
      op: "alert",
      kind: { code: GEOMAGNETIC_STORM_KIND, label: "Geomagnetic storm" },
      categories: ["geo"],
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      sent: start + 3_600_000,
      received: start + 3_600_000,
      onset: start,
      expires: start + REPORT_LIFE_MS,
      areaText: "Poleward of 45 degrees geomagnetic latitude",
      sender: GFZ_SENDER,
      headline: "Geomagnetic storm G4: Kp 8- from 15:00 to 18:00 UTC on 2024-05-10",
      parameters: { kp: ["8-"], scale: ["G4"], interval: ["2024-05-10T15:00:00Z"], run: ["2024-05-10T15:00:00Z"], polewardOf: ["45"], status: ["definitive"], credit: [GFZ_CREDIT], license: ["CC BY 4.0"] },
    });
    expect(report?.key).toBe(`2024-05-10T15:00:00Z@${report?.observation}`);
    expect(report?.areas.filter((area) => area.type === "circle")).toHaveLength(2);
    expect(report?.areas.at(-1)).toEqual({ type: "code", system: INTERVAL_SYSTEM, code: "2024-05-10T15:00:00Z", block: "caps" });
  });

  it("gives the level, the severity and the caps of each value of the NOAA table: 9- is G4 and 9 is G5", () => {
    const at = Date.parse("2024-05-10T18:00:00Z");
    const facts = [7.667, 8.667, 9].map((Kp) => reportsOf([observationOf(entryBody({ datetime: intervalText(at), Kp, status: "def" }, at), at)])[0]);
    expect(facts.map((report) => [report?.parameters["kp"]?.[0], report?.parameters["scale"]?.[0], report?.severity, report?.parameters["polewardOf"]?.[0]])).toEqual([
      ["8-", "G4", SEVERITY_BY_LEVEL[4], String(POLEWARD_BY_LEVEL[4])],
      ["9-", "G4", SEVERITY_BY_LEVEL[4], String(POLEWARD_BY_LEVEL[4])],
      ["9", "G5", "extreme", String(POLEWARD_BY_LEVEL[5])],
    ]);
  });

  it("gives no report and no problem for a value below G1, and the urgency past for an interval that ended", () => {
    const at = Date.parse("2026-11-16T21:00:00Z");
    expect(mapObservation(observationOf(entryBody({ datetime: intervalText(at), Kp: 4.333, status: "pre" }), at))).toEqual({ reports: [], problems: [] });
    const [late] = reportsOf([observationOf(entryBody({ datetime: intervalText(at), Kp: 5, status: "pre" }, at), at + INTERVAL_MS)]);
    expect(late).toMatchObject({ urgency: "past", severity: "minor", parameters: { kp: ["5"], scale: ["G1"], status: ["preliminary"] } });
  });

  it("joins the intervals of one run in one incident, and keeps two runs apart", () => {
    const reports = reportsOf(STORM_OBSERVATIONS);
    const at = Date.parse("2024-05-12T23:00:00Z");
    const found = incidents(normalize({ reports }), at);
    expect(found.map((incident) => incident.reports.length).sort((a, b) => a - b)).toEqual([1, 13]);
    const runs = new Set(reports.map((report) => report.correlation[0]?.id));
    expect([...runs].sort()).toEqual(["2024-05-10T15:00:00Z", "2024-05-12T21:00:00Z"]);
  });

  it("replaces the earlier value of one interval with the later value at once, by the rule of the copies", () => {
    const start = Date.parse("2024-05-10T15:00:00Z");
    const first = observationOf(entryBody({ datetime: intervalText(start), Kp: 5.333, status: "pre" }, start), start + 600_000);
    const later = observationOf(entryBody({ datetime: intervalText(start), Kp: 7.667, status: "pre" }, start), start + 1_200_000);
    const reports = reportsOf([first, later]);
    expect(reports.map((report) => report.id)).toHaveLength(2);
    expect(new Set(reports.map((report) => report.id)).size).toBe(2);
    const [incident] = incidents(normalize({ reports }), start + 1_800_000);
    expect(incident).toMatchObject({ severity: "severe", live: true });
    expect(incident?.lines).toBeUndefined();
  });

  it("gives the same reports with the same ids for the same observation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 27 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 4 }), (thirds, slot, back) => {
        const start = slot * INTERVAL_MS;
        const observation = observationOf(entryBody({ datetime: intervalText(start), Kp: Math.round((thirds / 3) * 1000) / 1000, status: "pre" }, start - back * INTERVAL_MS), start + 60_000);
        const once = mapObservation(observation);
        expect(mapObservation(observation)).toEqual(once);
        expect(once.reports.length).toBe(thirds >= 14 ? 1 : 0);
        expect(once.problems).toEqual([]);
      }),
    );
  });

  it("gives a fatal problem and no report for a body that is not one interval", () => {
    const fatal = (body: string) => mapObservation(observationOf(body, 0)).problems.map((problem) => [problem.path, problem.fatal]);
    expect(fatal("{")).toEqual([["", true]]);
    expect(fatal(JSON.stringify({ Kp: [1], datetime: ["2026-11-16T00:00:00Z"], meta: { license: "other" } }))).toEqual([["", true]]);
    expect(fatal(JSON.stringify({ datetime: "2026-11-16T04:00:00Z", Kp: 5, status: "pre" }))).toEqual([["datetime", true]]);
    expect(fatal(JSON.stringify({ datetime: "2026-11-31T00:00:00Z", Kp: 5, status: "pre" }))).toEqual([["datetime", true]]);
    for (const Kp of [9.333, -1, "5", null]) expect(fatal(JSON.stringify({ datetime: "2026-11-16T03:00:00Z", Kp, status: "pre" })), String(Kp)).toEqual([["Kp", true]]);
  });

  it("gives a lossy problem and a report for an unknown status or a wrong run", () => {
    const at = Date.parse("2026-11-16T03:00:00Z");
    const unknownStatus = mapObservation(observationOf(JSON.stringify({ datetime: intervalText(at), Kp: 6, status: "est", run: intervalText(at) }), at));
    expect(unknownStatus.problems.map((problem) => [problem.path, problem.lossy])).toEqual([["status", true]]);
    expect(unknownStatus.reports[0]?.parameters["status"]).toBeUndefined();
    for (const run of [undefined, intervalText(at + INTERVAL_MS), "soon"]) {
      const result = mapObservation(observationOf(JSON.stringify({ datetime: intervalText(at), Kp: 6, status: "pre", run }), at));
      expect(result.problems.map((problem) => [problem.path, problem.lossy]), String(run)).toEqual([["run", true]]);
      expect(result.reports[0]?.correlation).toEqual([{ system: RUN_SYSTEM, id: intervalText(at) }]);
    }
  });
});

describe("intervalStart", () => {
  it("reads only the start of a 3-hour interval in UTC", () => {
    expect(intervalStart("2024-05-10T15:00:00Z")).toBe(Date.parse("2024-05-10T15:00:00Z"));
    for (const text of ["2024-05-10T16:00:00Z", "2024-05-10T15:30:00Z", "2024-05-10T15:00:00.000Z", "2024-05-10T15:00:00+00:00", "2024-02-30T00:00:00Z", 1715353200000]) {
      expect(intervalStart(text), String(text)).toBeUndefined();
    }
  });
});
