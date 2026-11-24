import { readFileSync } from "node:fs";

import { DEFAULT_ASSESS_POLICY, observationId, tableLevel, type Observation } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import { CONFLICT_KIND, GDELT_CREDIT, mapObservation, PLACE_RADIUS_KM, REPORT_LIFE_MS, severityOf, SOURCE_ID, UNREST_KIND, cameoLabel } from "./map.ts";
import { eventBody, eventOf, keepEvent } from "./row.ts";

const lines = readFileSync(new URL("../fixtures/events-20261123200000.tsv", import.meta.url), "utf8").trim().split("\n");
const fetched = Date.UTC(2026, 10, 23, 20, 5, 0);

function observe(body: string): Observation {
  const contentType = "application/json";
  return { id: observationId({ source: SOURCE_ID, contentType, body }), source: SOURCE_ID, fetched, contentType, body, transport: { latency: 0 } };
}

const kept = lines.map((line) => eventOf(line)!).filter(keepEvent);

describe("mapObservation", () => {
  it("gives one report for each kept real event", () => {
    const results = kept.map((event) => mapObservation(observe(eventBody(event))));
    expect(results.every((result) => result.problems.length === 0 && result.reports.length === 1)).toBe(true);
    const reports = results.map((result) => result.reports[0]!);
    expect(reports.map((report) => [report.kind.code, report.severity, report.headline])).toEqual([
      [UNREST_KIND, "moderate", "Violent protest or riot in Dhaka, Dhaka, Bangladesh"],
      [CONFLICT_KIND, "moderate", "Fighting in Port-Au-Prince, Ouest, Haiti"],
      [CONFLICT_KIND, "moderate", "Fighting with small arms in Gaza, Israel (general), Israel"],
    ]);
    const haiti = reports[1]!;
    const sent = Date.UTC(2026, 10, 23, 20, 0, 0);
    expect(haiti).toMatchObject({
      source: SOURCE_ID,
      key: "1334657169",
      certainty: "possible",
      urgency: "past",
      response: ["monitor"],
      sent,
      received: fetched,
      effective: Date.UTC(2026, 10, 23),
      expires: sent + REPORT_LIFE_MS,
      web: "https://haitiantimes.com/2026/11/23/what-are-haiti-security-forces/",
    });
    expect(haiti.areas).toEqual([{ type: "circle", center: [kept[1]!.lon, kept[1]!.lat], radiusKm: PLACE_RADIUS_KM }]);
    expect(haiti.description).toContain("Actors: SECURITY FORCE, GANG.");
    expect(haiti.description).toContain("It is not a confirmed report.");
    expect(haiti.parameters?.["credit"]).toEqual([GDELT_CREDIT]);
    expect(haiti.parameters?.["country"]).toEqual(["HA"]);
  });

  // A machine codes these events from the news, and some codes are wrong. A report of GDELT alone sends no push.
  it("gives each report the digest at most under the first policy, also mass violence", () => {
    const reports = kept.map((event) => mapObservation(observe(eventBody(event))).reports[0]!);
    const worst = { ...reports[0]!, severity: severityOf("202", "20") };
    expect(worst.severity).toBe("severe");
    for (const report of [...reports, worst]) expect(tableLevel(DEFAULT_ASSESS_POLICY, report).level).toBe("digest");
  });

  it("gives the same report id for the same event", () => {
    const body = eventBody(kept[0]!);
    expect(mapObservation(observe(body)).reports[0]!.id).toBe(mapObservation(observe(body)).reports[0]!.id);
  });

  it("gives a fatal problem and no report for a body that it does not understand", () => {
    for (const body of ["not json", "[]", JSON.stringify({ id: "1" })]) {
      const result = mapObservation(observe(body));
      expect(result.reports).toEqual([]);
      expect(result.problems[0]?.fatal).toBe(true);
    }
    const unreported = mapObservation(observe(eventBody(eventOf(lines[0]!)!)));
    expect(unreported.reports).toEqual([]);
    expect(unreported.problems.map((problem) => problem.path)).toEqual(["root"]);
    const noPoint = JSON.parse(eventBody(kept[0]!)) as Record<string, unknown>;
    noPoint["lat"] = null;
    expect(mapObservation(observe(JSON.stringify(noPoint))).problems.map((problem) => problem.path)).toEqual(["lat"]);
  });
});

describe("severityOf and cameoLabel", () => {
  it("rates mass violence severe, a riot, an assault and a fight moderate, and other protests minor", () => {
    expect([severityOf("202", "20"), severityOf("1451", "14"), severityOf("182", "18"), severityOf("190", "19"), severityOf("141", "14")]).toEqual([
      "severe",
      "moderate",
      "moderate",
      "moderate",
      "minor",
    ]);
  });

  it("falls back to the label of the first three digits, then of the root", () => {
    expect([cameoLabel("1451", "14"), cameoLabel("149", "14"), cameoLabel("999", "99")]).toEqual(["Violent protest or riot", "Protest", "Event 999"]);
  });
});
