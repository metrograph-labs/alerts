/**
 * The NDW source of the alert system: the road situations of the Netherlands from NDW (Nationaal Dataportaal
 * Wegverkeer), the national road data portal. Each publication gives one indicator reading for each group of records,
 * and no report. The data is under the license CC0 1.0.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { NDW_DESCRIPTOR } from "./descriptor.ts";
import { createNdwFetch, type NdwFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, PUBLISHED_MAX_AGE_MS } from "./check.ts";
export { FETCH_INTERVAL_MS, MEASURE_DELAY_MS, MINUTE_MS, NDW_DESCRIPTOR, NDW_MEASURES } from "./descriptor.ts";
export { BODY_TYPE, countsOf, createNdwFetch, MAX_XML_BYTES, MIN_INTERVAL_MS, NDW_BASE_URL, readFile, SITUATIONS_PATH, TIMEOUT_MS } from "./fetch.ts";
export type { FileRead, NdwFetchInput, NdwFetchOptions, PublicationCounts } from "./fetch.ts";
export {
  ALL_RECORDS,
  COUNT_FIELDS,
  countBody,
  GROUP_MEASURES,
  mapObservation,
  NDW_AREA,
  NDW_COUNTRY,
  NDW_LICENSE,
  NDW_ORIGIN,
  publishedOf,
  RECORD_UNIT,
  SERIES,
  SOURCE_ID,
} from "./map.ts";
export type { CountBody, GroupCounts } from "./map.ts";

/**
 * This function makes the procedures of the NDW source. The source has a canary: the age of the newest publication. It
 * has no `locate`: the source asks for no point.
 */
export function createNdwSource(options: NdwFetchOptions): SourceProcedures {
  const fetch = createNdwFetch(options);
  return {
    describe: () => NDW_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
