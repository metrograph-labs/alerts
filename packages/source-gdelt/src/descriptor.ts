/**
 * The descriptor of the GDELT source. GDELT keeps its files on Google Cloud. The source is a stream: a report stays
 * until it expires, one day after GDELT added its event.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { CONFLICT_EVENTS_MEASURE, GDELT_KINDS, GDELT_ORIGIN, SOURCE_ID } from "./map.ts";

/** The descriptor of the GDELT source. */
export const GDELT_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "GDELT 2.0 events: protests and armed conflict that the news reports, at the place of each event",
  origins: [GDELT_ORIGIN],
  dependsOn: ["provider:gdelt", "provider:google-cloud"],
  uses: ["internet", "dns", "power"],
  kinds: GDELT_KINDS,
  coverage: "global",
  transport: "poll",
  interval: 900_000,
  slowAfter: 10_000,
  auth: "none",
  canary: "GDELT adds one event file each 15 minutes. The check passes when the newest file is at most one hour older than the fetch.",
  measures: [
    {
      id: CONFLICT_EVENTS_MEASURE,
      dimension: "news-volume",
      title: "Protests and fights in the news in one 15-minute file, in each US state with a watched place",
      unit: "{event}",
      area: "code",
      moves: "rise",
      baseline: "none",
      cadence: 900_000,
    },
  ],
};
