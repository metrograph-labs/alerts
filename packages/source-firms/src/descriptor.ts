/**
 * The descriptor of the FIRMS source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { FIRMS_ORIGIN, HOTSPOT_KIND, SOURCE_ID } from "./map.ts";

/**
 * The time between two fetches: 10 minutes, the window of the limit of FIRMS. A pass of a satellite comes into the near
 * real-time data in approximately 3 hours. In the United States and Canada, the data of a pass can come in less than 60 seconds.
 */
export const FETCH_INTERVAL_MS = 600_000;

/**
 * The descriptor of the FIRMS source. Its hotspots cover the whole Earth. The source gives a hotspot only near a place that
 * shares its position with it, so a place with no position gets no report.
 */
export const FIRMS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "NASA FIRMS: the VIIRS satellite hotspots near each place",
  origins: [FIRMS_ORIGIN],
  dependsOn: ["provider:nasa-firms"],
  uses: ["internet", "dns", "power"],
  kinds: [HOTSPOT_KIND],
  coverage: "global",
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 20_000,
  auth: "key",
  canary: "Each fetch reads the dates of the data of each VIIRS product. The check passes when the newest date is the day of the fetch in UTC or the day before.",
};
