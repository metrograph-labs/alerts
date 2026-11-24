import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { SeriesRead } from "./baseline.ts";
import { areaMeetsPlace, breadthOf, indicatorBreadth, watchedStates, type SeriesSignal, type ZoneRegions } from "./breadth.ts";
import type { DimensionId, IndicatorArea, PlaceId, Position, WatchedPlace } from "./contracts.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// A place in Wichita, Kansas, with its county (Sedgwick, SAME 020173) and a buffer of 25 km.
const WICHITA: Position = [-97.34, 37.69];
const city: WatchedPlace = { id: "place-1" as PlaceId, at: WICHITA, codes: [{ system: "same", code: "020173" }], bufferKm: 25 };
// A place in Topeka, Kansas, with no position: only its codes match.
const capital: WatchedPlace = { id: "place-2" as PlaceId, codes: [{ system: "ugc", code: "KSZ040" }], bufferKm: 25 };

const signal: SeriesRead = { kind: "score", at: 0, score: 5, signal: true, center: 10, samples: 20 };
const calm: SeriesRead = { kind: "score", at: 0, score: 0.4, signal: false, center: 10, samples: 20 };
const flagged: SeriesRead = { kind: "flag", at: 0, signal: true };
const stale: SeriesRead = { kind: "no-read", cause: "stale" };

const near: IndicatorArea = { type: "point", at: [-97.3, 37.7] };
const far: IndicatorArea = { type: "point", at: [-95.68, 39.05] };
const world: IndicatorArea = { type: "world" };

function one(series: string, dimension: DimensionId, area: IndicatorArea, read: SeriesRead): SeriesSignal {
  return { series, dimension, area, read };
}

describe("breadthOf", () => {
  it("counts the dimensions with a signal, in the order of the dimensions", () => {
    const breadth = breadthOf([
      one("a", "rail", near, signal),
      one("b", "road-traffic", near, calm),
      one("c", "road-traffic", near, signal),
      one("d", "power-demand", near, stale),
      one("e", "aviation-delays", near, flagged),
    ]);
    expect(breadth.signals).toEqual(["road-traffic", "rail", "aviation-delays"]);
    expect(breadth.read).toEqual(["road-traffic", "rail", "aviation-delays"]);
    expect(breadth.dimensions).toEqual([
      { dimension: "road-traffic", read: 2, signals: 1, noRead: 0 },
      { dimension: "rail", read: 1, signals: 1, noRead: 0 },
      { dimension: "aviation-delays", read: 1, signals: 1, noRead: 0 },
      { dimension: "power-demand", read: 0, signals: 0, noRead: 1 },
    ]);
  });

  it("counts a key one time, with its higher read", () => {
    const breadth = breadthOf([one("a", "rail", near, stale), one("a", "rail", near, signal), one("a", "rail", near, calm)]);
    expect(breadth.dimensions).toEqual([{ dimension: "rail", read: 1, signals: 1, noRead: 0 }]);
  });

  it("gives empty lists for no series", () => {
    expect(breadthOf([])).toEqual({ signals: [], read: [], dimensions: [] });
  });
});

describe("areaMeetsPlace", () => {
  it("matches a code by the rule of regionCovers", () => {
    expect(areaMeetsPlace({ type: "code", system: "same", code: "020000" }, city)).toBe(true);
    expect(areaMeetsPlace({ type: "code", system: "same", code: "020173" }, city)).toBe(true);
    expect(areaMeetsPlace({ type: "code", system: "same", code: "020177" }, city)).toBe(false);
    expect(areaMeetsPlace({ type: "code", system: "ugc", code: "KSZ040" }, capital)).toBe(true);
  });

  it("matches a point, a line and a polygon in the buffer of a place with a position", () => {
    expect(areaMeetsPlace(near, city)).toBe(true);
    expect(areaMeetsPlace(far, city)).toBe(false);
    expect(areaMeetsPlace({ type: "line", path: [[-97.5, 37.8], [-97.2, 37.8]] }, city)).toBe(true);
    expect(areaMeetsPlace({ type: "line", path: [[-96.0, 38.5], [-95.9, 38.6]] }, city)).toBe(false);
    const cell: IndicatorArea = { type: "polygon", rings: [[[-97.4, 37.6], [-97.2, 37.6], [-97.2, 37.8], [-97.4, 37.8], [-97.4, 37.6]]] };
    expect(areaMeetsPlace(cell, city)).toBe(true);
  });

  it("matches no point, line or polygon for a place with no position", () => {
    expect(areaMeetsPlace(near, capital)).toBe(false);
    expect(areaMeetsPlace({ type: "line", path: [[-95.7, 39.0], [-95.6, 39.1]] }, capital)).toBe(false);
  });

  it("matches a zone by the regions of the table, and gives no answer for a zone out of the table", () => {
    const zone: IndicatorArea = { type: "zone", system: "eic", code: "zone-1" };
    const zones: ZoneRegions[] = [{ system: "eic", code: "zone-1", regions: [{ system: "same", code: "020000" }] }];
    expect(areaMeetsPlace(zone, city, zones)).toBe(true);
    expect(areaMeetsPlace(zone, capital, zones)).toBe(false);
    expect(areaMeetsPlace(zone, city)).toBeUndefined();
  });

  it("matches no world area, and gives no answer for a shape that geo refuses", () => {
    expect(areaMeetsPlace(world, city)).toBe(false);
    const broken: IndicatorArea = { type: "polygon", rings: [[[-97.4, 37.6], [-97.2, 37.6], [-97.4, 37.6]]] };
    expect(areaMeetsPlace(broken, city)).toBeUndefined();
  });
});

describe("indicatorBreadth", () => {
  it("gives the world each series and each place the series near it", () => {
    const series = [
      one("traffic-near", "road-traffic", near, signal),
      one("traffic-far", "road-traffic", far, signal),
      one("rail-county", "rail", { type: "code", system: "same", code: "020173" }, signal),
      one("market", "financial-markets", world, signal),
      one("zone-power", "power-demand", { type: "zone", system: "eic", code: "zone-9" }, signal),
    ];
    const breadth = indicatorBreadth(series, [city, capital]);
    expect(breadth.world.signals).toEqual(["road-traffic", "rail", "power-demand", "financial-markets"]);
    expect(breadth.world.dimensions[0]).toEqual({ dimension: "road-traffic", read: 2, signals: 2, noRead: 0 });
    expect(breadth.places.map((place) => [place.place, place.signals])).toEqual([
      [city.id, ["road-traffic", "rail"]],
      [capital.id, []],
    ]);
    expect(breadth.unplaced).toEqual(["zone-power"]);
  });

  it("puts a zone out of the table in unplaced with no place", () => {
    const breadth = indicatorBreadth([one("z", "grid-frequency", { type: "zone", system: "eic", code: "x" }, calm)], []);
    expect(breadth.unplaced).toEqual(["z"]);
    expect(breadth.places).toEqual([]);
  });
});

// A seeded set of series around the place: each area kind, each read kind and a few dimensions.
function seededSeries(seed: string): SeriesSignal[] {
  const r = random(seed);
  const dimensions: DimensionId[] = ["road-traffic", "rail", "aviation-delays", "power-demand", "river-levels", "financial-markets"];
  const reads: SeriesRead[] = [signal, calm, flagged, stale, { kind: "flag", at: 0, signal: false }];
  const areas = (): IndicatorArea =>
    r.pick<IndicatorArea>([
      { type: "point", at: [WICHITA[0] + r.range(-0.6, 0.6), WICHITA[1] + r.range(-0.6, 0.6)] },
      { type: "code", system: "same", code: r.pick(["020173", "020000", "020177"]) },
      { type: "code", system: "ugc", code: "KSZ040" },
      { type: "zone", system: "eic", code: r.pick(["zone-1", "zone-2"]) },
      world,
    ]);
  return Array.from({ length: r.int(0, 40) }, () => one(`s${r.int(0, 25)}`, r.pick(dimensions), areas(), r.pick(reads)));
}

const ZONES: ZoneRegions[] = [{ system: "eic", code: "zone-1", regions: [{ system: "same", code: "020000" }] }];

describe("indicatorBreadth is a function of the set of the series", () => {
  it("gives one result for each order of the series and with duplicates (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`breadth-order:${seed}`);
      const series = seededSeries(`breadth-order-series:${seed}`);
      const shuffled = r.shuffle([...series, ...r.sample(series, r.int(0, series.length))]);
      expect(indicatorBreadth(shuffled, [city, capital], ZONES), `seed ${r.seed}`).toEqual(indicatorBreadth(series, [city, capital], ZONES));
    }
  });

  it("keeps each count in its bounds, and a place never has more than the world (seeded)", () => {
    for (const seed of SEEDS) {
      const series = seededSeries(`breadth-bounds:${seed}`);
      const breadth = indicatorBreadth(series, [city, capital], ZONES);
      for (const group of [breadth.world, ...breadth.places]) {
        for (const count of group.dimensions) {
          expect(count.signals, `seed ${seed}`).toBeLessThanOrEqual(count.read);
          expect(count.read + count.noRead, `seed ${seed}`).toBeGreaterThan(0);
        }
        expect(group.signals.every((dimension) => group.read.includes(dimension)), `seed ${seed}`).toBe(true);
        expect(group.signals.every((dimension) => breadth.world.signals.includes(dimension)), `seed ${seed}`).toBe(true);
      }
    }
  });

  it("never lowers a breadth when a series gets a signal (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`breadth-monotone:${seed}`);
      const series = seededSeries(`breadth-monotone-series:${seed}`);
      if (series.length === 0) continue;
      const index = r.below(series.length);
      const raised = series.map((item, at) => (at === index ? { ...item, read: signal } : item));
      const before = indicatorBreadth(series, [city, capital], ZONES);
      const after = indicatorBreadth(raised, [city, capital], ZONES);
      for (const [low, high] of [[before.world, after.world], ...before.places.map((place, at) => [place, after.places[at]] as const)]) {
        expect(high?.signals.length, `seed ${r.seed}`).toBeGreaterThanOrEqual(low?.signals.length ?? 0);
      }
    }
  });
});

describe("watchedStates", () => {
  const statePlace = (id: string, state: string): WatchedPlace => ({ id: id as PlaceId, codes: [{ system: "state", code: state }, { system: "iso3166", code: "US" }], bufferKm: 0 });
  it("gives each US state of the places once, in order, and no territory or other code", () => {
    const none: WatchedPlace = { id: "none" as PlaceId, codes: [], bufferKm: 0 };
    const iso: WatchedPlace = { id: "iso" as PlaceId, codes: [{ system: "iso3166", code: "US-TX" }], bufferKm: 0 };
    expect(watchedStates([statePlace("b", "TX"), statePlace("a", "CA"), statePlace("c", "TX"), none])).toEqual(["CA", "TX"]);
    expect(watchedStates([statePlace("pr", "PR"), iso, statePlace("long", "TEX")])).toEqual([]);
  });
});
