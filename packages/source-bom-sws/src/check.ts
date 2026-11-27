/**
 * The canary check of the BoM SWS source. The K index of the Australian region has a value for each 3-hour period,
 * and the API gives the newest value when it is recent. An empty list of alerts is normal, so the K index tells if the
 * API is current.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { bomTime, bomTimeText, METHODS, readItemBody } from "./map.ts";

/**
 * The largest age of the start of the newest period of the K index at its fetch: two periods. The value is a shortcut
 * with no measure, as for the source GFZ. It ends when a week of the canary records gives the largest age (AL-14).
 */
export const NEWEST_MAX_AGE_MS: number = 6 * 3_600_000;

/** This function gives the start of the period of an observation of the K index, or `undefined` for each other observation. */
function startOf(observation: Observation): Instant | undefined {
  const body = readItemBody(observation.body);
  return body?.method === METHODS.kIndex ? bomTime(body.item["valid_time"]) : undefined;
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the start of the
 * newest period of the K index is at most `NEWEST_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly start: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const start = startOf(observation);
    if (start !== undefined && (newest === undefined || start > newest.start)) newest = { start, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no K index of the Australian region" };
  const hours = ((newest.fetched - newest.start) / 3_600_000).toFixed(1);
  const text = `the newest period of the K index starts at ${bomTimeText(newest.start)} UTC, ${hours} hours before the fetch`;
  return newest.fetched - newest.start > NEWEST_MAX_AGE_MS ? { pass: false, reason: `${text}: the limit is 6 hours`, late: true, age: newest.fetched - newest.start, limit: NEWEST_MAX_AGE_MS } : { pass: true, reason: text, age: newest.fetched - newest.start, limit: NEWEST_MAX_AGE_MS };
}
