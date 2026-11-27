/**
 * The canary check of the CISA KEV source. CISA releases the catalog on most work days. Thus a catalog with an old
 * release tells of a file that CISA no longer keeps current, for example after a move of the feed.
 */

import { canaryLimit, type CanaryResult, type Instant, type Observation } from "@mark1russell7/alerts";

import { ADDED_DATES } from "./added.ts";
import { releasedOf } from "./fetch.ts";
import { dateStart } from "./map.ts";

const DAY_MS = 86_400_000;

/** The publish times of the record `ADDED_DATES`: the start of each date of addition, at 00:00 UTC. */
export const ADDED_TIMES: readonly Instant[] = ADDED_DATES.flatMap((date) => {
  const start = dateStart(date);
  return start === undefined ? [] : [start];
});

/**
 * The largest age of the release of the catalog at its fetch, from the measured gaps between two dates of addition
 * (`canaryLimit` of the core). The 505 gaps of `ADDED_DATES` give the bound 26 days. The margin of one day holds the
 * time from the start of a date to the release in that day. Thus the limit is 27 days. A record with too few gaps
 * gives the limit 0, so each check fails and the test of the limit fails.
 */
export const RELEASE_MAX_AGE_MS: number = canaryLimit(ADDED_TIMES, { margin: DAY_MS }) ?? 0;

/**
 * This function examines the observations of one fetch against the canary. The check passes when the release of the
 * catalog is at most `RELEASE_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly released: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const released = releasedOf(observation.body);
    if (released !== undefined && (newest === undefined || released > newest.released)) newest = { released, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no head of the catalog with a release time" };
  const days = ((newest.fetched - newest.released) / DAY_MS).toFixed(1);
  const released = new Date(newest.released).toISOString();
  if (newest.fetched - newest.released > RELEASE_MAX_AGE_MS) {
    return { pass: false, reason: `the catalog was released at ${released}, ${days} days before the fetch: the limit is ${String(RELEASE_MAX_AGE_MS / DAY_MS)} days` };
  }
  return { pass: true, reason: `the catalog was released at ${released}, ${days} days before the fetch` };
}
