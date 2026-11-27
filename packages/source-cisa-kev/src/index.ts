/**
 * The CISA KEV source of the alert system: the catalog of known exploited vulnerabilities of CISA. Each entry whose due
 * date has not ended gives a report of an exploited flaw. The catalog is under the license CC0 1.0.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { KEV_DESCRIPTOR } from "./descriptor.ts";
import { createKevFetch, type KevFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { ADDED_DATES } from "./added.ts";
export { ADDED_TIMES, checkCanary, RELEASE_MAX_AGE_MS } from "./check.ts";
export { KEV_DESCRIPTOR } from "./descriptor.ts";
export { CATALOG_PATH, createKevFetch, entryBody, KEV_BASE_URL, KEV_TIMEOUT_MS, listedAt, readCatalog, releasedOf } from "./fetch.ts";
export type { Catalog, KevFetchInput, KevFetchOptions, Listed } from "./fetch.ts";
export {
  CVE_SYSTEM,
  dateStart,
  dueEnd,
  ENTRY_FIELDS,
  EXPLOITED_KIND,
  HEAD_FIELDS,
  isCveId,
  isHead,
  isKevEntry,
  KEV_KINDS,
  KEV_LICENSE,
  KEV_LICENSE_URL,
  KEV_ORIGIN,
  KEV_PAGE,
  KEV_SENDER,
  mapObservation,
  severityOf,
  SOURCE_ID,
} from "./map.ts";

/**
 * This function makes the procedures of the CISA KEV source. The source has a canary: the age of the release of the
 * catalog. It has no `locate`: the source asks for no point.
 */
export function createKevSource(options: KevFetchOptions): SourceProcedures {
  const fetch = createKevFetch(options);
  return {
    describe: () => KEV_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
