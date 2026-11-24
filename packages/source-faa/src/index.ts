/**
 * The FAA source of the alert system: the airport status of the FAA, with the ground stops, ground delay programs and
 * delays of US airports. Each update gives indicator readings: the count of the airports that hold flights and the count
 * of the airports with a delay. Each count has a series for the US and for each US state with a watched place. The status is a work of the US
 * government.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { FAA_DESCRIPTOR } from "./descriptor.ts";
import { createFaaFetch, type FaaFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { AIRPORT_STATES } from "./airports.ts";
export { censusOf, COUNTRY_REGION } from "./census.ts";
export type { CensusBody, RegionCount } from "./census.ts";
export { checkCanary, STATUS_MAX_AGE_MS } from "./check.ts";
export { FAA_DESCRIPTOR, FAA_MEASURES, FETCH_INTERVAL_MS } from "./descriptor.ts";
export { CENSUS_CONTENT_TYPE, createFaaFetch, FAA_BASE_URL, MIN_INTERVAL_MS, readAnswer, STATUS_PATH } from "./fetch.ts";
export type { FaaFetchInput, FaaFetchOptions, Read } from "./fetch.ts";
export { AIRPORT_UNIT, AIRPORTS_DELAYED_MEASURE, AIRPORTS_HELD_MEASURE, FAA_ORIGIN, mapObservation, regionArea, SOURCE_ID } from "./map.ts";
export { DELAY_LISTS, HELD_LISTS, IGNORED_LISTS, readStatus, STATUS_ROOT, updateTime } from "./status.ts";
export type { Status, StatusList } from "./status.ts";

/** This function makes the procedures of the FAA source. It has no `locate`: the source asks for no point. */
export function createFaaSource(options: FaaFetchOptions): SourceProcedures {
  const fetch = createFaaFetch(options);
  return {
    describe: () => FAA_DESCRIPTOR,
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
