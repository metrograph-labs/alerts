/**
 * The canary check of the EIA-930 source. Each balancing authority sends its demand each hour. Thus a fetch with no
 * recent hour with a demand tells of an old series.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { MEASURE_DELAY_MS } from "./descriptor.ts";
import { HOUR_MS, isPlaceholder, periodEnd } from "./map.ts";

/** The largest age of the end of the newest hour with a demand at its fetch: `MEASURE_DELAY_MS` and one hour of margin. */
export const NEWEST_MAX_AGE_MS: number = MEASURE_DELAY_MS + HOUR_MS;

/**
 * This function gives the end of the hour of an observation with a real demand: above 0 and not a placeholder
 * (`isPlaceholder`). Each other body gives `undefined`.
 */
function endOf(observation: Observation): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    if (typeof fields !== "object" || fields === null) return undefined;
    const { hour, demand, forecast } = fields as Record<string, unknown>;
    if (typeof demand !== "number" || demand <= 0) return undefined;
    return isPlaceholder(demand, typeof forecast === "number" ? forecast : null) ? undefined : periodEnd(hour);
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the end of the newest
 * hour with a real demand is at most `NEWEST_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly end: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const end = endOf(observation);
    if (end !== undefined && (newest === undefined || end > newest.end)) newest = { end, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no hour with a real demand" };
  const hours = ((newest.fetched - newest.end) / HOUR_MS).toFixed(1);
  const text = new Date(newest.end).toISOString().replace(".000Z", "Z");
  if (newest.fetched - newest.end > NEWEST_MAX_AGE_MS) {
    return { pass: false, reason: `the newest hour with a real demand ended at ${text}, ${hours} hours before the fetch: the limit is ${String(NEWEST_MAX_AGE_MS / HOUR_MS)} hours`, late: true };
  }
  return { pass: true, reason: `the newest hour with a real demand ended at ${text}, ${hours} hours before the fetch` };
}
