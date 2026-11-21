import { distanceKm, locatePoint } from "@mark1russell7/geo";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type {
  Area,
  AssessedLevel,
  AssessPolicy,
  AssessReason,
  Incident,
  IncidentLine,
  KindClass,
  LevelRule,
  LevelTable,
  PersonId,
  PersonWatch,
  PlaceId,
  Position,
  ReportId,
  Severity,
  Status,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import {
  CONTEXT_KINDS,
  DEFAULT_ASSESS_POLICY,
  EARTHQUAKE_PAST_WITHIN,
  FOREIGN_TABLE,
  foreignIncidents,
  LIFE_SAFETY_KINDS,
  admits,
  assess,
  classOf,
  hasKind,
  higherLevel,
  linesAt,
  matchPlaces,
  matchSubjects,
  regionContains,
  regionCovers,
  tableLevel,
} from "./assess.ts";
import { assessmentSchema, incidentSchema } from "./schemas.ts";
import { areasWithoutBlocks } from "./shapes.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// The CAP values from the lowest, without `unknown`.
const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "extreme"];
const URGENCIES: readonly Urgency[] = ["past", "future", "expected", "immediate"];
const STATUSES: readonly Status[] = ["actual", "exercise", "system", "test", "draft"];

// Public places in Kansas and Texas: Sedgwick County KS and Bexar County TX.
const home = "place-1" as PlaceId;
const other = "place-2" as PlaceId;
const places: readonly WatchedPlace[] = [
  {
    id: home,
    codes: [
      { system: "ugc", code: "KSZ083" },
      { system: "ugc", code: "KSC173" },
      { system: "same", code: "020173" },
    ],
    bufferKm: 5,
  },
  {
    id: other,
    codes: [
      { system: "ugc", code: "TXC029" },
      { system: "same", code: "048029" },
    ],
    bufferKm: 5,
  },
];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;
const atOther = [{ type: "code", system: "same", code: "048029" }] as const;

function person(rules: readonly LevelRule[] = [], watched: readonly PlaceId[] = [home, other]): PersonWatch {
  return { person: "person-1" as PersonId, places: watched, rules };
}

// The builder takes the kind as its code.
type Draft = Omit<Partial<Incident>, "kind"> & { readonly kind?: string };

function incident({ kind = "met.tornado", ...fields }: Draft = {}): Incident {
  return {
    anchor: "a".repeat(64) as ReportId,
    reports: ["a".repeat(64) as ReportId],
    status: "actual",
    kind: { code: kind, label: kind },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

const rank = (level: AssessedLevel): number => ASSESSED_LEVELS.indexOf(level);

describe("the first table", () => {
  // The CAP values that the NWS gives to these products.
  const products: readonly [string, Draft, AssessedLevel][] = [
    ["a tornado warning", { kind: "met.tornado", severity: "extreme", urgency: "immediate" }, "life-safety"],
    ["a tornado watch", { kind: "met.tornado", severity: "extreme", urgency: "future" }, "urgent"],
    ["a flash flood warning", { kind: "met.flood.flash", severity: "severe", urgency: "immediate" }, "life-safety"],
    ["a severe thunderstorm warning", { kind: "met.thunderstorm.severe", severity: "severe", urgency: "immediate" }, "urgent"],
    ["a severe thunderstorm watch", { kind: "met.thunderstorm.severe", severity: "severe", urgency: "future" }, "notice"],
    ["a winter storm warning", { kind: "met.winter.storm", severity: "moderate", urgency: "expected" }, "notice"],
    ["a wind advisory", { kind: "met.wind.high", severity: "minor", urgency: "expected" }, "digest"],
    ["a tornado warning that passed", { kind: "met.tornado", severity: "extreme", urgency: "past" }, "digest"],
    ["an Emergency Action Notification", { kind: "safety.national-emergency", severity: "extreme", urgency: "immediate" }, "life-safety"],
    ["a typhoon warning", { kind: "met.tropical.typhoon", severity: "extreme", urgency: "expected" }, "life-safety"],
    ["a debris flow warning", { kind: "geo.debris-flow", severity: "severe", urgency: "immediate" }, "life-safety"],
    ["a volcano warning", { kind: "geo.volcano.eruption", severity: "extreme", urgency: "immediate" }, "life-safety"],
    // The eruption is a child of `geo.volcano`, so the ashfall codes stay out of the class.
    ["an ashfall warning", { kind: "geo.volcano.ashfall", severity: "severe", urgency: "expected" }, "urgent"],
  ];
  it.each(products)("gives %s the level %s", (_, fields, level) => {
    expect(assess(incident(fields), person(), places).level).toBe(level);
  });

  it("gives life-safety exactly as the rule of docs/CONTRACTS.md tells", () => {
    const kinds = ["met.tornado", "met.thunderstorm.severe"];
    for (const status of STATUSES) {
      for (const kind of kinds) {
        for (const severity of [...SEVERITIES, "unknown"] as const) {
          for (const urgency of [...URGENCIES, "unknown"] as const) {
            const level = assess(incident({ status, kind, severity, urgency }), person(), places).level;
            const expected =
              status === "actual" &&
              hasKind(LIFE_SAFETY_KINDS, kind) &&
              ["severe", "extreme", "unknown"].includes(severity) &&
              ["immediate", "expected", "unknown"].includes(urgency);
            expect([status, kind, severity, urgency, level === "life-safety"]).toEqual([status, kind, severity, urgency, expected]);
          }
        }
      }
    }
  });

  it("gives a level that only grows with the severity and the urgency", () => {
    const tables: readonly LevelTable[] = [...DEFAULT_ASSESS_POLICY.classes, DEFAULT_ASSESS_POLICY.otherwise];
    for (const table of tables) {
      const bySeverity = SEVERITIES.map((severity) => rank(table.severity[severity]));
      const byUrgency = URGENCIES.map((urgency) => rank(table.urgency[urgency]));
      expect(bySeverity).toEqual([...bySeverity].sort((a, b) => a - b));
      expect(byUrgency).toEqual([...byUrgency].sort((a, b) => a - b));
    }
  });

  it("does not give life-safety to a kind out of the list, and does not give a life-safety kind less than another kind", () => {
    const [lifeSafety] = DEFAULT_ASSESS_POLICY.classes;
    const otherwise = DEFAULT_ASSESS_POLICY.otherwise;
    for (const severity of [...SEVERITIES, "unknown"] as const) {
      expect(otherwise.severity[severity]).not.toBe("life-safety");
      expect(rank(lifeSafety!.severity[severity])).toBeGreaterThanOrEqual(rank(otherwise.severity[severity]));
    }
    for (const urgency of [...URGENCIES, "unknown"] as const) {
      expect(otherwise.urgency[urgency]).not.toBe("life-safety");
      expect(rank(lifeSafety!.urgency[urgency])).toBeGreaterThanOrEqual(rank(otherwise.urgency[urgency]));
    }
  });

  it("tells the class and the two lookups", () => {
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "met.tornado", label: "Tornado Watch" }, severity: "extreme", urgency: "future" })).toEqual({
      class: "life-safety",
      bySeverity: "life-safety",
      byUrgency: "urgent",
      level: "urgent",
    });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "met.fog", label: "Dense Fog Advisory" }, severity: "minor", urgency: "expected" })).toEqual({
      bySeverity: "digest",
      byUrgency: "urgent",
      level: "digest",
    });
  });

  it("gives a kind of context the digest at most, also at the worst severity and urgency, and keeps the other transport kinds", () => {
    expect(CONTEXT_KINDS).toEqual(["transport.transit"]);
    const worst = { severity: "extreme", urgency: "immediate" } as const;
    const transit = { code: "transport.transit.service-alert", label: "" };
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: transit, ...worst })).toEqual({
      class: "context",
      bySeverity: "digest",
      byUrgency: "digest",
      level: "digest",
    });
    // A minor alert and an alert that passed stay in the map and the log.
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: transit, severity: "minor", urgency: "immediate" }).level).toBe("none");
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: transit, severity: "severe", urgency: "past" }).level).toBe("none");
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "transport.rail.accident", label: "" }, ...worst })).toEqual({
      bySeverity: "urgent",
      byUrgency: "urgent",
      level: "urgent",
    });
  });
});

describe("the transit alerts (AL-73)", () => {
  // A transit alert at each value of the CAP fields reaches the digest at most, at a watched place and through a subject.
  it("gives a severe, immediate transit incident the digest at most, for a person with no own edges", () => {
    const severe = incident({ kind: "transport.transit.service-alert", severity: "severe", urgency: "immediate" });
    const found = assess(severe, person(), places);
    expect(found.level).toBe("digest");
    expect(found.places).toEqual([home]);
    const watcher: PersonWatch = { ...person(), subjects: [{ system: "gtfs-route", id: "r1" }] };
    const named = incident({ kind: "transport.transit.service-alert", severity: "severe", urgency: "immediate", areas: [], about: [{ system: "gtfs-route", id: "r1" }] });
    expect(assess(named, watcher, places).level).toBe("digest");
  });

  it("never gives a transit incident a level above the digest, at each severity, urgency and certainty", () => {
    for (const severity of [...SEVERITIES, "unknown"] as const) {
      for (const urgency of [...URGENCIES, "unknown"] as const) {
        for (const certainty of ["observed", "likely", "possible", "unlikely", "unknown"] as const) {
          const found = assess(incident({ kind: "transport.transit.service-alert", severity, urgency, certainty }), person(), places);
          expect(rank(found.level), [severity, urgency, certainty].join(" ")).toBeLessThanOrEqual(rank("digest"));
        }
      }
    }
  });
});

describe("the reports of another copy (AL-76)", () => {
  // A kind with no class: the table of the other kinds gives it `urgent` at most.
  const river = (fields: Draft = {}) => incident({ kind: "met.flood.river", severity: "severe", urgency: "expected", ...fields });

  it("gives a kind with no class the digest at most, at each severity and urgency", () => {
    expect(assess(river(), person(), places).level).toBe("urgent");
    for (const severity of [...SEVERITIES, "unknown"] as const) {
      for (const urgency of [...URGENCIES, "unknown"] as const) {
        const found = assess(river({ severity, urgency }), person(), places, DEFAULT_ASSESS_POLICY, undefined, true);
        const expected = severity === "minor" || urgency === "past" ? "none" : "digest";
        expect(found.level, [severity, urgency].join(" ")).toBe(expected);
      }
    }
  });

  it("tells the quiet table in the reason, with no source id", () => {
    const found = tableLevel(DEFAULT_ASSESS_POLICY, river(), undefined, true);
    expect(found).toEqual({ bySeverity: "digest", byUrgency: "digest", level: "digest", foreign: true });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, river())).toEqual({ bySeverity: "urgent", byUrgency: "urgent", level: "urgent" });
    const assessed = assess(river(), person(), places, DEFAULT_ASSESS_POLICY, undefined, true);
    expect(assessed.reasons.find((reason) => reason.kind === "table")).toMatchObject({ kind: "table", foreign: true, level: "digest" });
    expect(assessmentSchema.safeParse(assessed).success).toBe(true);
    expect(FOREIGN_TABLE.severity.extreme).toBe("digest");
  });

  it("keeps the table of the class of a kind", () => {
    expect(assess(incident(), person(), places, DEFAULT_ASSESS_POLICY, undefined, true).level).toBe("life-safety");
    const transit = incident({ kind: "transport.transit.service-alert", severity: "minor", urgency: "immediate" });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, transit, undefined, true).foreign).toBeUndefined();
  });

  it("tells an incident whose each report comes from a source of another copy", () => {
    const a = "a".repeat(64) as ReportId;
    const b = "b".repeat(64) as ReportId;
    const both = { anchor: a, reports: [a, b] };
    const reports = [{ id: a, source: "source-2" }, { id: b, source: "source-3" }] as const;
    expect(foreignIncidents(reports, new Set(["source-1"]))(both)).toBe(true);
    expect(foreignIncidents(reports, new Set(["source-1", "source-3"]))(both)).toBe(false);
    // A report with no known source counts as a report of this copy.
    expect(foreignIncidents(reports.slice(0, 1), new Set(["source-1"]))(both)).toBe(false);
    expect(foreignIncidents(reports, undefined)(both)).toBe(false);
  });
});

describe("hasKind", () => {
  it("ends a prefix at a dot", () => {
    expect(hasKind(["met.flood"], "met.flood")).toBe(true);
    expect(hasKind(["met.flood"], "met.flood.flash")).toBe(true);
    expect(hasKind(["met.fl"], "met.flood")).toBe(false);
    expect(hasKind(["met.flood.flash"], "met.flood")).toBe(false);
    expect(hasKind(["cbrne"], "cbrne.radiological")).toBe(true);
    expect(hasKind([], "met.tornado")).toBe(false);
  });
});

describe("the places", () => {
  it("matches a code of one system only", () => {
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "ugc", code: "KSC173" })).toBe(true);
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "same", code: "KSC173" })).toBe(false);
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "ugc", code: "KSZ083" })).toBe(false);
  });

  it("matches a part of a SAME county to the full county, and not to another part", () => {
    const same = (code: string) => ({ system: "same", code });
    expect(regionCovers(same("120173"), same("020173"))).toBe(true);
    expect(regionCovers(same("020173"), same("120173"))).toBe(true);
    expect(regionCovers(same("120173"), same("120173"))).toBe(true);
    expect(regionCovers(same("120173"), same("220173"))).toBe(false);
    expect(regionCovers(same("020173"), same("020175"))).toBe(false);
  });

  it("matches a SAME code of a state to each county of the state, and 000000 to each SAME code", () => {
    const same = (code: string) => ({ system: "same", code });
    expect(regionCovers(same("020000"), same("020173"))).toBe(true);
    expect(regionCovers(same("020000"), same("320173"))).toBe(true);
    expect(regionCovers(same("020173"), same("020000"))).toBe(true);
    expect(regionCovers(same("020000"), same("048029"))).toBe(false);
    expect(regionCovers(same("000000"), same("048029"))).toBe(true);
    expect(regionCovers(same("048029"), same("000000"))).toBe(true);
    // A code that is not 6 digits matches only an equal code.
    expect(regionCovers(same("20000"), same("020173"))).toBe(false);
    expect(regionContains(same("20000"), same("20000"))).toBe(true);
  });

  // Each code of a small alphabet against each code. The oracle names the smallest regions in each code: a part of a county.
  it("agrees with the smallest regions of each SAME code for the two relations", () => {
    const codes: string[] = [];
    for (const part of ["0", "1", "2"]) {
      codes.push(`${part}00000`);
      for (const state of ["20", "48"]) for (const county of ["000", "173", "029"]) codes.push(`${part}${state}${county}`);
    }
    const atoms = ["20", "48"].flatMap((state) => ["173", "029"].flatMap((county) => ["1", "2", "3"].map((part) => [state, county, part] as const)));
    const holds = (code: string, [state, county, part]: readonly [string, string, string]): boolean => {
      const [p, s, c] = [code.slice(0, 1), code.slice(1, 3), code.slice(3)];
      if (s === "00" && c === "000") return true;
      return s === state && (c === "000" || (c === county && (p === "0" || p === part)));
    };
    const same = (code: string) => ({ system: "same", code });
    for (const a of codes) {
      for (const b of codes) {
        const inB = atoms.filter((atom) => holds(b, atom));
        expect(regionCovers(same(a), same(b)), `${a} meets ${b}`).toBe(inB.some((atom) => holds(a, atom)));
        expect(regionContains(same(a), same(b)), `${a} contains ${b}`).toBe(inB.every((atom) => holds(a, atom)));
      }
    }
  });

  it("gives a place of a county for a SAME alert of its state", () => {
    expect(matchPlaces({ areas: [{ type: "code", system: "same", code: "020000" }] }, places).map((match) => match.place)).toEqual([home]);
    expect(matchPlaces({ areas: [{ type: "code", system: "same", code: "000000" }] }, places).map((match) => match.place)).toEqual([home, other]);
  });

  it("gives the places in their order, with the codes that matched", () => {
    const areas = [...atOther, ...atHome, { type: "code", system: "same", code: "320173" }] as const;
    expect(matchPlaces({ areas }, places)).toEqual([
      { place: home, codes: [{ system: "ugc", code: "KSC173" }, { system: "same", code: "020173" }] },
      { place: other, codes: [{ system: "same", code: "048029" }] },
    ]);
  });

  it("gives none, with the reason, when the areas are shapes and no place has a position", () => {
    const ring = [[-97.5, 37.5], [-97.2, 37.5], [-97.2, 37.8], [-97.5, 37.5]] as const;
    const result = assess(incident({ areas: [{ type: "polygon", rings: [ring] }] }), person(), places);
    expect(result.level).toBe("none");
    expect(result.reasons).toEqual([{ kind: "no-codes" }]);
  });

  it("gives none when no place of the person is in the areas", () => {
    const result = assess(incident({ areas: [{ type: "code", system: "ugc", code: "KSC015" }] }), person(), places);
    expect(result).toMatchObject({ level: "none", places: [], reasons: [{ kind: "no-place" }] });
  });

  it("tells of a place id with no watched place, and assesses the other places", () => {
    const missing = "place-9" as PlaceId;
    const result = assess(incident(), person([], [missing, home]), places);
    expect(result.level).toBe("life-safety");
    expect(result.reasons[0]).toEqual({ kind: "unknown-place", place: missing });
  });
});

describe("the shapes", () => {
  // Made-up positions in the ocean near 0, 0, with the codes of Kansas. No position is a real place.
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] as const;
  const polygon = { type: "polygon", rings: [square] } as const;
  const placed = (at: Position, bufferKm: number): WatchedPlace => ({ ...(places[0] as WatchedPlace), at, bufferKm });
  const point = (at: Position) => ({ lat: at[1], lon: at[0] });
  // A position on the equator at a distance east of 0, 0.
  const east = (km: number): Position => [km / ((6371.0088 * Math.PI) / 180), 0];
  const byCode = { place: home, codes: [{ system: "ugc", code: "KSC173" }] };

  it("matches a place in a polygon, with the distance 0", () => {
    expect(matchPlaces({ areas: [polygon] }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
    expect(matchPlaces({ areas: [polygon] }, [placed([1, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
  });

  it("matches a place out of a polygon when the polygon is in the buffer of the place", () => {
    const at: Position = [1.05, 0.5];
    const gap = distanceKm(point(at), point([1, 0.5]));
    const [match] = matchPlaces({ areas: [polygon] }, [placed(at, 6)]);
    expect(match?.distanceKm).toBeCloseTo(gap, 3);
    expect(gap).toBeGreaterThan(5);
    expect(matchPlaces({ areas: [polygon] }, [placed(at, 5)])).toEqual([]);
  });

  it("keeps a match by codes when the shapes are far from a place with a position", () => {
    const areas = [polygon, ...atHome];
    expect(matchPlaces({ areas }, [placed([1.5, 0.5], 5)])).toEqual([byCode]);
    const result = assess(incident({ areas }), person([], [home]), [placed([1.5, 0.5], 5)]);
    expect(result).toMatchObject({ level: "life-safety", places: [home] });
    expect(result.reasons.find((one) => one.kind === "place")).toEqual({ kind: "place", ...byCode });
  });

  it("gives the codes and the distance when the codes and a shape both match", () => {
    expect(matchPlaces({ areas: [polygon, ...atHome] }, [placed([0.5, 0.5], 0)])).toEqual([{ ...byCode, distanceKm: 0 }]);
  });

  it("keeps the union rule for the areas with no block key: a far polygon does not remove a match by codes", () => {
    // The areas have no block key, so the core does not know which code goes with the polygon.
    const second = { system: "ugc", code: "KSC015" } as const;
    const place: WatchedPlace = { ...placed([5, 5], 5), codes: [second] };
    expect(matchPlaces({ areas: [polygon, { type: "code", ...second }] }, [place])).toEqual([{ place: home, codes: [second] }]);
  });

  it("lets the codes decide for a place with no position", () => {
    expect(matchPlaces({ areas: [polygon, ...atHome] }, places)).toEqual([byCode]);
  });

  it("matches a circle with its radius and the buffer of the place", () => {
    const circle = { type: "circle", center: [0, 0], radiusKm: 10 } as const;
    expect(matchPlaces({ areas: [circle] }, [placed(east(9), 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
    const [near] = matchPlaces({ areas: [circle] }, [placed(east(14), 5)]);
    expect(near?.distanceKm).toBeCloseTo(4, 6);
    expect(matchPlaces({ areas: [circle] }, [placed(east(16), 5)])).toEqual([]);
  });

  it("gives the distance to the nearest shape", () => {
    const far = { type: "polygon", rings: [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]] } as const;
    const at: Position = [1.05, 0.5];
    const [match] = matchPlaces({ areas: [far, polygon] }, [placed(at, 10)]);
    expect(match?.distanceKm).toBeCloseTo(distanceKm(point(at), point([1, 0.5])), 3);
  });

  it("adds no place for a shape that geo refuses, and keeps the match by codes", () => {
    const broken = { type: "polygon", rings: [[[0, 0], [1, 0], [0, 0]]] } as const;
    expect(matchPlaces({ areas: [broken, ...atHome] }, [placed([5, 5], 0)])).toEqual([byCode]);
    expect(matchPlaces({ areas: [broken, polygon, ...atHome] }, [placed([5, 5], 0)])).toEqual([byCode]);
    expect(matchPlaces({ areas: [broken] }, [placed([5, 5], 0)])).toEqual([]);
    expect(matchPlaces({ areas: [broken, polygon] }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
  });

  it("matches an area of the place when the areas also have shapes", () => {
    expect(matchPlaces({ areas: [polygon, { type: "place", place: home }] }, [placed([5, 5], 0)])).toEqual([{ place: home, codes: [] }]);
  });

  it("gives the distance in the reason of the assessment, and the schema accepts the assessment", () => {
    const result = assess(incident({ areas: [polygon] }), person([], [home]), [placed([1.05, 0.5], 10)]);
    expect(result.level).toBe("life-safety");
    const reason = result.reasons.find((one) => one.kind === "place");
    expect(reason).toMatchObject({ kind: "place", place: home, codes: [] });
    expect(reason?.kind === "place" ? reason.distanceKm : undefined).toBeGreaterThan(5);
    expect(assessmentSchema.safeParse(result).success).toBe(true);
  });

  it.each(SEEDS)("matches more places with a larger buffer, and a buffer of 0 matches the polygon (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const at: Position = [r.range(-1, 2), r.range(-1, 2)];
      const matched = (bufferKm: number): boolean => matchPlaces({ areas: [polygon] }, [placed(at, bufferKm)]).length === 1;
      expect(matched(0)).toBe(locatePoint(point(at), { type: "Polygon", coordinates: [square] }) !== "outside");
      const buffer = r.range(0, 200);
      if (matched(buffer)) expect(matched(buffer * 2)).toBe(true);
    }
  });

  describe("the area blocks", () => {
    const keyed = (block: string, ...areas: readonly Area[]): Area[] => areas.map((area) => ({ ...area, block }) as Area);
    const homeCode = { type: "code", system: "ugc", code: "KSC173" } as const;
    const far = { type: "polygon", rings: [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]] } as const;
    const broken = { type: "polygon", rings: [[[0, 0], [1, 0], [0, 0]]] } as const;

    it("lets the shape of a block decide for a place with a position", () => {
      const areas = keyed("r/feature", polygon, homeCode);
      expect(matchPlaces({ areas }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
      // The code of the block covers the place, but the place is far from the shape of the block.
      expect(matchPlaces({ areas }, [placed([5, 5], 5)])).toEqual([]);
      // A place with no position matches by the codes of the block.
      expect(matchPlaces({ areas }, places)).toEqual([byCode]);
    });

    it("lets the codes of a block with no shape decide, and one block that matches is enough", () => {
      const areas = [...keyed("r/info[0].area[0]", far, homeCode), ...keyed("r/info[0].area[1]", homeCode)];
      expect(matchPlaces({ areas }, [placed([5, 5], 5)])).toEqual([byCode]);
      const two = [...keyed("r/a", far), ...keyed("r/b", polygon)];
      expect(matchPlaces({ areas: two }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
    });

    it("lets the codes decide when geo refuses each shape of a block, and tells it", () => {
      expect(matchPlaces({ areas: keyed("r/0", broken, homeCode) }, [placed([5, 5], 0)])).toEqual([{ ...byCode, shapeRefused: true }]);
      // A shape that geo reads still decides for its block.
      expect(matchPlaces({ areas: keyed("r/0", broken, polygon, homeCode) }, [placed([5, 5], 0)])).toEqual([]);
      // For a place with no position, the codes decide in each block, so no refusal shows.
      expect(matchPlaces({ areas: keyed("r/0", broken, homeCode) }, places)).toEqual([byCode]);
      const result = assess(incident({ areas: keyed("r/0", broken, homeCode) }), person([], [home]), [placed([5, 5], 0)]);
      expect(result.reasons.find((one) => one.kind === "place")).toEqual({ kind: "place", ...byCode, shapeRefused: true });
      expect(assessmentSchema.safeParse(result).success).toBe(true);
    });

    it("matches a place out of the polygon of one copy by the codes of a copy with no shape", () => {
      // The known effect in CONTRACTS.md: each copy is a block of its own, and a block with only codes decides by its codes.
      const areas = [...keyed("api/feature", polygon, homeCode), ...keyed("ipaws/info[0].area[0]", homeCode)];
      expect(matchPlaces({ areas }, [placed([5, 5], 5)])).toEqual([byCode]);
    });

    it.each(SEEDS)("keys only remove matches of the union rule, and the order of the areas does not change a match (seed %i)", (seed) => {
      const r = random(seed);
      const circle = { type: "circle", center: [2, 2], radiusKm: 80 } as const;
      const pool: readonly Area[] = [polygon, far, broken, circle, homeCode, { type: "code", system: "same", code: "020173" }];
      for (let round = 0; round < 200; round += 1) {
        const areas = r.sample(pool, r.int(1, pool.length)).map((area) => (r.chance(0.7) ? ({ ...area, block: r.pick(["a", "b"]) } as Area) : area));
        const place = r.chance(0.8) ? placed([r.range(-1, 6), r.range(-1, 6)], r.range(0, 300)) : (places[0] as WatchedPlace);
        const keyedMatch = matchPlaces({ areas }, [place]);
        const unionMatch = matchPlaces({ areas: areasWithoutBlocks(areas) }, [place]);
        if (keyedMatch.length > 0) expect(unionMatch).toHaveLength(1);
        if (place.at === undefined) expect(keyedMatch).toEqual(unionMatch);
        expect(matchPlaces({ areas: r.shuffle(areas) }, [place])).toEqual(keyedMatch);
      }
    });
  });
});

describe("the gates", () => {
  it("gives none to an incident that ended", () => {
    expect(assess(incident({ live: false }), person(), places)).toMatchObject({ level: "none", places: [home], reasons: [{ kind: "ended" }] });
  });

  it("gives none to a status that the policy does not send", () => {
    expect(assess(incident({ status: "exercise" }), person(), places).reasons).toEqual([{ kind: "status", status: "exercise" }]);
  });

  it("sends the status system only for the kinds of the core", () => {
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.health.failing", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.coverage.met.tornado", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "actual", kind: { code: "system.health.failing", label: "" } })).toBe(false);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "met.tornado", label: "" } })).toBe(false);
    // The NWS maps an administrative message to `system.admin`. It stays in the table `otherwise`.
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "actual", kind: { code: "system.admin", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.admin", label: "" } })).toBe(false);
    expect(classOf(DEFAULT_ASSESS_POLICY, "system.admin")).toBeUndefined();
  });

  it("gives the coverage of a life-safety kind its own class, and each other report of the core at most notice", () => {
    const worst = { severity: "extreme", urgency: "immediate" } as const;
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.coverage.met.tornado", label: "" }, ...worst })).toMatchObject({ class: "system-coverage", level: "life-safety" });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.coverage.met.winter", label: "" }, ...worst })).toMatchObject({ class: "system", level: "notice" });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.health.failing", label: "" }, ...worst })).toMatchObject({ class: "system", level: "notice" });
  });
});

describe("the subjects and the areas of a place", () => {
  const source = { system: "alerts.source", id: "api" };
  const down = (fields: Draft = {}): Incident =>
    incident({ status: "system", kind: "system.health.failing", severity: "moderate", urgency: "expected", areas: [], about: [source], ...fields });
  const watcher = (rules: readonly LevelRule[] = [], subjects: PersonWatch["subjects"] = [{ system: "alerts.source" }]): PersonWatch => ({ ...person(rules), subjects });

  it("matches a watched subject by its system, and by its id when the watch has one", () => {
    expect(matchSubjects(down(), [{ system: "alerts.source" }, { system: "alerts.source", id: "api" }, { system: "alerts.source", id: "radio" }, { system: "cloud" }])).toEqual([
      { system: "alerts.source" },
      { system: "alerts.source", id: "api" },
    ]);
    expect(assess(down(), watcher(), places)).toMatchObject({ level: "notice", places: [], reasons: [{ kind: "table" }, { kind: "subject", subject: { system: "alerts.source" } }] });
  });

  it("gives none with the reason no-subject to a person who watches no subject of the incident", () => {
    expect(assess(down(), person(), places).reasons).toEqual([{ kind: "no-subject" }]);
    expect(assess(down(), watcher([], [{ system: "cloud" }]), places).level).toBe("none");
  });

  it("applies a rule with no places to a subject, and not a rule with places", () => {
    expect(assess(down(), watcher([{ places: [home], max: "none" }, { kinds: ["system"], max: "digest" }]), places)).toMatchObject({
      level: "digest",
      reasons: [{ kind: "table" }, { kind: "subject" }, { kind: "rule", index: 1, max: "digest" }],
    });
  });

  it("matches an area of a watched place to that place only", () => {
    const gap = incident({ areas: [{ type: "place", place: other }] });
    expect(matchPlaces(gap, places)).toEqual([{ place: other, codes: [] }]);
    expect(assess(gap, person([], [home]), places).reasons).toEqual([{ kind: "no-place" }]);
  });
});

describe("the rules of a person", () => {
  const others: LevelRule = { places: [other], max: "urgent" };

  it("lowers the level at the places of the rule only", () => {
    expect(assess(incident({ areas: atOther }), person([others]), places)).toMatchObject({
      level: "urgent",
      reasons: [{ kind: "table" }, { kind: "place", place: other }, { kind: "rule", place: other, index: 0, max: "urgent" }],
    });
    expect(assess(incident({ areas: atHome }), person([others]), places).level).toBe("life-safety");
  });

  it("gives the highest level of the places", () => {
    expect(assess(incident({ areas: [...atHome, ...atOther] }), person([others]), places).level).toBe("life-safety");
  });

  it("applies the first rule that matches the place and the kind", () => {
    const worst: LevelRule = { places: [other], kinds: ["met.tornado", "safety.evacuation", "geo.tsunami"], max: "life-safety" };
    expect(assess(incident({ areas: atOther }), person([worst, others]), places).level).toBe("life-safety");
    expect(assess(incident({ areas: atOther, kind: "met.flood.flash" }), person([worst, others]), places).level).toBe("urgent");
    expect(assess(incident(), person([{ max: "digest" }, { max: "none" }]), places).level).toBe("digest");
  });

  it("does not raise the level of the table", () => {
    const result = assess(incident({ severity: "moderate", kind: "met.winter.storm", urgency: "expected" }), person([{ max: "life-safety" }]), places);
    expect(result.level).toBe("notice");
    expect(result.reasons.some((reason) => reason.kind === "rule")).toBe(false);
  });
});

describe("the properties of the assessment", () => {
  const kinds = ["met.tornado", "met.flood.flash", "met.thunderstorm.severe", "met.wind.high", "cbrne.radiological", "system.coverage.met.tornado", "system.health.failing"];
  const levels = ASSESSED_LEVELS;

  function randomIncident(r: Random): Incident {
    const areas = [...(r.chance(0.6) ? atHome : []), ...(r.chance(0.6) ? atOther : [])];
    return incident({
      kind: r.pick(kinds),
      severity: r.pick([...SEVERITIES, "unknown"] as const),
      urgency: r.pick([...URGENCIES, "unknown"] as const),
      status: r.chance(0.8) ? "actual" : r.pick(STATUSES),
      live: r.chance(0.9),
      areas,
    });
  }

  function randomRules(r: Random): LevelRule[] {
    return Array.from({ length: r.int(0, 3) }, () => ({
      ...(r.chance(0.5) ? { places: r.sample([home, other], r.int(1, 2)) } : {}),
      ...(r.chance(0.5) ? { kinds: r.sample(kinds, r.int(1, 2)) } : {}),
      max: r.pick(levels),
    }));
  }

  it.each(SEEDS)("holds over random incidents and rules (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const subject = randomIncident(r);
      const rules = randomRules(r);
      const result = assess(subject, person(rules), places);
      const table = tableLevel(DEFAULT_ASSESS_POLICY, subject).level;
      // The rules only lower the level.
      expect(rank(result.level)).toBeLessThanOrEqual(rank(table));
      expect(rank(result.level)).toBeLessThanOrEqual(rank(assess(subject, person(), places).level));
      // A place more never lowers the level.
      const fewer = assess(subject, person(rules, [r.pick([home, other])]), places);
      expect(rank(fewer.level)).toBeLessThanOrEqual(rank(result.level));
      // The level is the highest of the levels at each place alone.
      const alone = [home, other].map((place) => assess(subject, person(rules, [place]), places).level);
      expect(result.level).toBe(alone.reduce(higherLevel, "none"));
    }
  });
});

describe("the level at each place (AL-14)", () => {
  // A made-up earthquake at 0, 0 in the ocean, with one line for each band of the shaking. No position is a real place.
  const east = (km: number): Position => [km / ((6371.0088 * Math.PI) / 180), 0];
  const quake = { code: "geo.earthquake", label: "geo.earthquake" };
  const idOf = (digit: number): ReportId => String(digit).repeat(64) as ReportId;
  const band = (digit: number, severity: Severity, radiusKm: number): IncidentLine => ({
    report: idOf(digit),
    kind: quake,
    severity,
    urgency: "immediate",
    certainty: "observed",
    areas: [{ type: "circle", center: [0, 0], radiusKm, block: `${idOf(digit)}/band` }],
  });
  const bands = [band(1, "extreme", 40), band(2, "severe", 76), band(3, "moderate", 137), band(4, "minor", 522)];
  const shaken = incident({
    kind: quake.code,
    anchor: idOf(1),
    reports: bands.map((line) => line.report),
    areas: bands.flatMap((line) => line.areas),
    lines: bands,
  });
  const placeAt = (km: number): WatchedPlace => ({ id: home, codes: [], at: east(km), bufferKm: 0 });
  const tableOf = (line: IncidentLine): AssessedLevel => tableLevel(DEFAULT_ASSESS_POLICY, line).level;

  it("gives each place the highest level of the bands that hold it", () => {
    expect(incidentSchema.safeParse(shaken).success).toBe(true);
    const levelAt = (km: number): AssessedLevel => assess(shaken, person([], [home]), [placeAt(km)]).level;
    expect(levelAt(20)).toBe(tableLevel(DEFAULT_ASSESS_POLICY, shaken).level);
    expect(levelAt(100)).toBe(tableOf(bands[2] as IncidentLine));
    expect(levelAt(300)).toBe(tableOf(bands[3] as IncidentLine));
    expect(levelAt(600)).toBe("none");
    // The far places get lower levels than the center.
    expect(rank(levelAt(300))).toBeLessThan(rank(levelAt(100)));
    expect(rank(levelAt(100))).toBeLessThan(rank(levelAt(20)));
  });

  it("tells the bands that gave the level of a place", () => {
    const result = assess(shaken, person([], [home]), [placeAt(100)]);
    expect(result.reasons.filter((reason) => reason.kind === "place-table")).toEqual([
      { kind: "place-table", place: home, reports: [idOf(3), idOf(4)], level: tableOf(bands[2] as IncidentLine) },
    ]);
    expect(assessmentSchema.safeParse(result).success).toBe(true);
    // At the center, the level is the level of the incident, so no reason tells it again.
    expect(assess(shaken, person([], [home]), [placeAt(20)]).reasons.some((reason) => reason.kind === "place-table")).toBe(false);
    expect(linesAt(shaken, placeAt(100)).map((line) => line.report)).toEqual([idOf(3), idOf(4)]);
    expect(linesAt(incident(), placeAt(100))).toEqual([]);
  });

  it("applies a rule of the person to the level of the place", () => {
    const low = tableOf(bands[3] as IncidentLine);
    const result = assess(shaken, person([{ places: [home], max: low }]), [placeAt(20)]);
    expect(result.level).toBe(low);
    // A rule above the level of the place does not raise it.
    expect(assess(shaken, person([{ max: "life-safety" }], [home]), [placeAt(300)]).level).toBe(low);
  });

  it.each(SEEDS)("gives the level of the incident as the highest level of its lines alone (seed %i)", (seed) => {
    const r = random(seed);
    const kinds = ["met.tornado", "met.flood.flash", "geo.earthquake", "met.wind.high"];
    for (let round = 0; round < 200; round += 1) {
      const kind = r.pick(kinds);
      const count = r.int(2, 4);
      const lines: IncidentLine[] = Array.from({ length: count }, (_, index) => {
        const areas = [...(r.chance(0.5) ? atHome : []), ...(r.chance(0.5) ? atOther : [])];
        return {
          report: idOf(index + 1),
          kind: { code: kind, label: kind },
          severity: r.pick([...SEVERITIES, "unknown"] as const),
          urgency: r.pick([...URGENCIES, "unknown"] as const),
          certainty: "observed",
          ...(r.chance(0.7) ? { onset: r.int(0, 2 * EARTHQUAKE_PAST_WITHIN) } : {}),
          areas: areas.length === 0 ? atHome : areas,
        };
      });
      const status = r.chance(0.8) ? "actual" : r.pick(STATUSES);
      const whole = incident({
        kind,
        status,
        severity: r.pick([...SEVERITIES, "unknown"] as const),
        urgency: r.pick([...URGENCIES, "unknown"] as const),
        anchor: idOf(1),
        reports: lines.map((line) => line.report),
        areas: [...new Map(lines.flatMap((line) => line.areas).map((area) => [JSON.stringify(area), area])).values()],
        lines,
      });
      expect(incidentSchema.safeParse(whole).success).toBe(true);
      const rules: LevelRule[] = Array.from({ length: r.int(0, 2) }, () => ({
        ...(r.chance(0.5) ? { places: [r.pick([home, other])] } : {}),
        max: r.pick(ASSESSED_LEVELS),
      }));
      const at = r.chance(0.8) ? r.int(0, 3 * EARTHQUAKE_PAST_WITHIN) : undefined;
      const result = assess(whole, person(rules), places, DEFAULT_ASSESS_POLICY, at);
      expect(assessmentSchema.safeParse(result).success).toBe(true);
      const alone = lines.map((line) => {
        const onset = line.onset === undefined ? {} : { onset: line.onset };
        return assess(incident({ kind, status, severity: line.severity, urgency: line.urgency, areas: line.areas, ...onset }), person(rules), places, DEFAULT_ASSESS_POLICY, at).level;
      });
      expect(result.level).toBe(alone.reduce(higherLevel, "none"));
    }
  });
});

describe("the urgency past of a recent event (AL-31)", () => {
  // A made-up earthquake. Its report tells of shaking that occurred, so its urgency is `past`.
  const onset = 1_800_000_000_000;
  const quake = (fields: Draft = {}): Incident => incident({ kind: "geo.earthquake", urgency: "past", onset, ...fields });
  const after = (minutes: number): number => onset + minutes * 60_000;
  const levelAt = (draft: Incident, at?: number): AssessedLevel => assess(draft, person(), places, DEFAULT_ASSESS_POLICY, at).level;
  const tableReason = (draft: Incident, at?: number): AssessReason | undefined => assess(draft, person(), places, DEFAULT_ASSESS_POLICY, at).reasons.find((reason) => reason.kind === "table");

  it("counts a recent past as immediate, and then the severity decides", () => {
    expect(levelAt(quake(), after(10))).toBe("life-safety");
    expect(levelAt(quake({ severity: "severe" }), after(10))).toBe("urgent");
    expect(levelAt(quake({ severity: "moderate" }), after(10))).toBe("notice");
    expect(levelAt(quake({ severity: "minor" }), after(10))).toBe("digest");
    // The window holds its end. After the window, the report is a digest.
    expect(levelAt(quake(), onset + EARTHQUAKE_PAST_WITHIN)).toBe("life-safety");
    expect(levelAt(quake(), onset + EARTHQUAKE_PAST_WITHIN + 1)).toBe("digest");
  });

  it("counts a past of unknown age as recent", () => {
    expect(levelAt(quake())).toBe("life-safety");
    expect(levelAt(incident({ kind: "geo.earthquake", urgency: "past" }), after(600))).toBe("life-safety");
  });

  it("tells the window in the reason of the table", () => {
    expect(tableReason(quake(), after(10))).toMatchObject({ class: "earthquake", byUrgency: "life-safety", recentPast: true });
    expect(tableReason(quake(), after(120))).not.toHaveProperty("recentPast");
    expect(tableReason(quake({ urgency: "immediate" }), after(10))).not.toHaveProperty("recentPast");
    expect(assessmentSchema.safeParse(assess(quake(), person(), places, DEFAULT_ASSESS_POLICY, after(10))).success).toBe(true);
  });

  it("keeps the past of a table with no window, and keeps an early warning in the life-safety class", () => {
    expect(levelAt(incident({ kind: "met.tornado", urgency: "past", onset }), after(10))).toBe("digest");
    expect(classOf(DEFAULT_ASSESS_POLICY, "geo.earthquake")?.id).toBe("earthquake");
    const warning = { kind: { code: "geo.earthquake.early-warning", label: "" }, severity: "severe", urgency: "immediate" } as const;
    expect(tableLevel(DEFAULT_ASSESS_POLICY, warning)).toMatchObject({ class: "life-safety", level: "life-safety" });
  });

  it("gives an earthquake life-safety exactly as the rule of docs/CONTRACTS.md tells", () => {
    const ages = [undefined, 0, EARTHQUAKE_PAST_WITHIN, EARTHQUAKE_PAST_WITHIN + 1, 10 * EARTHQUAKE_PAST_WITHIN];
    for (const status of STATUSES) {
      for (const severity of [...SEVERITIES, "unknown"] as const) {
        for (const urgency of [...URGENCIES, "unknown"] as const) {
          for (const age of ages) {
            const level = levelAt(quake({ status, severity, urgency }), age === undefined ? undefined : onset + age);
            const recent = urgency === "past" && (age === undefined || age <= EARTHQUAKE_PAST_WITHIN);
            const expected = status === "actual" && ["extreme", "unknown"].includes(severity) && (["immediate", "expected", "unknown"].includes(urgency) || recent);
            expect([status, severity, urgency, age, level === "life-safety"]).toEqual([status, severity, urgency, age, expected]);
          }
        }
      }
    }
  });

  // The gate of the window: it raises only a report with the urgency `past`, only in the window, and the level does not rise with the age.
  it.each(SEEDS)("raises only a recent past report, and the level does not rise with the age (seed %i)", (seed) => {
    const r = random(seed);
    const noWindow = (table: KindClass): KindClass => ({
      id: table.id,
      kinds: table.kinds,
      ...(table.statuses === undefined ? {} : { statuses: table.statuses }),
      severity: table.severity,
      urgency: table.urgency,
    });
    const without: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, classes: DEFAULT_ASSESS_POLICY.classes.map(noWindow) };
    const kinds = ["geo.earthquake", "geo.earthquake.early-warning", "met.tornado", "geo.tsunami", "met.wind.high"];
    for (let round = 0; round < 300; round += 1) {
      const draft = incident({
        kind: r.pick(kinds),
        status: r.chance(0.8) ? "actual" : r.pick(STATUSES),
        severity: r.pick([...SEVERITIES, "unknown"] as const),
        urgency: r.chance(0.5) ? "past" : r.pick([...URGENCIES, "unknown"] as const),
        ...(r.chance(0.8) ? { onset } : {}),
      });
      const rules: LevelRule[] = Array.from({ length: r.int(0, 2) }, () => ({ max: r.pick(ASSESSED_LEVELS) }));
      const [early, late] = [r.int(0, 3 * EARTHQUAKE_PAST_WITHIN), r.int(0, 3 * EARTHQUAKE_PAST_WITHIN)].sort((a, b) => a - b) as [number, number];
      const at = (age: number): number => onset + age;
      const level = (age: number, policy: AssessPolicy = DEFAULT_ASSESS_POLICY): AssessedLevel => assess(draft, person(rules), places, policy, at(age)).level;
      const old = level(early, without);
      const found = tableLevel(DEFAULT_ASSESS_POLICY, draft, at(early));
      expect(rank(level(early))).toBeGreaterThanOrEqual(rank(old));
      if (found.recentPast !== true) expect(level(early)).toBe(old);
      expect(rank(level(early))).toBeGreaterThanOrEqual(rank(level(late)));
    }
  });
});

describe("the subject watches of a system of paths", () => {
  it("match each subject that overlaps the watch, and not a sibling", () => {
    const about = (id: string) => ({ about: [{ system: "provider-region", id }] });
    const watch = { system: "provider-region", id: "example/region-1/sms" };
    expect(matchSubjects(about("example/region-1"), [watch])).toEqual([watch]);
    expect(matchSubjects(about("example/region-1/sms/part"), [watch])).toEqual([watch]);
    expect(matchSubjects(about("example/region-1/voice"), [watch])).toEqual([]);
    expect(matchSubjects(about("example/region-10/sms"), [watch])).toEqual([]);
  });
});

describe("the fire zones (AL-33)", () => {
  // A fire zone and a forecast zone can have one code and different outlines. Each code is a code of Kansas or Texas.
  const fire = (code: string) => ({ type: "code", system: "ugc-fire", code }) as const;
  const forecast = { system: "ugc", code: "KSZ083" } as const;
  const noFire: WatchedPlace = { id: home, codes: [forecast, { system: "state", code: "KS" }], bufferKm: 0 };
  const withFire: WatchedPlace = { id: other, codes: [forecast, { system: "ugc-fire", code: "KSZ084" }, { system: "ugc", code: "TXZ205" }], bufferKm: 0 };

  it("matches a place with no fire zone code of the state through its forecast zone code, and tells it", () => {
    expect(matchPlaces({ areas: [fire("KSZ083")] }, [noFire])).toEqual([{ place: home, codes: [forecast], zoneFallback: true }]);
    const result = assess(incident({ kind: "fire.weather", areas: [fire("KSZ083")] }), person([], [home]), [noFire]);
    expect(result.reasons.find((one) => one.kind === "place")).toEqual({ kind: "place", place: home, codes: [forecast], zoneFallback: true });
    expect(assessmentSchema.safeParse(result).success).toBe(true);
  });

  it("does not use the fallback for a place with a fire zone code of that state", () => {
    expect(matchPlaces({ areas: [fire("KSZ083")] }, [withFire])).toEqual([]);
    expect(matchPlaces({ areas: [fire("KSZ084")] }, [withFire])).toEqual([{ place: other, codes: [{ system: "ugc-fire", code: "KSZ084" }] }]);
    // The place has no fire zone code of Texas, thus a Texas fire zone uses its forecast zone code.
    expect(matchPlaces({ areas: [fire("TXZ205")] }, [withFire])).toEqual([{ place: other, codes: [{ system: "ugc", code: "TXZ205" }], zoneFallback: true }]);
  });

  it("does not tell the fallback when a forecast zone code of the areas also covers the code, and a forecast zone code does not cover a fire zone", () => {
    expect(matchPlaces({ areas: [fire("KSZ083"), { type: "code", ...forecast }] }, [noFire])).toEqual([{ place: home, codes: [forecast] }]);
    const onlyFire: WatchedPlace = { id: home, codes: [{ system: "ugc-fire", code: "KSZ083" }], bufferKm: 0 };
    expect(matchPlaces({ areas: [{ type: "code", ...forecast }] }, [onlyFire])).toEqual([]);
  });

  it("refuses a reason with a flag that is not true", () => {
    const result = assess(incident({ kind: "fire.weather", areas: [fire("KSZ083")] }), person([], [home]), [noFire]);
    const reasons = result.reasons.map((one) => (one.kind === "place" ? { ...one, zoneFallback: false } : one));
    expect(assessmentSchema.safeParse({ ...result, reasons }).success).toBe(false);
  });
});

describe("a private incident (AL-92)", () => {
  const addressed = "person-1" as PersonId;
  const stranger = "person-9" as PersonId;

  it("gives no level to a person outside its addresses, also at a watched place in its areas", () => {
    const secret = incident({ addresses: [addressed] });
    const result = assess(secret, { ...person(), person: stranger }, places);
    expect(result).toEqual({ incident: secret.anchor, person: stranger, level: "none", places: [], reasons: [{ kind: "not-addressed" }] });
    expect(assessmentSchema.safeParse(result).success).toBe(true);
  });

  it("gives the level of the table to a person of its addresses, with no area and no watched place", () => {
    const secret = incident({ addresses: [addressed], areas: [] });
    const result = assess(secret, person([], []), places);
    expect(result.level).toBe("life-safety");
    expect(result.reasons.map((reason) => reason.kind)).toEqual(["table", "addressed"]);
    expect(assessmentSchema.safeParse(result).success).toBe(true);
    // A public incident with no area and no subject reaches nobody.
    expect(assess(incident({ areas: [] }), person([], []), places).level).toBe("none");
  });

  it("keeps the rules of the person: a rule of each place can lower the level, and a rule of one place cannot", () => {
    const secret = incident({ addresses: [addressed], areas: [] });
    expect(assess(secret, person([{ max: "notice" }]), places).level).toBe("notice");
    expect(assess(secret, person([{ max: "notice", places: [home] }]), places).level).toBe("life-safety");
  });

  it("gives no level to a person of its addresses after its end", () => {
    expect(assess(incident({ addresses: [addressed], live: false }), person(), places).level).toBe("none");
  });

  it("gives a message of the operator `urgent` for an urgent need and `notice` for each other class, only with the status system", () => {
    const tell = (code: string, severity: Incident["severity"], urgency: Incident["urgency"], status: Incident["status"] = "system") =>
      assess(incident({ kind: code, status, severity, urgency, addresses: [addressed], areas: [] }), person([], []), places).level;
    expect(tell("system.tell.needs-you", "severe", "immediate")).toBe("urgent");
    expect(tell("system.tell.needs-you", "moderate", "expected")).toBe("notice");
    expect(tell("system.tell.done-you-asked", "moderate", "expected")).toBe("notice");
    expect(tell("system.tell.live", "moderate", "expected")).toBe("notice");
    // The class reaches `urgent` at most, also with the highest values.
    expect(tell("system.tell.needs-you", "extreme", "immediate")).toBe("urgent");
    // The class admits only the status `system`.
    expect(tell("system.tell.live", "moderate", "expected", "actual")).toBe("none");
  });
});
