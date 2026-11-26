/**
 * The descriptor of the USGS source: the facts that the core uses for the schedule, the health and
 * the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { EARTHQUAKE_KIND, NUCLEAR_KIND, SOURCE_ID, USGS_ORIGIN } from "./map.ts";

/**
 * The countries and territories where the networks of the USGS find each felt event, as ISO 3166 codes. The feed
 * is global, but outside these areas it does not have each small event that people feel. The feed also has the
 * nuclear tests outside these areas. The coverage is one list for the two kinds, so it keeps the smaller areas.
 */
const COVERAGE: readonly Area[] = ["US", "PR", "VI", "GU", "MP", "AS"].map((code) => ({ type: "code", system: "iso3166", code }));

/**
 * The descriptor of the USGS source. The USGS and the regional networks that report to it find each
 * event, so the origin is the USGS. The feed is a snapshot of the past day. An event that the USGS
 * deletes leaves the feed with no cancel, so the runtime ends a report that is absent from complete feeds.
 */
export const USGS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "USGS: the earthquakes of magnitude 2.5 or more of the past day",
  origins: [USGS_ORIGIN],
  dependsOn: ["provider:usgs", "cdn:cloudfront"],
  uses: ["internet", "dns", "power"],
  kinds: [EARTHQUAKE_KIND, NUCLEAR_KIND],
  coverage: COVERAGE,
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
};
