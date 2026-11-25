import { readFileSync } from "node:fs";
import { FELT_INTENSITY } from "@mark1russell7/alerts-quake";
import { locatePoint } from "@mark1russell7/geo";
import { describe, expect, it } from "vitest";
import { intensityGridOf, readShakeContours, SHAKEMAP_GRID, shakeContours, shakeProductOf, type ShakeContours } from "./shakemap.ts";

/** The real detail of the M4.1 event `us6000ude6`, and the real low-resolution grid of its ShakeMap. */
const DETAIL: unknown = JSON.parse(readFileSync(new URL("../fixtures/detail-us6000ude6.geojson", import.meta.url), "utf8"));
const COVERAGE = JSON.parse(readFileSync(new URL("../fixtures/shakemap-us6000ude6-mmi-low.covjson", import.meta.url), "utf8")) as {
  ranges: { MMI: Record<string, unknown> };
};
const EPICENTER = { lon: -104.8395, lat: 36.9498 };

const regionOf = (contours: ShakeContours, from: number) => {
  const band = contours.bands.find((each) => each.from === from);
  if (band === undefined) throw new Error(`no band ${from}`);
  return { type: "MultiPolygon" as const, coordinates: band.polygons.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => [lon, lat]))) };
};

describe("shakeProductOf", () => {
  it("gives the version and the grid of the preferred ShakeMap product", () => {
    const product = shakeProductOf(DETAIL);
    expect(product?.version).toBe("1795616312537");
    expect(product?.gridUrl).toMatch(/^https:\/\/earthquake\.usgs\.gov\/.+\/coverage_mmi_low_res\.covjson$/);
    expect(product?.gridUrl.endsWith(SHAKEMAP_GRID)).toBe(true);
  });

  it("gives undefined for a detail with no ShakeMap or no grid", () => {
    expect(shakeProductOf({ properties: { products: {} } })).toBeUndefined();
    expect(shakeProductOf({ properties: { products: { shakemap: [{ updateTime: 1, contents: {} }] } } })).toBeUndefined();
    expect(shakeProductOf({ properties: { products: { shakemap: [{ updateTime: 1, contents: { [SHAKEMAP_GRID]: { url: "http://x" } } }] } } })).toBeUndefined();
    expect(shakeProductOf(null)).toBeUndefined();
  });
});

describe("intensityGridOf", () => {
  it("reads the axes and the values of the real grid", () => {
    const grid = intensityGridOf(COVERAGE);
    expect(grid?.x).toEqual({ start: -105.95, stop: -103.69933387893836, num: 51 });
    expect(grid?.y.num).toBe(51);
    expect(grid?.values).toHaveLength(51 * 51);
  });

  it("refuses a range with other axis names, another shape or a value that is not a number", () => {
    const withRange = (change: Record<string, unknown>): unknown => ({ ...COVERAGE, ranges: { MMI: { ...COVERAGE.ranges.MMI, ...change } } });
    expect(intensityGridOf(withRange({ axisNames: ["x", "y"] }))).toBeUndefined();
    expect(intensityGridOf(withRange({ shape: [51, 50] }))).toBeUndefined();
    expect(intensityGridOf(withRange({ values: ["1"] }))).toBeUndefined();
    expect(intensityGridOf({ ...COVERAGE, type: "Grid" })).toBeUndefined();
  });
});

describe("shakeContours", () => {
  const grid = intensityGridOf(COVERAGE);
  if (grid === undefined) throw new Error("the fixture has no grid");
  const contours = shakeContours("1795616312537", grid);

  it("gives the region of each band that the grid reaches, with the epicenter in the felt region", () => {
    // The strongest value of the low-resolution grid is 4.9, so only the felt band has a region.
    expect(contours.bands.map((band) => band.from)).toEqual([FELT_INTENSITY]);
    const felt = regionOf(contours, FELT_INTENSITY);
    expect(locatePoint(EPICENTER, felt)).toBe("inside");
    // The south-west corner of the grid has the value 2.6.
    expect(locatePoint({ lon: -105.9, lat: 36.1 }, felt)).toBe("outside");
  });

  it("keeps the body small, with rounded positions", () => {
    expect(JSON.stringify(contours).length).toBeLessThan(8000);
    for (const band of contours.bands) for (const rings of band.polygons) for (const ring of rings) for (const [lon, lat] of ring) expect([lon * 1e4, lat * 1e4].every((value) => Math.abs(value - Math.round(value)) < 1e-6)).toBe(true);
  });

  it("reads its own JSON again, and refuses a different structure", () => {
    expect(readShakeContours(JSON.parse(JSON.stringify(contours)))).toEqual(contours);
    const [band] = contours.bands;
    if (band === undefined) throw new Error("no band");
    expect(readShakeContours({ ...contours, bands: [{ ...band, from: 4.2 }] })).toBeUndefined();
    expect(readShakeContours({ ...contours, bands: [{ ...band, polygons: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] }] })).toBeUndefined();
    expect(readShakeContours({ ...contours, bands: [{ ...band, polygons: [] }] })).toBeUndefined();
    expect(readShakeContours({ bands: [] })).toBeUndefined();
  });

  it("refuses a grid across the antimeridian", () => {
    expect(() => shakeContours("1", { ...grid, x: { start: 178, stop: 182, num: 51 } })).toThrow();
  });
});
