import type { Observation, ObservationId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countBody, mapObservation, NDW_AREA, publishedOf, SERIES, SOURCE_ID, type GroupCounts } from "./map.ts";

const AT = Date.parse("2026-11-25T01:12:00.002Z");
const GROUPS: GroupCounts = { accident: 3, congestion: 4, obstruction: 1, closure: 2, works: 9, conditions: 0, other: 5 };

const observe = (body: string): Observation => ({ id: "o1" as ObservationId, source: SOURCE_ID, fetched: AT + 30_000, contentType: "application/json", body, transport: { latency: 1 } });

describe("countBody", () => {
  it("gives the fields in their order, the groups in the order of RECORD_GROUPS and the sum of the groups", () => {
    const shuffled: GroupCounts = { other: 5, works: 9, accident: 3, closure: 2, congestion: 4, conditions: 0, obstruction: 1 };
    expect(countBody(AT, "nl", shuffled, 1, 2)).toBe(
      '{"published":"2026-11-25T01:12:00.002Z","country":"nl","license":"CC0 1.0","records":24,"groups":{"accident":3,"congestion":4,"obstruction":1,"closure":2,"works":9,"conditions":0,"other":5},"unreal":1,"faults":2}',
    );
    expect(publishedOf(countBody(AT, "nl", GROUPS, 0, 0))).toBe(AT);
  });
});

describe("publishedOf", () => {
  it("gives undefined for a body that is not one publication", () => {
    for (const body of ["", "[]", "{}", '{"published":"yesterday"}', '{"published":"2026-11-25T01:12:00Z"}', '{"published":12}']) expect(publishedOf(body), body).toBeUndefined();
  });
});

describe("mapObservation", () => {
  it("gives one reading of the country for each measure, at the time of the publication, and no report", () => {
    const mapped = mapObservation(observe(countBody(AT, "nl", GROUPS, 0, 0)));
    expect(mapped.reports).toEqual([]);
    expect(mapped.problems).toEqual([]);
    const expected: [string, number][] = [
      ["records", 24],
      ["accidents", 3],
      ["congestion", 4],
      ["obstructions", 1],
      ["closures", 2],
      ["works", 9],
      ["conditions", 0],
    ];
    expect(mapped.readings).toEqual(expected.map(([measure, value]) => ({ source: SOURCE_ID, measure, series: SERIES, at: AT, value, area: NDW_AREA, observation: "o1" })));
  });

  it("gives a problem that is not fatal for records with a fault, and keeps the readings", () => {
    const mapped = mapObservation(observe(countBody(AT, "nl", GROUPS, 0, 3)));
    expect(mapped.problems.map((problem) => [problem.path, problem.fatal])).toEqual([["faults", false]]);
    expect(mapped.problems[0]?.message).toContain("3 records");
    expect(mapped.readings?.length).toBe(7);
  });

  it("gives a fatal problem and no reading for a body of another country, another license, a bad count or a bad sum", () => {
    const good = JSON.parse(countBody(AT, "nl", GROUPS, 0, 0)) as Record<string, unknown>;
    const bodies = [
      "not json",
      "[]",
      JSON.stringify({ ...good, country: "be" }),
      JSON.stringify({ ...good, license: "CC BY 4.0" }),
      JSON.stringify({ ...good, published: "now" }),
      JSON.stringify({ ...good, records: 23 }),
      JSON.stringify({ ...good, groups: { ...GROUPS, accident: -1 } }),
      JSON.stringify({ ...good, groups: { ...GROUPS, works: 1.5 } }),
      JSON.stringify({ ...good, groups: { accident: 3 } }),
    ];
    for (const body of bodies) {
      const mapped = mapObservation(observe(body));
      expect(mapped.readings, body).toBeUndefined();
      expect(mapped.problems.some((problem) => problem.fatal), body).toBe(true);
    }
  });

  it("gives back the counts of each body of countBody, and does not throw for any text", () => {
    const count = fc.nat(10_000);
    fc.assert(
      fc.property(fc.record({ accident: count, congestion: count, obstruction: count, closure: count, works: count, conditions: count, other: count }), (groups) => {
        const values = new Map(mapObservation(observe(countBody(AT, "nl", groups, 0, 0))).readings?.map((reading) => [reading.measure, reading.value]));
        expect(values.get("records")).toBe(Object.values(groups).reduce((a, b) => a + b, 0));
        expect(values.get("closures")).toBe(groups.closure);
      }),
    );
    fc.assert(fc.property(fc.string(), (text) => void expect(() => mapObservation(observe(text))).not.toThrow()));
  });
});
