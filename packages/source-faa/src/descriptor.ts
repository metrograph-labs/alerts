/**
 * The descriptor of the FAA source: the facts that the core uses for the schedule, the health and the indicator measures.
 */

import type { MeasureDeclaration, SourceDescriptor } from "@mark1russell7/alerts";

import { AIRPORT_UNIT, AIRPORTS_DELAYED_MEASURE, AIRPORTS_HELD_MEASURE, FAA_ORIGIN, PROGRAM_KIND, SOURCE_ID } from "./map.ts";

/** The time between two fetches: 2 minutes, two updates of the status. */
export const FETCH_INTERVAL_MS = 120_000;

/** The two measures of the source. Each has one series for the country and one for each US state with a watched place. */
export const FAA_MEASURES: readonly MeasureDeclaration[] = [
  {
    id: AIRPORTS_HELD_MEASURE,
    dimension: "aviation-delays",
    title: "The airports with a ground stop or a ground delay program, in the US and in each US state with a watched place",
    unit: AIRPORT_UNIT,
    area: "code",
    moves: "rise",
    baseline: "none",
    cadence: FETCH_INTERVAL_MS,
  },
  {
    id: AIRPORTS_DELAYED_MEASURE,
    dimension: "aviation-delays",
    title: "The airports with a delay in the status of the FAA, in the US and in each US state with a watched place",
    unit: AIRPORT_UNIT,
    area: "code",
    moves: "rise",
    baseline: "none",
    cadence: FETCH_INTERVAL_MS,
  },
];

/**
 * The descriptor of the FAA source. The source gives indicator readings, and one report for each ground stop and ground
 * delay program at a US airport. Each complete fetch gives each program in effect, so the source is a snapshot source.
 */
export const FAA_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "FAA airport status: the ground stops, ground delay programs and delays of US airports",
  origins: [FAA_ORIGIN],
  dependsOn: ["provider:faa"],
  uses: ["internet", "dns", "power"],
  kinds: [PROGRAM_KIND],
  coverage: [{ type: "code", system: "iso3166", code: "US" }],
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 10_000,
  maxQuiet: 30 * 60_000,
  auth: "none",
  listing: "snapshot",
  canary: "The FAA updates the status approximately one time each minute. The check passes when the update is at most 15 minutes older than the fetch.",
  measures: FAA_MEASURES,
};
