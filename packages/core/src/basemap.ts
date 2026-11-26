/**
 * This module makes the basemap small for the map. The outlines of the counties and zones of one state are many megabytes. The
 * page draws them in a view box of 1000 units. A position near the line of its neighbors, at less than half a unit, changes
 * no pixel. The module removes those positions with the steps of `simplifyRegions` of `@mark1russell7/geo`. The match of the places
 * does not use this module: it reads the outlines of the store.
 */
import { EARTH_MEAN_RADIUS_KM, simplifyRegionsSteps, type Region, type SimplifySteps } from "@mark1russell7/geo";
import type { Position } from "./contracts.ts";
import { regionRank, type MapRegion, type MapShape } from "./map.ts";

/**
 * The view box of the map, in units. The page fits the shapes into the box with the Mercator projection, with `pad` units at
 * each edge.
 */
export const MAP_VIEW = { width: 1000, height: 640, pad: 24 } as const;

/** A polygon of the map. */
type PolygonShape = Extract<MapShape, { readonly type: "polygon" }>;

/** This function gives the Mercator y of a latitude in degrees, in radians. */
const mercatorY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * This function gives the tolerance of the simplification of a basemap, in kilometres. The tolerance is half of one unit of
 * `MAP_VIEW` at the Mercator fit of the polygons of the regions.
 *
 * - The fit of the page also holds the incidents and the places. A larger fit has larger units, thus this tolerance is on the
 *   safe side.
 * - In the Mercator projection, one unit covers the least ground at the latitude farthest from the equator. The function
 *   measures the unit at that latitude. Thus a removed position moves the line by half a unit or less at each latitude.
 * - The fit uses the span of the longitudes as they are, from -180 to 180. The page fits with the Mercator projection and no
 *   rotation. Thus regions on the two sides of the antimeridian fill its full width, for example in Alaska and Guam (AL-176).
 * - The function gives `undefined` for regions with no polygon.
 */
export function basemapToleranceKm(regions: readonly MapRegion[]): number | undefined {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const region of regions) {
    for (const shape of region.shapes) {
      if (shape.type !== "polygon") continue;
      for (const [lon, lat] of shape.rings.flat()) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
  }
  if (west > east) return undefined;
  const width = ((east - west) * Math.PI) / 180;
  const height = mercatorY(north) - mercatorY(south);
  const scales = [width > 0 ? (MAP_VIEW.width - 2 * MAP_VIEW.pad) / width : Infinity, height > 0 ? (MAP_VIEW.height - 2 * MAP_VIEW.pad) / height : Infinity];
  // The units for each radian of longitude at the fit. A region with no width and no height has no fit.
  const scale = Math.min(...scales);
  if (!Number.isFinite(scale)) return undefined;
  const farthest = Math.max(Math.abs(south), Math.abs(north));
  return (EARTH_MEAN_RADIUS_KM * Math.cos((farthest * Math.PI) / 180)) / scale / 2;
}

/** This function gives the GeoJSON region of the polygons of a region of the map, or `undefined` for a region with no polygon. */
function geoRegion(polygons: readonly PolygonShape[]): Region | undefined {
  const coordinates = polygons.map((polygon) => polygon.rings);
  if (coordinates.length === 0) return undefined;
  return coordinates.length === 1 ? { type: "Polygon", coordinates: coordinates[0]! } : { type: "MultiPolygon", coordinates };
}

/** This function gives the polygons of a simplified GeoJSON region as shapes of the map. */
function shapesOf(region: Region): PolygonShape[] {
  const polygons = region.type === "Polygon" ? [region.coordinates] : region.coordinates;
  return polygons.map((rings) => ({ type: "polygon", rings: rings.map((ring) => ring.map(([lon, lat]): Position => [lon!, lat!])) }));
}

/**
 * This function simplifies the regions of a basemap with `simplifyRegions` of `@mark1russell7/geo`.
 *
 * - The regions of one rank (`regionRank`) tile the ground, for example the counties of a state. Thus each rank is one set, and
 *   a border that two regions of a rank share stays one border. Regions of two ranks overlap, and they do not join.
 * - Each region keeps its code, its name, its place in the list and the order of its shapes. A circle stays as it is.
 * - Each removed position is at most `toleranceKm` from the result. `basemapToleranceKm` gives a tolerance for the view box.
 *
 * @throws GeoError - The errors of `simplifyRegions`, for example for a tolerance less than 0.
 */
export function simplifyBasemap(regions: readonly MapRegion[], toleranceKm: number): MapRegion[] {
  const steps = simplifyBasemapSteps(regions, toleranceKm);
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
  }
}

/**
 * This function gives the steps of `simplifyBasemap`, with the same result (AL-213). Each step does a bounded work of
 * `simplifyRegionsSteps`. Thus a server gives its event loop a turn between two steps, and a large basemap does not stop
 * the answers to its probes. The steps keep the regions of the input, so do not change them before the last step.
 *
 * @throws GeoError - The errors of `simplifyRegions`, at the step that examines the regions of a rank.
 */
export function* simplifyBasemapSteps(regions: readonly MapRegion[], toleranceKm: number): SimplifySteps<MapRegion[]> {
  const ranks = new Map<number, { readonly at: number[]; readonly regions: (Region)[] }>();
  for (const [at, region] of regions.entries()) {
    const geo = geoRegion(region.shapes.filter((shape): shape is PolygonShape => shape.type === "polygon"));
    if (geo === undefined) continue;
    const rank = regionRank(region.code);
    const set = ranks.get(rank) ?? { at: [], regions: [] };
    set.at.push(at);
    set.regions.push(geo);
    ranks.set(rank, set);
  }
  const simplified = new Map<number, PolygonShape[]>();
  for (const set of ranks.values()) {
    const results = yield* simplifyRegionsSteps(set.regions, toleranceKm);
    for (const [index, at] of set.at.entries()) simplified.set(at, shapesOf(results[index]!));
  }
  return regions.map((region, at) => {
    const polygons = simplified.get(at);
    if (polygons === undefined) return region;
    // The simplified polygons take the places of the polygons, in order. Each circle keeps its place.
    let next = 0;
    return { ...region, shapes: region.shapes.map((shape) => (shape.type === "polygon" ? polygons[next++]! : shape)) };
  });
}
