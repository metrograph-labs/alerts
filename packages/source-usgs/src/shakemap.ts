/**
 * The ShakeMap product of an event: the map of the shaking that the USGS makes for a felt event. The product has a
 * grid of the intensity (MMI) in CoverageJSON. The region of each band of the shaking on that grid replaces the disc
 * of the band.
 *
 * The fetch reads the low-resolution grid (`SHAKEMAP_GRID`) and keeps only the rings of each band, simplified and
 * rounded. Thus the body of an observation stays small. The map reads the rings again with `readShakeContours`.
 */

import type { Area } from "@mark1russell7/alerts";
import { INTENSITY_BANDS } from "@mark1russell7/alerts-quake";
import { gridRegion, type GridAxis, type ValueGrid } from "@mark1russell7/geo";
import { isRecord } from "@mark1russell7/optional/read";

/** The key of the low-resolution grid of the intensity in the contents of a ShakeMap product. */
export const SHAKEMAP_GRID = "download/coverage_mmi_low_res.covjson";

/** The tolerance of the simplification of the rings, in kilometres. The low-resolution grid has 2 to 5 km between two points. */
export const SHAKEMAP_TOLERANCE_KM = 1;

/** The count of the decimals of each coordinate of a ring: 0.0001 degree is approximately 11 metres. */
const DIGITS = 4;

/** The rings of one polygon: the first ring is the outside, and each other ring is a hole. */
export type ShakeRings = Extract<Area, { readonly type: "polygon" }>["rings"];

/** The region of one band of the shaking on the grid. */
export interface ShakeBand {
  /** The lowest intensity of the band: the value `from` of the band of `INTENSITY_BANDS`. */
  readonly from: number;
  /** The polygons of the region. */
  readonly polygons: readonly ShakeRings[];
}

/** The regions of the bands of one version of the ShakeMap product of an event. */
export interface ShakeContours {
  /** The version of the product: its time of update, as text. */
  readonly version: string;
  /** The region of each band that the grid reaches, from the strongest band. */
  readonly bands: readonly ShakeBand[];
}

/** The preferred ShakeMap product of an event, from the detail of the event. */
export interface ShakeProduct {
  /** The version of the product: its time of update, as text. */
  readonly version: string;
  /** The URL of the low-resolution grid of the intensity. */
  readonly gridUrl: string;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * This function gives the preferred ShakeMap product of the detail of an event (the GeoJSON of one event). The first
 * product of the list is the preferred one. A detail with no product or no grid gives `undefined`.
 */
export function shakeProductOf(detail: unknown): ShakeProduct | undefined {
  const properties = isRecord(detail) && isRecord(detail["properties"]) ? detail["properties"] : undefined;
  const products = properties !== undefined && isRecord(properties["products"]) ? properties["products"] : undefined;
  const list = products?.["shakemap"];
  const product: unknown = Array.isArray(list) ? list[0] : undefined;
  if (!isRecord(product) || !isFiniteNumber(product["updateTime"]) || !isRecord(product["contents"])) return undefined;
  const grid = product["contents"][SHAKEMAP_GRID];
  const gridUrl = isRecord(grid) ? grid["url"] : undefined;
  if (typeof gridUrl !== "string" || !gridUrl.startsWith("https://")) return undefined;
  return { version: String(product["updateTime"]), gridUrl };
}

/** This function reads one regular axis of a CoverageJSON domain. */
function axisOf(value: unknown): GridAxis | undefined {
  if (!isRecord(value)) return undefined;
  const { start, stop, num } = value;
  return isFiniteNumber(start) && isFiniteNumber(stop) && isFiniteNumber(num) ? { start, stop, num } : undefined;
}

/**
 * This function reads the grid of the intensity of a ShakeMap coverage (CoverageJSON). The range `MMI` must have the
 * axis names `["y", "x"]` and the shape of the two axes. A different structure gives `undefined`.
 */
export function intensityGridOf(coverage: unknown): ValueGrid | undefined {
  if (!isRecord(coverage) || coverage["type"] !== "Coverage") return undefined;
  const domain = isRecord(coverage["domain"]) ? coverage["domain"] : undefined;
  const axes = domain !== undefined && isRecord(domain["axes"]) ? domain["axes"] : undefined;
  const x = axisOf(axes?.["x"]);
  const y = axisOf(axes?.["y"]);
  const ranges = isRecord(coverage["ranges"]) ? coverage["ranges"] : undefined;
  const range = ranges !== undefined && isRecord(ranges["MMI"]) ? ranges["MMI"] : undefined;
  if (x === undefined || y === undefined || range === undefined) return undefined;
  const { axisNames, shape, values } = range;
  const ordered = Array.isArray(axisNames) && axisNames.length === 2 && axisNames[0] === "y" && axisNames[1] === "x";
  const shaped = Array.isArray(shape) && shape.length === 2 && shape[0] === y.num && shape[1] === x.num;
  if (!ordered || !shaped || !Array.isArray(values) || !values.every((value) => value === null || isFiniteNumber(value))) return undefined;
  return { x, y, values: values as (number | null)[] };
}

const round = (value: number): number => Number(value.toFixed(DIGITS));

/**
 * This function gives the region of each band of `INTENSITY_BANDS` on a grid of the intensity. A band that the grid
 * does not reach has no region. The rings are simplified with `SHAKEMAP_TOLERANCE_KM` and rounded.
 *
 * @throws GeoError - For a grid that `gridRegion` refuses, for example a longitude more than 180.
 */
export function shakeContours(version: string, grid: ValueGrid): ShakeContours {
  const bands: ShakeBand[] = [];
  for (const band of INTENSITY_BANDS) {
    const region = gridRegion(grid, band.from, { toleranceKm: SHAKEMAP_TOLERANCE_KM });
    const polygons = region.type === "Polygon" ? [region.coordinates] : region.coordinates;
    if (polygons.length === 0) continue;
    bands.push({ from: band.from, polygons: polygons.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => [round(lon as number), round(lat as number)] as const))) });
  }
  return { version, bands };
}

/** This function tells if a value is a closed ring of four or more positions. */
function isRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4) return false;
  const valid = value.every((position) => Array.isArray(position) && position.length === 2 && isFiniteNumber(position[0]) && isFiniteNumber(position[1]) && Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90);
  const [first, last] = [value[0] as number[], value[value.length - 1] as number[]];
  return valid && first[0] === last[0] && first[1] === last[1];
}

/**
 * This function reads the contours of the body of an observation: the value of `shakeContours`. A band must have the
 * value `from` of a band of `INTENSITY_BANDS`. A different structure gives `undefined`.
 */
export function readShakeContours(value: unknown): ShakeContours | undefined {
  if (!isRecord(value) || typeof value["version"] !== "string" || !Array.isArray(value["bands"])) return undefined;
  const bands = value["bands"] as unknown[];
  const valid = bands.every(
    (band) =>
      isRecord(band) &&
      INTENSITY_BANDS.some((known) => known.from === band["from"]) &&
      Array.isArray(band["polygons"]) &&
      band["polygons"].length > 0 &&
      band["polygons"].every((rings: unknown) => Array.isArray(rings) && rings.length > 0 && rings.every(isRing)),
  );
  return valid ? { version: value["version"], bands: bands as ShakeBand[] } : undefined;
}
