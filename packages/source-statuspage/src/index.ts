/**
 * The source adapter of the alert system for status pages. Atlassian Statuspage hosts the status pages of many
 * services, and each page gives the same JSON API. incident.io gives the same format. Each incident that is not
 * resolved gives one report of the kind of the page. Each page is a source of its own, with its config.
 *
 * A page of Site24x7 StatusIQ has the format `statusiq`: an RSS feed with one item for each component. Each component
 * with an outage gives one report (`statusiq.ts`).
 *
 * The register of this package names well-known pages. The terms of each page are the terms of its owner.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { descriptorOf } from "./descriptor.ts";
import { createStatusPageFetch, type StatusPageFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";
import { pageProblems } from "./page.ts";

export { descriptorOf } from "./descriptor.ts";
export { createStatusPageFetch, incidentBody, pagePath, readSummary, STATUS_FIELDS, SUMMARY_PATH, SUMMARY_TIMEOUT_MS } from "./fetch.ts";
export type { StatusPageFetchInput, StatusPageFetchOptions, Summary } from "./fetch.ts";
export { COMPONENTS_PATH, HISTORY_LIMIT, HISTORY_PATH, readComponentNames, readHistory, type HistoryIncident, type HistoryRead } from "./history.ts";
export {
  COMPONENT_FIELDS,
  componentsOf,
  HEAD_FIELDS,
  INCIDENT_FIELDS,
  isHead,
  isIncident,
  keysOf,
  mapObservation,
  PAGE_FIELDS,
  sentOf,
  SEVERITY_OF_IMPACT,
  UPDATE_FIELDS,
  updatesOf,
  URGENCY_OF_STATUS,
} from "./map.ts";
export {
  DEFAULT_INTERVAL,
  DEFAULT_SLOW_AFTER,
  endpointKey,
  isDomain,
  isPageBase,
  PAGE_FORMATS,
  pageProblems,
  pageSubjects,
  PATH_PATTERN,
  REGION_SYSTEM,
  regionKey,
  SUBJECT_SYSTEM,
  subjectsOf,
  type ComponentKey,
  type PageFormat,
  type StatusPage,
} from "./page.ts";
export {
  COMPONENT_ITEM_FIELDS,
  componentOf,
  hasOutage,
  isFeedHead,
  mapComponent,
  OPERATIONAL,
  readComponents,
  SEVERITY_OF_STATUSIQ,
  STATUSIQ_PATH,
  UNDER_MAINTENANCE,
  type ComponentStatus,
} from "./statusiq.ts";
export { pagesFor, watchReads, type ReadTarget } from "./select.ts";
export { ATLASSIAN_STATUSPAGE, CLOUDFLARE_CDN, INCIDENT_IO, PUSHOVER_KEYS, registeredPage, STATUS_PAGES, STATUSIQ, TWILIO_KEYS } from "./register.ts";

/**
 * This function makes the procedures of the source of one page: `describe`, `fetch` and `map`. It throws for a config
 * with problems. The source has no `check`, because a page has no canary. It has no `locate`: the source asks for no
 * point.
 */
export function createStatusPageSource(options: StatusPageFetchOptions): SourceProcedures {
  const { page } = options;
  const problems = pageProblems(page);
  if (problems.length > 0) throw new Error(`the config of the status page ${page.id} has problems: ${problems.join("; ")}`);
  const fetch = createStatusPageFetch(options);
  const descriptor = descriptorOf(page);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation, page),
  };
}
