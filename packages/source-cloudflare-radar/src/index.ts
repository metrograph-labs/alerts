/**
 * The Cloudflare Radar sources of the alert system: the confirmed internet outages of the outage center and the traffic
 * anomalies. An anomaly is a drop of the traffic of a country, a network or a cloud region. The API needs a token of Cloudflare.
 *
 * An outage gives a report of `infra.internet.outage`, `infra.internet.shutdown` or `infra.cloud.outage`. An anomaly
 * gives a report of `infra.internet.outage` or `infra.cloud.outage`. An anomaly that names an outage shares its key.
 *
 * The data of Cloudflare Radar is under the license CC BY-NC 4.0. Each report has the credit `RADAR_CREDIT` in its parameters.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { ANOMALIES_DESCRIPTOR, OUTAGES_DESCRIPTOR } from "./descriptor.ts";
import { createRadarFetch, type RadarFetchOptions } from "./fetch.ts";
import { mapAnomaly, mapOutage } from "./map.ts";

export { ANOMALIES_DESCRIPTOR, OUTAGES_DESCRIPTOR } from "./descriptor.ts";
export {
  ANOMALIES_PAGE,
  ANOMALIES_PATH,
  ANOMALIES_SOURCE,
  ASN_SYSTEM,
  AZURE_ALIASES,
  CLOUD_KIND,
  CLOUD_PROVIDERS,
  COUNTRY_SYSTEM,
  DOMAIN_SYSTEM,
  GEONAMES_SYSTEM,
  GRID_COLLAPSE_KIND,
  OUTAGE_CENTER,
  OUTAGE_KEY_SYSTEM,
  OUTAGE_KIND,
  OUTAGES_PATH,
  OUTAGES_SOURCE,
  originRegion,
  PAGE_LIMIT,
  RADAR_BASE,
  RADAR_INTERVAL,
  RADAR_KINDS,
  RADAR_ORIGIN,
  RADAR_PROVIDER,
  RADAR_SLOW_AFTER,
  REGION_SYSTEM,
  SHUTDOWN_KIND,
} from "./feed.ts";
export type { CloudProvider, OriginRegion } from "./feed.ts";
export { AUTH_ERROR_CODES, createRadarFetch, errorsDetail, failureOfRequest, isLive, RADAR_LISTS, RADAR_TIMEOUT_MS, readRecords, RECORD_CONTENT_TYPE } from "./fetch.ts";
export type { RadarFetchInput, RadarFetchOptions, RadarList, RadarListFacts, Records } from "./fetch.ts";
export { CAUSE_WORDS, CERTAINTY_OF_STATUS, HEADLINE_NAMES, mapAnomaly, mapOutage, RADAR_CREDIT, RADAR_SENDER, SCOPE_WORDS, SEVERITY_OF_ANOMALY, SEVERITY_OF_SCOPE } from "./map.ts";

/** The options of the two sources: the options of a fetch with no list. */
export type RadarSourceOptions = Omit<RadarFetchOptions, "list">;

/** This function makes the procedures of the outages. The source has no canary and no `locate`: it asks for no point. */
export function createRadarOutagesSource(options: RadarSourceOptions): SourceProcedures {
  const fetch = createRadarFetch({ ...options, list: "outages" });
  return {
    describe: () => OUTAGES_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapOutage(observation),
  };
}

/** This function makes the procedures of the traffic anomalies. The source has no canary and no `locate`. */
export function createRadarAnomaliesSource(options: RadarSourceOptions): SourceProcedures {
  const fetch = createRadarFetch({ ...options, list: "anomalies" });
  return {
    describe: () => ANOMALIES_DESCRIPTOR,
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapAnomaly(observation),
  };
}
