/**
 * The GFZ sources of the alert system: the indices of the geomagnetic activity of GFZ. Kp has a value each 3 hours,
 * Hp60 each hour and Hp30 each 30 minutes. A value of the NOAA scale G1 or more gives a report of a geomagnetic storm,
 * with the polar caps of its level. The data is under the license CC BY 4.0.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkIndexCanary } from "./check.ts";
import { descriptorOf } from "./descriptor.ts";
import { createIndexFetch, type GfzFetchOptions } from "./fetch.ts";
import { KP_INDEX, mapIndexObservation, type GfzIndex } from "./map.ts";

export { checkCanary, checkIndexCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { descriptorOf, GFZ_DESCRIPTOR, HP30_DESCRIPTOR, HP60_DESCRIPTOR } from "./descriptor.ts";
export {
  createGfzFetch,
  createIndexFetch,
  entryBody,
  entryBodyOf,
  GFZ_BASE_URL,
  isGfzEntry,
  isIndexEntry,
  queryPath,
  queryPathOf,
  readAnswer,
  readIndexAnswer,
  RUN_GAP_MS,
  runsOf,
  runsOfIndex,
  SERIES_PATH,
  WINDOW_INTERVALS,
  WINDOW_MS,
} from "./fetch.ts";
export type { Entry, GfzFetchInput, GfzFetchOptions, Interval, Read } from "./fetch.ts";
export {
  GFZ_CREDIT,
  GFZ_INDICES,
  GFZ_KINDS,
  GFZ_LICENSE,
  GFZ_ORIGIN,
  GFZ_PAGE,
  GFZ_SENDER,
  HP30_INDEX,
  HP60_INDEX,
  INTERVAL_FIELDS,
  INTERVAL_MS,
  INTERVAL_SYSTEM,
  intervalFieldsOf,
  intervalStart,
  intervalStartOf,
  intervalSystemOf,
  intervalText,
  KP_INDEX,
  kpOf,
  levelOf,
  mapIndexObservation,
  mapObservation,
  REPORT_LIFE_MS,
  RUN_SYSTEM,
  runSystemOf,
  SOURCE_ID,
  STATUSES,
  valueOf,
} from "./map.ts";
export type { GfzIndex } from "./map.ts";

/**
 * This function makes the procedures of the GFZ source of Kp. The source has a canary: the age of the newest
 * interval. It has no `locate`: the source asks for no point.
 */
export function createGfzSource(options: GfzFetchOptions): SourceProcedures {
  return createIndexSource(KP_INDEX, options);
}

/** This function makes the procedures of the GFZ source of an index, for example `HP30_INDEX`. */
export function createIndexSource(index: GfzIndex, options: GfzFetchOptions): SourceProcedures {
  const fetch = createIndexFetch(index, options);
  const descriptor = descriptorOf(index);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapIndexObservation(index, observation),
    check: ({ observations }) => checkIndexCanary(index, observations),
  };
}
