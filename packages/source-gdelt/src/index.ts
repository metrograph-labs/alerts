/**
 * The GDELT source of the alert system: the event files of GDELT 2.0. GDELT codes events from the news of the world each
 * 15 minutes. Each protest, assault, fight or act of mass violence at the point of a city gives one report. Its kind
 * is `security.civil-unrest` or `security.armed-conflict`, and its certainty is `possible`. The data is free to use and to
 * redistribute with a citation of the GDELT Project and a link to its site.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { GDELT_DESCRIPTOR } from "./descriptor.ts";
import { createGdeltFetch, type GdeltFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, FILE_MAX_AGE_MS } from "./check.ts";
export { GDELT_DESCRIPTOR } from "./descriptor.ts";
export {
  BODY_TYPE,
  createGdeltFetch,
  EVENT_ARCHIVE_LIMITS,
  eventFilePath,
  FILE_STEP_MS,
  GDELT_BASE_URL,
  GDELT_TIMEOUT_MS,
  headBody,
  headTime,
  LAST_UPDATE_PATH,
  MAX_FILES_PER_FETCH,
  readEventFile,
  readLastUpdate,
  stampOf,
  stampsToRead,
} from "./fetch.ts";
export type { EventFile, GdeltFetchInput, GdeltFetchOptions, LastUpdate } from "./fetch.ts";
export {
  CAMEO_LABELS,
  cameoLabel,
  CONFLICT_KIND,
  GDELT_CREDIT,
  GDELT_KINDS,
  GDELT_ORIGIN,
  GDELT_SENDER,
  GDELT_TERMS_URL,
  mapObservation,
  PLACE_RADIUS_KM,
  REPORT_LIFE_MS,
  severityOf,
  SOURCE_ID,
  UNREST_KIND,
} from "./map.ts";
export { addedTime, CITY_GEO_TYPES, dayStart, EVENT_FIELD_COUNT, EVENT_FIELDS, eventBody, eventOf, keepEvent, MAX_EVENT_AGE_DAYS, REPORTED_ROOTS } from "./row.ts";
export type { GdeltEvent } from "./row.ts";

/** This function makes the procedures of the GDELT source: describe, fetch, map and check. */
export function createGdeltSource(options: GdeltFetchOptions): SourceProcedures {
  const fetch = createGdeltFetch(options);
  return {
    describe: () => GDELT_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
