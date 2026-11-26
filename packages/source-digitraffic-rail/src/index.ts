/**
 * The Digitraffic rail source of the alert system: the passenger trains of Finland from the open rail API of Fintraffic.
 * Each fetch gives one indicator reading for each measure and each category, and no report. The data is under the license
 * CC BY 4.0.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { RAIL_DESCRIPTOR } from "./descriptor.ts";
import { createRailFetch, type RailFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { FETCH_INTERVAL_MS, MEASURE_DELAY_MS, MINUTE_MS, RAIL_DESCRIPTOR, RAIL_MEASURES } from "./descriptor.ts";
export { BODY_TYPE, createRailFetch, departureDate, GRAPHQL_PATH, LATE_MINUTES, MIN_INTERVAL_MS, RAIL_BASE_URL, RAIL_TIME_ZONE, railQuery, readAnswer, TIMEOUT_MS } from "./fetch.ts";
export type { AnswerRead, RailCounts, RailFetchInput, RailFetchOptions } from "./fetch.ts";
export {
  FINTRAFFIC_ORIGIN,
  mapObservation,
  MEASURE_IDS,
  newestOf,
  RAIL_AREA,
  RAIL_FIELDS,
  RAIL_LICENSE,
  railBody,
  SERIES_CATEGORIES,
  SERIES_IDS,
  SOURCE_ID,
  TRAIN_UNIT,
} from "./map.ts";
export type { MeasureId, RailBody, SeriesCounts, SeriesId } from "./map.ts";

/**
 * This function makes the procedures of the Digitraffic rail source. The source has a canary: the age of the newest actual
 * time of a train. It has no `locate`: the source asks for no point.
 */
export function createRailSource(options: RailFetchOptions): SourceProcedures {
  const fetch = createRailFetch(options);
  return {
    describe: () => RAIL_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
