/**
 * The canary check of the GFZ sources. Each series has a value for each interval, and the value of an interval comes
 * during it or soon after it. Thus a fetch with no recent interval tells of an old series.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

import { intervalStartOf, intervalText, KP_INDEX, type GfzIndex } from "./map.ts";

/** The largest age of the start of the newest interval of Kp at its fetch: two intervals. */
export const NEWEST_MAX_AGE_MS: number = KP_INDEX.newestMaxAgeMs;

/** This function gives the start of the interval of an observation, or `undefined` for a body that is not one interval. */
function startOf(index: GfzIndex, observation: Observation): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    return isRecord(fields) ? intervalStartOf(index, fields["datetime"]) : undefined;
  } catch {
    return undefined;
  }
}

/** This function examines the observations of one fetch of Kp against the canary, as `checkIndexCanary` tells. */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  return checkIndexCanary(KP_INDEX, observations);
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the start of the
 * newest interval is at most `newestMaxAgeMs` of the index older than its fetch. The function is pure.
 */
export function checkIndexCanary(index: GfzIndex, observations: readonly Observation[]): CanaryResult {
  let newest: { readonly start: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const start = startOf(index, observation);
    if (start !== undefined && (newest === undefined || start > newest.start)) newest = { start, fetched: observation.fetched };
  }
  const limit = `${index.newestMaxAgeMs / 3_600_000} hours`;
  if (newest === undefined) return { pass: false, reason: `the fetch has no interval of the index ${index.name} of the past ${limit}` };
  const hours = ((newest.fetched - newest.start) / 3_600_000).toFixed(1);
  if (newest.fetched - newest.start > index.newestMaxAgeMs) {
    return { pass: false, reason: `the newest interval of the index ${index.name} starts at ${intervalText(newest.start)}, ${hours} hours before the fetch: the limit is ${limit}` };
  }
  return { pass: true, reason: `the newest interval of the index ${index.name} starts at ${intervalText(newest.start)}, ${hours} hours before the fetch` };
}
