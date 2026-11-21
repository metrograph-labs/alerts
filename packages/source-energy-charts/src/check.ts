/**
 * The canary check of the Energy-Charts source. The meter gives a value each second, and the API publishes the values
 * each minute. Thus a fetch with no recent complete minute tells of an old series.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

import { MEASURE_DELAY_MS } from "./descriptor.ts";
import { minuteStart, MINUTE_MS } from "./map.ts";

/**
 * The largest age of the start of the newest complete minute at its fetch. At a fetch, the newest complete minute
 * starts at most 1 minute and `MEASURE_DELAY_MS` before it. The limit adds 1 minute of margin: 6 minutes.
 */
export const NEWEST_MAX_AGE_MS: number = MEASURE_DELAY_MS + 2 * MINUTE_MS;

/** This function gives the start of the minute of an observation, or `undefined` for a body that is not one minute. */
function startOf(observation: Observation): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    return isRecord(fields) ? minuteStart(fields["minute"]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the start of the
 * newest minute is at most `NEWEST_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly start: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const start = startOf(observation);
    if (start !== undefined && (newest === undefined || start > newest.start)) newest = { start, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no complete minute of the grid frequency" };
  const minutes = ((newest.fetched - newest.start) / MINUTE_MS).toFixed(1);
  const text = new Date(newest.start).toISOString().replace(".000Z", "Z");
  if (newest.fetched - newest.start > NEWEST_MAX_AGE_MS) {
    return { pass: false, reason: `the newest minute of the grid frequency starts at ${text}, ${minutes} minutes before the fetch: the limit is ${String(NEWEST_MAX_AGE_MS / MINUTE_MS)} minutes` };
  }
  return { pass: true, reason: `the newest minute of the grid frequency starts at ${text}, ${minutes} minutes before the fetch` };
}
