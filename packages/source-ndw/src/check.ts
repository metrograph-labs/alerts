/**
 * The canary check of the NDW source. NDW writes the situation publication each minute. Thus a publication that is much
 * older than its fetch tells of a stopped feed.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { MINUTE_MS } from "./descriptor.ts";
import { publishedOf } from "./map.ts";

/** The largest age of the newest publication at its fetch: 10 minutes, ten times the interval of the writes of NDW. */
export const PUBLISHED_MAX_AGE_MS: number = 10 * MINUTE_MS;

/**
 * This function examines the observations of one fetch against the canary. The check passes when the newest publication
 * is at most `PUBLISHED_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly published: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const published = publishedOf(observation.body);
    if (published !== undefined && (newest === undefined || published > newest.published)) newest = { published, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no situation publication of NDW" };
  const minutes = ((newest.fetched - newest.published) / MINUTE_MS).toFixed(1);
  const text = new Date(newest.published).toISOString();
  if (newest.fetched - newest.published > PUBLISHED_MAX_AGE_MS) {
    return { pass: false, reason: `the newest publication of NDW is of ${text}, ${minutes} minutes before the fetch: the limit is ${String(PUBLISHED_MAX_AGE_MS / MINUTE_MS)} minutes`, late: true, age: newest.fetched - newest.published, limit: PUBLISHED_MAX_AGE_MS };
  }
  return { pass: true, reason: `the newest publication of NDW is of ${text}, ${minutes} minutes before the fetch`, age: newest.fetched - newest.published, limit: PUBLISHED_MAX_AGE_MS };
}
