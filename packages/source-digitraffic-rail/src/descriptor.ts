/**
 * The descriptor of the Digitraffic rail source: the facts that the core uses for the schedule, the health and the
 * indicator measures.
 */

import type { MeasureDeclaration, Move, SourceDescriptor } from "@mark1russell7/alerts";

import { FINTRAFFIC_ORIGIN, SOURCE_ID, TRAIN_UNIT, type MeasureId } from "./map.ts";

/** The length of one minute, in milliseconds. */
export const MINUTE_MS = 60_000;

/** The time between two fetches. The REST answers of Digitraffic have a cache time of 5 minutes. */
export const FETCH_INTERVAL_MS: number = 5 * MINUTE_MS;

/**
 * The time from a stop of a train to its actual time in the API. One read at 12:48 UTC on 2026-11-25 held an actual time
 * of 12:47 UTC. The source uses 2 minutes.
 */
export const MEASURE_DELAY_MS: number = 2 * MINUTE_MS;

/** The title and the direction of a signal of each measure. */
const MEASURES: Readonly<Record<MeasureId, { readonly title: string; readonly moves: Move }>> = {
  running: { title: "The count of the passenger trains of Finland that run at this time, by category", moves: "drop" },
  late: { title: "The count of the running passenger trains of Finland that are 5 minutes late or more at their last stop, by category", moves: "rise" },
  cancelled: { title: "The count of the passenger trains of the day in Finland with a cancellation, by category", moves: "rise" },
};

/** The measures of the source. Each measure has the series `commuter` and `long-distance`. */
export const RAIL_MEASURES: readonly MeasureDeclaration[] = Object.entries(MEASURES).map(([id, { title, moves }]): MeasureDeclaration => ({
  id,
  dimension: "rail",
  title,
  unit: TRAIN_UNIT,
  area: "code",
  moves,
  baseline: "none",
  cadence: FETCH_INTERVAL_MS,
  delay: MEASURE_DELAY_MS,
}));

/**
 * The descriptor of the Digitraffic rail source. The source gives indicator readings and no event, so it has no kind and no
 * coverage of events. The data comes from one host of Fintraffic. An old actual time tells of a stopped feed.
 */
export const RAIL_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Digitraffic rail: the running, late and cancelled passenger trains of Finland, from Fintraffic",
  origins: [FINTRAFFIC_ORIGIN],
  dependsOn: ["provider:fintraffic"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: [],
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 20_000,
  maxQuiet: 15 * MINUTE_MS,
  auth: "none",
  canary: "Trains run in Finland at each hour. The check passes when the newest actual time of a train is at most 30 minutes older than its fetch.",
  measures: RAIL_MEASURES,
};
