/**
 * The canary check of the GFZ source. The series has a value for each 3-hour interval, and the value of the current
 * interval comes during the interval. Thus a fetch with no interval of the past 6 hours tells of an old series.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

import { intervalStart, intervalText } from "./map.ts";

/** The largest age of the start of the newest interval at its fetch: two intervals. */
export const NEWEST_MAX_AGE_MS: number = 6 * 3_600_000;

/** This function gives the start of the interval of an observation, or `undefined` for a body that is not one interval. */
function startOf(observation: Observation): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    return isRecord(fields) ? intervalStart(fields["datetime"]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the start of the
 * newest interval is at most `NEWEST_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly start: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const start = startOf(observation);
    if (start !== undefined && (newest === undefined || start > newest.start)) newest = { start, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no interval of the index Kp of the past 6 hours" };
  const hours = ((newest.fetched - newest.start) / 3_600_000).toFixed(1);
  if (newest.fetched - newest.start > NEWEST_MAX_AGE_MS) {
    return { pass: false, reason: `the newest interval of the index Kp starts at ${intervalText(newest.start)}, ${hours} hours before the fetch: the limit is 6 hours` };
  }
  return { pass: true, reason: `the newest interval of the index Kp starts at ${intervalText(newest.start)}, ${hours} hours before the fetch` };
}
