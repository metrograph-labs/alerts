/**
 * The breadth of the indicator signals. One measure out of its normal level is a weak sign. Many dimensions out of their
 * normal levels at one time in one area is a strong sign.
 *
 * - The breadth of a place is the count of the dimensions with a signal in a series near the place.
 * - The breadth of the world holds each series, near a place or not. A dimension with signals in many series tells a
 *   change in many areas at one time.
 * - Each count also tells the series with a read and the series with no read. A breadth of 2 dimensions of 2 with a read
 *   is not a breadth of 2 dimensions of 30.
 *
 * The breadth gives counts and no decision. The threat level reads the counts.
 */
import { distanceKm, distanceToGeometryKm, GeoError } from "@mark1russell7/geo";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { regionCovers } from "./assess.ts";
import type { SeriesRead } from "./baseline.ts";
import { DIMENSIONS, type DimensionId, type IndicatorArea, type PlaceId, type Position, type RegionCode, type WatchedPlace } from "./contracts.ts";
import { shapeDistanceKm } from "./shapes.ts";

/**
 * The US territories by their postal codes. Some sources code a territory as a country, for example GDELT and the FIPS
 * 10-4 codes. Thus `watchedStates` gives no territory.
 */
export const US_TERRITORIES: ReadonlySet<string> = new Set(["AS", "GU", "MP", "PR", "UM", "VI"]);

/**
 * This function gives the US states of the watched places, by their `state` codes. A source gives a series for each of
 * them, for example a count of each state, so its readings meet each place of the state. The states are in the order of
 * their codes, with no duplicate and no territory.
 */
export function watchedStates(places: readonly WatchedPlace[]): readonly string[] {
  const codes = places.flatMap((place) => place.codes.filter((code) => code.system === "state" && /^[A-Z]{2}$/.test(code.code) && !US_TERRITORIES.has(code.code)).map((code) => code.code));
  return [...new Set(codes)].sort(compareCodeUnits);
}

/** The read of one series at one time, with the dimension of its measure and the area of its latest reading. */
export interface SeriesSignal {
  /** The key of the series, for example from `seriesKey`. One key counts one time in each dimension. */
  readonly series: string;
  readonly dimension: DimensionId;
  readonly area: IndicatorArea;
  readonly read: SeriesRead;
}

/** The regions of one zone of the domain of a source, from a table of the atlas. */
export interface ZoneRegions {
  readonly system: string;
  readonly code: string;
  readonly regions: readonly RegionCode[];
}

/** The counts of the series of one dimension. Each key counts one time. */
export interface DimensionCount {
  readonly dimension: DimensionId;
  /** The count of the series with a score or a flag. */
  readonly read: number;
  /** The count of the series with a signal. It is not more than `read`. */
  readonly signals: number;
  /** The count of the series with no read. */
  readonly noRead: number;
}

/** The breadth of a group of series. */
export interface Breadth {
  /** The dimensions with a signal in one series or more, in the order of `DIMENSIONS`. The length of the list is the breadth. */
  readonly signals: readonly DimensionId[];
  /** The dimensions with a read of one series or more, in the order of `DIMENSIONS`. */
  readonly read: readonly DimensionId[];
  /** The counts of each dimension with one series or more, in the order of `DIMENSIONS`. */
  readonly dimensions: readonly DimensionCount[];
}

/** The breadth of the series near one watched place. */
export interface PlaceBreadth extends Breadth {
  readonly place: PlaceId;
}

/** The breadth of the world and of each watched place. */
export interface IndicatorBreadth {
  /** The breadth of each series, near a place or not. */
  readonly world: Breadth;
  /** The breadth of each place, in the order of the places. A place with no series near it has empty lists. */
  readonly places: readonly PlaceBreadth[];
  /**
   * The keys of the series with an area that the match cannot read, in the order of the code units. The area is a zone
   * with no regions in the table, or a shape that `@mark1russell7/geo` refuses for a place with a position.
   */
  readonly unplaced: readonly string[];
}

// The state of one series: no read, a read with no signal, or a signal. A key with two states keeps the higher state.
type State = 0 | 1 | 2;

function stateOf(read: SeriesRead): State {
  if (read.kind === "no-read") return 0;
  return read.signal ? 2 : 1;
}

/**
 * This function gives the breadth of a group of series. The result is a function of the set of the series: the order
 * does not change it, and a duplicate does not change it.
 *
 * - A key counts one time in each dimension.
 * - When a key has two reads in one dimension, the higher read counts: a signal, then a read, then no read.
 */
export function breadthOf(series: readonly SeriesSignal[]): Breadth {
  const states = new Map<DimensionId, Map<string, State>>();
  for (const one of series) {
    const keys = states.get(one.dimension) ?? new Map<string, State>();
    keys.set(one.series, Math.max(keys.get(one.series) ?? 0, stateOf(one.read)) as State);
    states.set(one.dimension, keys);
  }
  const dimensions: DimensionCount[] = [];
  for (const { id } of DIMENSIONS) {
    const keys = states.get(id);
    if (keys === undefined) continue;
    let read = 0;
    let signals = 0;
    for (const state of keys.values()) {
      if (state > 0) read++;
      if (state === 2) signals++;
    }
    dimensions.push({ dimension: id, read, signals, noRead: keys.size - read });
  }
  return {
    signals: dimensions.filter((count) => count.signals > 0).map((count) => count.dimension),
    read: dimensions.filter((count) => count.read > 0).map((count) => count.dimension),
    dimensions,
  };
}

// The key of a zone in the table.
function zoneKey(system: string, code: string): string {
  return JSON.stringify([system, code]);
}

// The regions of each zone. Two rows of one zone give the union of their regions.
function zoneTable(zones: readonly ZoneRegions[]): Map<string, RegionCode[]> {
  const table = new Map<string, RegionCode[]>();
  for (const zone of zones) {
    const key = zoneKey(zone.system, zone.code);
    table.set(key, [...(table.get(key) ?? []), ...zone.regions]);
  }
  return table;
}

// The great-circle distance in kilometers from a position to the area of a point, a line or a polygon, or `undefined`
// when `@mark1russell7/geo` refuses the area.
function distanceTo(area: Extract<IndicatorArea, { readonly type: "point" | "line" | "polygon" }>, at: Position): number | undefined {
  if (area.type === "polygon") return shapeDistanceKm({ type: "polygon", rings: area.rings }, at);
  const point = { lat: at[1], lon: at[0] };
  try {
    if (area.type === "point") return distanceKm(point, { lat: area.at[1], lon: area.at[0] });
    return distanceToGeometryKm(point, { type: "LineString", coordinates: area.path });
  } catch (error) {
    if (error instanceof GeoError) return undefined;
    throw error;
  }
}

/**
 * This function tells if the area of a series meets a watched place. It gives `undefined` when the match cannot read
 * the area: a zone with no regions in the table, or a shape that `@mark1russell7/geo` refuses.
 *
 * - A `code` area meets a place when it covers a code of the place, by the rule of `regionCovers`.
 * - A `point`, a `line` or a `polygon` meets a place with a position at the buffer of the place or nearer. It meets no
 *   place with no position.
 * - A `zone` meets a place when a region of the zone in the table covers a code of the place.
 * - A `world` area meets no place. Only the breadth of the world holds it.
 */
export function areaMeetsPlace(area: IndicatorArea, place: WatchedPlace, zones: readonly ZoneRegions[] = []): boolean | undefined {
  return meets(area, place, zoneTable(zones));
}

function meets(area: IndicatorArea, place: WatchedPlace, table: ReadonlyMap<string, readonly RegionCode[]>): boolean | undefined {
  switch (area.type) {
    case "world":
      return false;
    case "code":
      return place.codes.some((code) => regionCovers(area, code));
    case "zone": {
      const regions = table.get(zoneKey(area.system, area.code));
      if (regions === undefined) return undefined;
      return place.codes.some((code) => regions.some((region) => regionCovers(region, code)));
    }
    default: {
      if (place.at === undefined) return false;
      const distance = distanceTo(area, place.at);
      return distance === undefined ? undefined : distance <= place.bufferKm;
    }
  }
}

/**
 * This function gives the breadth of the world and of each watched place. The result is a function of the set of the
 * series and of the set of the zones. The order and a duplicate do not change it.
 *
 * - The breadth of the world holds each series.
 * - The breadth of a place holds each series with an area that meets the place, by the rules of `areaMeetsPlace`.
 * - A series with an area that the match cannot read is in `unplaced`, and it is in no breadth of a place.
 */
export function indicatorBreadth(series: readonly SeriesSignal[], places: readonly WatchedPlace[], zones: readonly ZoneRegions[] = []): IndicatorBreadth {
  const table = zoneTable(zones);
  const near = places.map((): SeriesSignal[] => []);
  const unplaced = new Set<string>();
  for (const one of series) {
    if (one.area.type === "zone" && !table.has(zoneKey(one.area.system, one.area.code))) unplaced.add(one.series);
    places.forEach((place, index) => {
      const found = meets(one.area, place, table);
      if (found === undefined) unplaced.add(one.series);
      else if (found) near[index]?.push(one);
    });
  }
  return {
    world: breadthOf(series),
    places: places.map((place, index) => ({ place: place.id, ...breadthOf(near[index] ?? []) })),
    unplaced: [...unplaced].sort(compareCodeUnits),
  };
}
