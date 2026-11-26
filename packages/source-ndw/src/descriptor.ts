/**
 * The descriptor of the NDW source: the facts that the core uses for the schedule, the health and the indicator measures.
 */

import type { MeasureDeclaration, SourceDescriptor } from "@mark1russell7/alerts";

import { ALL_RECORDS, GROUP_MEASURES, NDW_ORIGIN, RECORD_UNIT, SOURCE_ID } from "./map.ts";
import { RECORD_KIND } from "./record.ts";

/** The length of one minute, in milliseconds. */
export const MINUTE_MS = 60_000;

/** The time between two fetches. NDW writes the file each minute, and each fetch reads approximately 300 kB. */
export const FETCH_INTERVAL_MS: number = 5 * MINUTE_MS;

/**
 * The time from a change on a road to the publication. One read at 03:07 UTC on 2026-11-18 held records of 03:06 UTC, and
 * NDW writes the file each minute. The road authorities add their own delay, which NDW does not give.
 */
export const MEASURE_DELAY_MS: number = 2 * MINUTE_MS;

/** The titles of the measures of the groups. */
const GROUP_TITLES: Readonly<Record<keyof typeof GROUP_MEASURES, string>> = {
  accident: "The count of the valid accident records on the roads of the Netherlands",
  congestion: "The count of the valid records of abnormal traffic, for example a queue, on the roads of the Netherlands",
  obstruction: "The count of the valid obstruction records, for example a broken-down vehicle, on the roads of the Netherlands",
  closure: "The count of the valid closures of a road, a carriageway or a lane in the Netherlands",
  works: "The count of the valid records of roadworks in the Netherlands",
  conditions: "The count of the valid records of poor road or weather conditions in the Netherlands",
};

/** This function gives the declaration of one count measure of the country. */
function countMeasure(id: string, title: string): MeasureDeclaration {
  return { id, dimension: "road-events", title, unit: RECORD_UNIT, area: "code", moves: "rise", baseline: "none", cadence: FETCH_INTERVAL_MS, delay: MEASURE_DELAY_MS };
}

/** The measures of the source: the count of all valid records, and the count of each group. */
export const NDW_MEASURES: readonly MeasureDeclaration[] = [
  countMeasure(ALL_RECORDS, "The count of the valid situation records on the roads of the Netherlands"),
  ...Object.entries(GROUP_MEASURES).map(([group, id]) => countMeasure(id, GROUP_TITLES[group as keyof typeof GROUP_MEASURES])),
];

/**
 * The descriptor of the NDW source. The source gives indicator readings, and one report for each valid accident, closure
 * and obstruction near a place with a position. Each complete fetch gives each of these records, so the source is a
 * snapshot source. The file comes from one host of NDW. A publication that is too old tells of a stopped feed.
 */
export const NDW_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "NDW: the road situations of the Netherlands, from the national road data portal: counts by group and the records near a place",
  origins: [NDW_ORIGIN],
  dependsOn: ["provider:ndw"],
  uses: ["internet", "dns", "power"],
  kinds: [RECORD_KIND],
  coverage: [{ type: "code", system: "iso3166", code: "NL" }],
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 20_000,
  maxQuiet: 15 * MINUTE_MS,
  auth: "none",
  listing: "snapshot",
  canary: "NDW writes the situation publication each minute. The check passes when the publication is at most 10 minutes older than its fetch.",
  measures: NDW_MEASURES,
};
