/**
 * The census of one status of the FAA. For each region, it has the count of the airports that hold flights. It also has
 * the count of the airports with a delay. A region is a US state with a watched place, or the whole country (`US`). The fetch makes the
 * census on the computer, so no request holds a place.
 */

import { compareCodeUnits } from "@mark1russell7/text/order";

import { AIRPORT_STATES } from "./airports.ts";
import { DELAY_LISTS, HELD_LISTS, IGNORED_LISTS, type Status } from "./status.ts";

/** The region of the whole country. Its count has each airport of the status, also an airport with no state in the table. */
export const COUNTRY_REGION = "US";

/** The counts of one region. */
export interface RegionCount {
  /** The count of the airports with a ground stop or a ground delay program. */
  readonly held: number;
  /** The count of the airports with a delay of each kind: a ground stop, a ground delay program, or a delay of arrivals or departures. */
  readonly delayed: number;
}

/** The body of one census, as JSON. */
export interface CensusBody {
  /** The time of the update of the status, as an ISO 8601 text in UTC. */
  readonly status: string;
  /** The counts of each region, in the order of the codes. */
  readonly regions: Readonly<Record<string, RegionCount>>;
  /** The airports with a delay that the table of the states does not have, in order. Only the count of the country has them. */
  readonly unplaced: readonly string[];
  /** The lists that the reader does not know, in order. The census does not count them. */
  readonly unknown: readonly string[];
}

/** This function gives the set of the airports of the lists `lists` of a status. */
function airportsOf(status: Status, lists: readonly string[]): ReadonlySet<string> {
  return new Set(status.lists.filter((entry) => lists.includes(entry.list)).flatMap((entry) => entry.airports));
}

/** This function gives the count of the airports of a set in one region. */
function countIn(airports: ReadonlySet<string>, region: string): number {
  if (region === COUNTRY_REGION) return airports.size;
  return [...airports].filter((airport) => AIRPORT_STATES.get(airport) === region).length;
}

/**
 * This function makes the census of a status with a valid time. The regions are `COUNTRY_REGION` and the states
 * `states`. A region with no airport has the counts 0. One airport counts one time in each count.
 */
export function censusOf(status: Status & { readonly updated: number }, states: readonly string[]): CensusBody {
  const held = airportsOf(status, HELD_LISTS);
  const delayed = airportsOf(status, DELAY_LISTS);
  const regions = [...new Set([COUNTRY_REGION, ...states])].sort(compareCodeUnits);
  const known = new Set([...DELAY_LISTS, ...IGNORED_LISTS]);
  return {
    status: new Date(status.updated).toISOString().replace(".000Z", "Z"),
    regions: Object.fromEntries(regions.map((region) => [region, { held: countIn(held, region), delayed: countIn(delayed, region) }])),
    unplaced: [...delayed].filter((airport) => !AIRPORT_STATES.has(airport)).sort(compareCodeUnits),
    unknown: [...new Set(status.lists.map((entry) => entry.list || entry.name).filter((list) => !known.has(list)))].sort(compareCodeUnits),
  };
}
