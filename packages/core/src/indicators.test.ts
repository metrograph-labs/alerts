import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import {
  DIMENSION_IDS,
  DIMENSIONS,
  INDICATOR_AREA_KINDS,
  type IndicatorArea,
  type IndicatorAreaKind,
  type MeasureDeclaration,
  type ObservationId,
  type Reading,
  type SourceDescriptor,
  type SourceId,
} from "./contracts.ts";
import { isDimensionId, MEASURE_ID, measureOf, readingProblems, seriesKey } from "./indicators.ts";
import { checkWith, measureDeclarationSchema, readingSchema, sourceDescriptorSchema } from "./schemas.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const SOURCE_ID = "test-gauges" as SourceId;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Four made-up measures: one for each baseline, and one of each kind of area that the tests need.
const LEVEL: MeasureDeclaration = { id: "level", dimension: "river-levels", title: "River level", unit: "m", area: "point", moves: "rise", baseline: "none", cadence: 15 * MINUTE, backfill: 30 * DAY };
const LOAD: MeasureDeclaration = { id: "load", dimension: "power-demand", title: "Electric load", unit: "kW", area: "zone", moves: "both", baseline: "expected", cadence: 60 * MINUTE, delay: 10 * MINUTE };
const OUTAGES: MeasureDeclaration = { id: "outages", dimension: "internet-connectivity", title: "Outage events", unit: "{event}", area: "code", moves: "rise", baseline: "flag" };
const TRIPS: MeasureDeclaration = { id: "trips", dimension: "public-transit", title: "Trips in service", unit: "{trip}/h", area: "line", moves: "drop", baseline: "none" };
const MEASURES = [LEVEL, LOAD, OUTAGES, TRIPS];

const SOURCE: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Test gauges",
  origins: ["test"],
  dependsOn: ["provider:test"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: "global",
  transport: "poll",
  interval: 15 * MINUTE,
  slowAfter: 10_000,
  auth: "none",
  measures: MEASURES,
};

// One area of each kind, in public places in Kansas, and a made-up zone.
const AREAS: Readonly<Record<IndicatorAreaKind, IndicatorArea>> = {
  code: { type: "code", system: "ugc", code: "KSZ083" },
  point: { type: "point", at: [-95.68, 39.05] },
  line: { type: "line", path: [[-95.68, 39.05], [-95.6, 39.1]] },
  polygon: { type: "polygon", rings: [[[-96, 39], [-95, 39], [-95, 40], [-96, 39]]] },
  zone: { type: "zone", system: "test-zone", code: "Z1" },
  world: { type: "world" },
};

// A valid reading of a measure: the area of its kind, and the field of its baseline.
function readingOf(measure: MeasureDeclaration, value = 4): Reading {
  return {
    source: SOURCE_ID,
    measure: measure.id,
    series: "station-1",
    at: Date.UTC(2026, 10, 17, 12),
    value,
    area: AREAS[measure.area],
    ...(measure.baseline === "expected" ? { expected: 5 } : {}),
    ...(measure.baseline === "flag" ? { flagged: false } : {}),
    observation: "obs-1" as ObservationId,
  };
}

describe("the dimensions", () => {
  it("are 44 with unique ids in the form of a measure id, and DIMENSION_IDS keeps their order", () => {
    expect(DIMENSIONS).toHaveLength(44);
    expect(new Set(DIMENSION_IDS).size).toBe(44);
    expect(DIMENSION_IDS).toEqual(DIMENSIONS.map((dimension) => dimension.id));
    for (const id of DIMENSION_IDS) expect(id).toMatch(MEASURE_ID);
    expect(isDimensionId("rail")).toBe(true);
    expect(isDimensionId("Rail")).toBe(false);
    expect(isDimensionId("weather")).toBe(false);
  });
});

describe("the schema of a measure", () => {
  const problemsOf = (measure: object): readonly string[] => {
    const checked = checkWith(measureDeclarationSchema, measure);
    return checked.tag === "err" ? checked.error : [];
  };

  it("takes each measure of the test source", () => {
    for (const measure of MEASURES) expect(problemsOf(measure)).toEqual([]);
    expect(checkWith(sourceDescriptorSchema, SOURCE).tag).toBe("ok");
  });

  it("refuses a bad id, a dimension out of the list, a unit out of the grammar and a time that is not more than 0", () => {
    expect(problemsOf({ ...LEVEL, id: "Level" })).toEqual([expect.stringMatching(/^id: The id of a measure/u)]);
    expect(problemsOf({ ...LEVEL, dimension: "weather" })).toEqual([expect.stringMatching(/^dimension: /u)]);
    expect(problemsOf({ ...LEVEL, unit: "furlongs per fortnight" })).toEqual(["unit: The unit is not in the grammar of @mark1russell7/quantity."]);
    expect(problemsOf({ ...LEVEL, cadence: 0 })).toEqual(["cadence: The time is more than 0."]);
    expect(problemsOf({ ...LEVEL, backfill: -1 })).toEqual(["backfill: The time is more than 0."]);
    expect(problemsOf({ ...LEVEL, delay: 0 })).toEqual([]);
    expect(problemsOf({ ...LEVEL, extra: 1 })).toHaveLength(1);
  });

  it("refuses two measures of one source with one id", () => {
    const checked = checkWith(sourceDescriptorSchema, { ...SOURCE, measures: [LEVEL, { ...LOAD, id: "level" }] });
    expect(checked).toEqual({ tag: "err", error: ["measures: Two measures of the source have one id."] });
  });
});

describe("the schema of a reading", () => {
  const problemsOf = (reading: object): readonly string[] => {
    const checked = checkWith(readingSchema, reading);
    return checked.tag === "err" ? checked.error : [];
  };

  it("takes a reading of each measure, with each kind of area", () => {
    for (const measure of MEASURES) expect(problemsOf(readingOf(measure))).toEqual([]);
    for (const kind of INDICATOR_AREA_KINDS) expect(problemsOf({ ...readingOf(LEVEL), area: AREAS[kind] })).toEqual([]);
  });

  it("refuses a value that is not finite, an empty series, a bad version, a cadence of 0 and a line with one position", () => {
    expect(problemsOf({ ...readingOf(LEVEL), value: Number.NaN })).toHaveLength(1);
    expect(problemsOf({ ...readingOf(LEVEL), value: Number.POSITIVE_INFINITY })).toHaveLength(1);
    expect(problemsOf({ ...readingOf(LEVEL), series: "" })).toEqual(["series: The id of a series is not empty."]);
    expect(problemsOf({ ...readingOf(LEVEL), version: "2025 07" })).toEqual([expect.stringMatching(/^version: /u)]);
    expect(problemsOf({ ...readingOf(LEVEL), version: "2025-07-01.b" })).toEqual([]);
    expect(problemsOf({ ...readingOf(LEVEL), cadence: 30_000 })).toEqual([]);
    expect(problemsOf({ ...readingOf(LEVEL), cadence: 0 })).toEqual(["cadence: The time is more than 0."]);
    expect(problemsOf({ ...readingOf(TRIPS), area: { type: "line", path: [[-95.68, 39.05]] } })).toEqual(["area.path: A line has two positions or more."]);
    expect(problemsOf({ ...readingOf(LEVEL), area: { type: "point", at: [200, 39] } })).toHaveLength(1);
  });
});

describe("readingProblems", () => {
  it("gives no problem for a valid reading of each measure", () => {
    for (const measure of MEASURES) {
      expect(readingProblems(readingOf(measure), SOURCE)).toEqual([]);
      expect(measureOf(readingOf(measure), SOURCE)).toBe(measure);
    }
  });

  it("refuses a measure that the source does not declare, and a reading of another source", () => {
    expect(readingProblems({ ...readingOf(LEVEL), measure: "depth" }, SOURCE)).toEqual(["The source test-gauges declares no measure depth."]);
    expect(readingProblems({ ...readingOf(LEVEL), source: "other" as SourceId }, SOURCE)).toEqual(["The source test-gauges declares no measure level."]);
    expect(readingProblems(readingOf(LEVEL), { ...SOURCE, measures: undefined } as unknown as SourceDescriptor)).toHaveLength(1);
  });

  it("refuses an area of another kind, the field of another baseline and a negative count", () => {
    expect(readingProblems({ ...readingOf(LEVEL), area: AREAS.code }, SOURCE)).toEqual(["A reading of the measure level of test-gauges has an area of the kind code, and the measure declares point."]);
    const { expected: _expected, ...noExpected } = readingOf(LOAD);
    expect(readingProblems(noExpected, SOURCE)).toEqual(["A reading of the measure load of test-gauges has no expected value, and its measure has the baseline expected."]);
    expect(readingProblems({ ...readingOf(LEVEL), expected: 2 }, SOURCE)).toEqual(["A reading of the measure level of test-gauges has an expected value, and its measure has the baseline none."]);
    const { flagged: _flagged, ...noFlag } = readingOf(OUTAGES);
    expect(readingProblems(noFlag, SOURCE)).toEqual(["A reading of the measure outages of test-gauges has no flag, and its measure has the baseline flag."]);
    expect(readingProblems({ ...readingOf(LOAD), flagged: true }, SOURCE)).toEqual(["A reading of the measure load of test-gauges has a flag, and its measure has the baseline expected."]);
    expect(readingProblems(readingOf(OUTAGES, -1), SOURCE)).toEqual(["A reading of the measure outages of test-gauges has a value below 0, and its unit {event} counts."]);
    expect(readingProblems(readingOf(TRIPS, -1), SOURCE)).toEqual(["A reading of the measure trips of test-gauges has a value below 0, and its unit {trip}/h counts."]);
    // A level below the datum of the gauge is a valid value.
    expect(readingProblems(readingOf(LEVEL, -1), SOURCE)).toEqual([]);
  });

  it("gives one problem for each break of a valid reading, for any measure and any break (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`indicator-breaks:${seed}`);
      const measure = r.pick(MEASURES);
      const good = readingOf(measure, r.int(0, 1000));
      const otherKinds = INDICATOR_AREA_KINDS.filter((kind) => kind !== measure.area);
      const breaks: readonly Reading[] = [
        { ...good, area: AREAS[r.pick(otherKinds)] },
        measure.baseline === "expected" ? { ...good, flagged: r.chance(0.5) } : { ...good, expected: r.int(0, 100) },
        measure.baseline === "flag" ? { ...good, expected: r.int(0, 100) } : { ...good, flagged: r.chance(0.5) },
      ];
      expect(readingProblems(good, SOURCE), `seed ${r.seed}`).toEqual([]);
      for (const broken of breaks) expect(readingProblems(broken, SOURCE), `seed ${r.seed}`).toHaveLength(1);
    }
  });
});

describe("seriesKey", () => {
  it("gives one key for the values of one series with one method, and another key for each other series or version", () => {
    const base = readingOf(LEVEL);
    const key = seriesKey(base);
    expect(seriesKey({ ...base, at: base.at + MINUTE, value: 9 })).toBe(key);
    expect(seriesKey({ ...base, version: "1" })).not.toBe(key);
    const others = [{ ...base, series: "station-2" }, { ...base, measure: "load" }, { ...base, source: "other" as SourceId }, { ...base, version: "2025-07-01" }];
    expect(new Set([key, ...others.map(seriesKey)]).size).toBe(5);
    // A separator in an id does not join two series into one key.
    expect(seriesKey({ ...base, series: "a,b", version: "c" })).not.toBe(seriesKey({ ...base, series: "a", version: "b,c" }));
  });
});
