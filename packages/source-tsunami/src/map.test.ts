import { readFileSync } from "node:fs";
import { incidents, knownKind, linesAt, matchPlaces, normalize, observationId, reportId, type Observation, type PlaceId, type Report, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { TSUNAMI_CENTERS, type TsunamiCenter } from "./centers.ts";
import { mapObservation, TSUNAMI_KIND } from "./map.ts";

const NTWC = TSUNAMI_CENTERS.ntwc;
const PTWC = TSUNAMI_CENTERS.ptwc;

/** This function reads a real message of a center from `fixtures/` (`fixtures/README.md`). */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const observe = (body: string, center: TsunamiCenter = NTWC): Observation => ({
  id: observationId({ source: center.id, contentType: "text/xml", url: `https://www.tsunami.gov${center.path}`, body }),
  source: center.id,
  fetched: 0,
  contentType: "text/xml",
  body,
  transport: { url: `https://www.tsunami.gov${center.path}`, status: 200, latency: 0 },
});

/** This function maps a fixture, and fails the test for a problem that is not a note. */
const reportsOf = (name: string, center: TsunamiCenter = NTWC): readonly Report[] => {
  const result = mapObservation(observe(fixture(name), center), center);
  expect(result.problems.filter((problem) => problem.fatal || problem.lossy === true)).toEqual([]);
  return result.reports;
};

const codesOf = (report: Report): string[] => report.areas.flatMap((area) => (area.type === "code" ? [`${area.system}:${area.code}`] : []));

/** The bulletins 1, 2 and 35 of the NTWC event `t06p1k`: the M8.8 earthquake off Kamchatka of 2025-07-29. */
const BULLETINS = ["t06p1k-1.xml", "t06p1k-2.xml", "t06p1k-35.xml"] as const;

/** This function gives a place of the tests at one zone of a coast of a bulletin. The zones are public zones of the NWS. */
const placeAt = (code: string): WatchedPlace => ({ id: code as PlaceId, codes: [{ system: "ugc", code }], bufferKm: 0 });

describe("mapObservation", () => {
  it("maps the latest statement of each center to one report of the kind Tsunami Information, from the NWS", () => {
    const ntwc = mapObservation(observe(fixture("PAAQCAP-20261116T1134Z.xml")), NTWC);
    const ptwc = mapObservation(observe(fixture("PHEBCAP-20261116T1134Z.xml"), PTWC), PTWC);
    for (const [result, center, key] of [
      [ntwc, NTWC, "PAAQ-1-togrrv"],
      [ptwc, PTWC, "PHEB-1-26317050"],
    ] as const) {
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0]).toMatchObject({
        key,
        source: center.id,
        origin: "nws",
        op: "alert",
        kind: { code: TSUNAMI_KIND, significance: "statement", label: "Tsunami Information" },
      });
      // A statement has no zone: its only area is a circle of radius 0 at the epicenter.
      expect(result.reports[0]?.areas.map((area) => area.type)).toEqual(["circle"]);
    }
    // The statement of NTWC expires before its sent time. The map keeps the value, with a note.
    expect(ntwc.problems).toEqual([{ path: "info[0].expires", message: "the expires time is before the sent time, so the report is not live", fatal: false }]);
    expect(ptwc.problems).toEqual([]);
  });

  it("maps bulletin 2 to a warning, an advisory and a watch, each with its own zones and VTEC", () => {
    const reports = reportsOf("t06p1k-2.xml");
    const sent = Date.parse("2025-07-30T00:19:26Z");
    expect(reports.map((report) => report.id)).toEqual([0, 1, 2].map((index) => reportId({ source: NTWC.id, key: "PAAQ-2-t06p1k", sent, part: `info[${String(index)}]` })));
    expect(reports.map((report) => report.kind.significance)).toEqual(["warning", "advisory", "watch"]);
    expect(reports.map((report) => report.severity)).toEqual(["extreme", "moderate", "moderate"]);
    expect(reports.map((report) => report.correlation.filter((key) => key.system === "vtec").map((key) => key.id))).toEqual([["PAAQ.TS.W.0016.2025"], ["PAAQ.TS.Y.0016.2025"], ["PAAQ.TS.A.0016.2025"]]);
    expect(reports.map((report) => codesOf(report).length)).toEqual([3, 2, 75]);
    expect(reports.every((report) => report.references.length === 1 && knownKind(report.kind.code))).toBe(true);
    // The areas are not keyed, so the circle at the epicenter does not decide for the zones.
    expect(reports.flatMap((report) => report.areas.filter((area) => area.type !== "place" && area.block !== undefined))).toEqual([]);
  });

  it("joins the bulletins of one event in one incident, and the last bulletin ends the alert at each zone", () => {
    const [first, second, last] = BULLETINS.map((name) => reportsOf(name));
    const warned = placeAt("AKZ787");
    const watched = placeAt("CAZ043");

    const early = incidents(normalize({ reports: [...first!, ...second!] }), Date.parse("2025-07-30T00:30:00Z"));
    expect(early).toHaveLength(1);
    expect(early[0]?.live).toBe(true);
    expect(matchPlaces(early[0]!, [warned, watched])).toHaveLength(2);
    // Each place gets the line of its own block: the warning at one zone, the watch at the other.
    expect(linesAt(early[0]!, warned).map((line) => line.kind.significance)).toEqual(["warning"]);
    expect(linesAt(early[0]!, watched).map((line) => line.kind.significance)).toEqual(["watch"]);

    // Bulletin 35 references the 34 earlier bulletins. Its only area is the circle at the epicenter.
    expect(last?.[0]?.references).toHaveLength(34);
    const all = [...first!, ...second!, ...last!];
    const ended = incidents(normalize({ reports: all }), Date.parse("2025-07-31T14:27:00Z"));
    expect(ended).toHaveLength(1);
    expect(matchPlaces(ended[0]!, [warned, watched])).toEqual([]);
    expect(incidents(normalize({ reports: all }), Date.parse("2025-07-31T16:30:00Z"))[0]?.live).toBe(false);
  });

  it("gives a fatal problem for a body that is not CAP, and does not throw", () => {
    const result = mapObservation(observe("<!DOCTYPE html><html><body><p>moved</p></body></html>"), NTWC);
    expect(result.reports).toEqual([]);
    expect(result.problems.map((problem) => problem.fatal)).toEqual([true]);
  });
});
