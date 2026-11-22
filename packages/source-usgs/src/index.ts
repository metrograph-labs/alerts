/**
 * The source adapter of the alert system for the earthquake feed of the US Geological Survey (USGS).
 * The feed gives the earthquakes of magnitude 2.5 or more of the past day. The package gives the
 * procedures of the source contract of `@mark1russell7/alerts`.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { USGS_DESCRIPTOR } from "./descriptor.ts";
import { createUsgsFetch, type UsgsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { USGS_DESCRIPTOR } from "./descriptor.ts";
export { createUsgsFetch, eventBody, eventFields, FEED_PATH, isFeedEvent, readAnswer, USGS_BASE_URL } from "./fetch.ts";
export type { UsgsFetchInput, UsgsFetchOptions } from "./fetch.ts";
export { EARTHQUAKE_KIND, EVENT_FIELDS, EVENT_SYSTEM, eventIds, mapObservation, NUCLEAR_KIND, NUCLEAR_TYPE, REPORT_LIFE_MS, SOURCE_ID, USGS_ORIGIN } from "./map.ts";

/**
 * This function makes the procedures of the USGS source: `describe`, `fetch` and `map`. The source has
 * no `check`, because the feed has no canary. It has no `locate`: the feed has no lookup.
 */
export function createUsgsSource(options: UsgsFetchOptions): SourceProcedures {
  const fetch = createUsgsFetch(options);
  return {
    describe: () => USGS_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
