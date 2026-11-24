/**
 * The source adapter of the alert system for the dashboards of Google: Google Cloud Service Health and the Firebase
 * Status Dashboard. Each dashboard gives the history of its incidents as one JSON file. Each incident that has not ended
 * gives one report of `infra.cloud.outage`. The first subject of the report is the domain of the service. The endpoint of
 * each key of an affected product and each location of the incident follow it.
 *
 * The terms of the texts of the incidents are the terms of Google. The fixtures keep real incidents with no change.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { dashboardDescriptor } from "./descriptor.ts";
import { GCP_DASHBOARD } from "./feed.ts";
import { createGcpFetch, type GcpFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { dashboardDescriptor, FIREBASE_DESCRIPTOR, GCP_DESCRIPTOR } from "./descriptor.ts";
export {
  DOMAIN_SYSTEM,
  FIREBASE_BASE,
  FIREBASE_DASHBOARD,
  FIREBASE_DOMAIN,
  FIREBASE_KEYS,
  FIREBASE_SOURCE,
  GCP_BASE,
  GCP_DASHBOARD,
  GCP_DOMAIN,
  GCP_INTERVAL,
  GCP_KIND,
  GCP_ORIGIN,
  GCP_PROVIDER,
  GCP_SLOW_AFTER,
  GCP_SOURCE,
  GOOGLE_DASHBOARDS,
  INCIDENTS_PATH,
  REGION_PROVIDER,
  REGION_SYSTEM,
  regionId,
  type GoogleDashboard,
  type ProductKey,
} from "./feed.ts";
export { createGcpFetch, incidentBody, INCIDENTS_TIMEOUT_MS, isLive, readIncidents } from "./fetch.ts";
export { GLOBAL_LOCATION, readIncidentHistory, VM_PRODUCTS } from "./history.ts";
export type { IncidentHistory, PastIncident } from "./history.ts";
export type { GcpFetchInput, GcpFetchOptions, Incidents } from "./fetch.ts";
export { HISTORY_FIELDS, INCIDENT_FIELDS, isIncident, ITEM_FIELDS, itemsOf, keysOf, locationsOf, mapObservation, sentOf, SEVERITY_OF_INCIDENT, UPDATE_FIELDS, URGENCY_OF_STATUS } from "./map.ts";

/**
 * This function makes the procedures of the source of one dashboard: `describe`, `fetch` and `map`. The default is the
 * dashboard of Google Cloud. The source has no `check`, because the feed has no canary. It has no `locate`: the source
 * asks for no point.
 */
export function createGcpSource(options: GcpFetchOptions): SourceProcedures {
  const dashboard = options.dashboard ?? GCP_DASHBOARD;
  const descriptor = dashboardDescriptor(dashboard);
  const fetch = createGcpFetch({ ...options, dashboard });
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation, dashboard),
  };
}
