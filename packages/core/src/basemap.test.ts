import { EARTH_MEAN_RADIUS_KM, GeoError } from "@mark1russell7/geo";
import { describe, expect, it } from "vitest";
import { basemapToleranceKm, MAP_VIEW, simplifyBasemap } from "./basemap.ts";
import type { Position } from "./contracts.ts";
import type { MapRegion, MapShape } from "./map.ts";

/** This function gives a region with one polygon of one ring. */
const region = (code: string, ring: readonly Position[], name = `Zone ${code}`): MapRegion => ({ code: { system: "ugc", code }, name, shapes: [{ type: "polygon", rings: [ring] }] });

/** This function gives a closed ring around a box. */
const box = (west: number, south: number, east: number, north: number): Position[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

/** This function counts the positions of the polygons of regions. */
const positions = (regions: readonly MapRegion[]): number =>
  regions.reduce((total, one) => total + one.shapes.reduce((sum, shape) => sum + (shape.type === "polygon" ? shape.rings.reduce((n, ring) => n + ring.length, 0) : 0), 0), 0);

/** This function gives the positions of the polygons of a region as text, once each. */
const keys = (one: MapRegion): Set<string> => new Set(one.shapes.flatMap((shape) => (shape.type === "polygon" ? shape.rings.flat().map(([lon, lat]) => `${String(lon)},${String(lat)}`) : [])));

// Two public counties of Kansas side by side. The shared border at the longitude -97 has 49 positions that go 11 m east and west.
const BORDER: Position[] = Array.from({ length: 49 }, (_, index): Position => [-97 + (index % 2 === 0 ? 0.0001 : -0.0001), 37 + (index + 1) / 50]);
const WEST = region("KSC173", [[-98, 37], [-97, 37], ...BORDER, [-97, 38], [-98, 38], [-98, 37]], "Sedgwick");
const EAST = region("KSC015", [[-97, 37], [-96, 37], [-96, 38], [-97, 38], ...[...BORDER].reverse(), [-97, 37]], "Butler");
// A forecast zone over the two counties, with extra positions on its south edge. It is of the other rank, so it does not join them.
const ZONE = region("KSZ083", [[-98, 37], [-97.5, 37], [-97, 37], [-96.5, 37], [-96, 37], [-96, 38], [-98, 38], [-98, 37]]);

describe("basemapToleranceKm", () => {
  it("gives half of one unit of the view box near the equator", () => {
    // 10 degrees of longitude at the equator are 1112 km, in 952 units of the view box: 1.168 km for each unit.
    expect(MAP_VIEW.width - 2 * MAP_VIEW.pad).toBe(952);
    // The box goes to 1 degree north, and the cosine of 1 degree is 0.99985.
    expect(basemapToleranceKm([region("A", box(0, 0, 10, 1))])).toBeCloseTo(0.5839, 4);
  });

  it("measures the unit at the latitude farthest from the equator, where one unit covers the least ground", () => {
    // At 61 degrees, 10 degrees of longitude are 539 km. The cosine of 61 degrees is 0.4848.
    expect(basemapToleranceKm([region("A", box(0, 60, 10, 61))])).toBeCloseTo(0.2831, 4);
    expect(basemapToleranceKm([region("A", box(0, -61, 10, -60))])).toBeCloseTo(0.2831, 4);
    // A box across the equator has its smallest unit at its north or south edge.
    expect(basemapToleranceKm([region("A", box(0, -1, 10, 1))])).toBeCloseTo(0.5839, 4);
    // Half of one unit at the farthest latitude is half of one unit or less at each latitude of the box.
    // The width decides the fit of this box: 40 degrees of longitude in 952 units.
    const tolerance = basemapToleranceKm([region("A", box(0, 20, 40, 30))])!;
    const unitAt = (lat: number): number => (EARTH_MEAN_RADIUS_KM * Math.cos((lat * Math.PI) / 180) * ((40 * Math.PI) / 180)) / 952;
    for (const lat of [20, 25, 30]) expect(tolerance / unitAt(lat)).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(tolerance / unitAt(30)).toBeCloseTo(0.5, 12);
  });

  it("uses the height of the box when the height decides the fit", () => {
    // 1 degree of latitude at the equator is 111.2 km, in 592 units of the height: 0.188 km for each unit.
    expect(basemapToleranceKm([region("A", box(0, 0, 1, 1))])).toBeCloseTo(0.0939, 4);
  });

  it("reads the extent of all the regions, and only their polygons", () => {
    const circle: MapShape = { type: "circle", center: [40, 0], radiusKm: 500 };
    const regions = [region("A", box(0, 0, 5, 1)), region("B", box(5, 0, 10, 1)), { code: { system: "ugc", code: "C" }, name: "C", shapes: [circle] }];
    expect(basemapToleranceKm(regions)).toBeCloseTo(0.5839, 4);
  });

  it("gives no tolerance with no polygon or with no extent", () => {
    expect(basemapToleranceKm([])).toBeUndefined();
    expect(basemapToleranceKm([{ code: { system: "ugc", code: "C" }, name: "C", shapes: [{ type: "circle", center: [0, 0], radiusKm: 1 }] }])).toBeUndefined();
    expect(basemapToleranceKm([region("A", [[1, 1], [1, 1], [1, 1], [1, 1]])])).toBeUndefined();
  });

  // The page fits with no rotation. Thus regions on the two sides of the antimeridian fill its full width (AL-176).
  it("fits regions on the two sides of the antimeridian across the full span of their longitudes", () => {
    const tolerance = basemapToleranceKm([region("A", box(-179, 51, -170, 52)), region("B", box(170, 51, 179, 52))]);
    // 358 degrees of longitude in 952 units, at the cosine of 52 degrees: 0.6157.
    const unit = (EARTH_MEAN_RADIUS_KM * Math.cos((52 * Math.PI) / 180) * ((358 * Math.PI) / 180)) / 952;
    expect(tolerance).toBeCloseTo(unit / 2, 9);
    expect(tolerance!).toBeGreaterThan(basemapToleranceKm([region("A", box(-179, 51, -170, 52))])!);
  });
});

describe("simplifyBasemap", () => {
  it("removes the positions near the line, and the shared border stays one border", () => {
    const result = simplifyBasemap([WEST, EAST], 1);
    expect(positions(result)).toBeLessThan(positions([WEST, EAST]));
    // Each position of the result is a position of the input.
    for (const [at, one] of result.entries()) for (const key of keys(one)) expect(keys([WEST, EAST][at]!).has(key)).toBe(true);
    // The positions of the result at the shared border are the same in the two counties.
    const border = (one: MapRegion): string[] => [...keys(one)].filter((key) => Math.abs(Number(key.split(",")[0]) + 97) < 0.001).sort();
    expect(border(result[0]!)).toEqual(border(result[1]!));
    expect(border(result[0]!).length).toBeLessThan(BORDER.length);
  });

  it("keeps the code, the name and the order of the regions, and the ranks do not join", () => {
    const result = simplifyBasemap([EAST, ZONE, WEST], 1);
    expect(result.map((one) => [one.code.code, one.name])).toEqual([
      ["KSC015", "Butler"],
      ["KSZ083", "Zone KSZ083"],
      ["KSC173", "Sedgwick"],
    ]);
    // The zone is alone in its rank. Its south edge is a straight line, thus only its 4 corners stay.
    expect(keys(result[1]!)).toEqual(new Set(["-98,37", "-96,37", "-96,38", "-98,38"]));
  });

  it("keeps each circle in its place, and a region with no polygon as it is", () => {
    const circle: MapShape = { type: "circle", center: [-97, 37.5], radiusKm: 3 };
    const mixed: MapRegion = { ...WEST, shapes: [circle, ...WEST.shapes] };
    const round: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [circle] };
    const [first, second] = simplifyBasemap([mixed, round], 1);
    expect(first!.shapes[0]).toBe(circle);
    expect(first!.shapes[1]!.type).toBe("polygon");
    expect(second).toBe(round);
  });

  it("keeps each polygon of a region with many parts", () => {
    const parts: MapRegion = { code: { system: "ugc", code: "TXC167" }, name: "Galveston", shapes: [{ type: "polygon", rings: [box(-95, 29, -94.5, 29.5)] }, { type: "polygon", rings: [box(-94.4, 29, -94, 29.5)] }] };
    const [result] = simplifyBasemap([parts], 1);
    expect(result!.shapes).toHaveLength(2);
    expect(result!.shapes.every((shape) => shape.type === "polygon")).toBe(true);
  });

  it("throws the error of geo for a tolerance less than 0", () => {
    expect(() => simplifyBasemap([WEST], -1)).toThrow(GeoError);
  });
});
