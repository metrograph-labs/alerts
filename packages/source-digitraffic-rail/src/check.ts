/**
 * The canary check of the Digitraffic rail source. Trains run in Finland at each hour of the day, also freight trains at
 * night. Each running train reports its stops. Thus a newest actual time that is much older than its fetch tells of a
 * stopped feed.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { MINUTE_MS } from "./descriptor.ts";
import { newestOf } from "./map.ts";

/** The largest age of the newest actual time of a running train at its fetch: 30 minutes. */
export const NEWEST_MAX_AGE_MS: number = 30 * MINUTE_MS;

/**
 * This function examines the observations of one fetch against the canary. The check passes when the newest actual time
 * of a running train is at most `NEWEST_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly time: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const time = newestOf(observation.body);
    if (time !== undefined && (newest === undefined || time > newest.time)) newest = { time, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no running train with an actual time" };
  const minutes = ((newest.fetched - newest.time) / MINUTE_MS).toFixed(1);
  const text = new Date(newest.time).toISOString();
  if (newest.fetched - newest.time > NEWEST_MAX_AGE_MS) {
    return { pass: false, reason: `the newest actual time of a train is ${text}, ${minutes} minutes before the fetch: the limit is ${String(NEWEST_MAX_AGE_MS / MINUTE_MS)} minutes`, late: true, age: newest.fetched - newest.time, limit: NEWEST_MAX_AGE_MS };
  }
  return { pass: true, reason: `the newest actual time of a train is ${text}, ${minutes} minutes before the fetch`, age: newest.fetched - newest.time, limit: NEWEST_MAX_AGE_MS };
}
