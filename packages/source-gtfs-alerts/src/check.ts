/**
 * The canary check of the source of a feed. The server of an agency makes its feed again at each change, or each 30
 * seconds or more. Thus a feed with an old header time tells of a server that stopped.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";
import { isRecord, timeOf } from "@mark1russell7/optional/read";

/** The largest age of the time of a feed at its fetch: one hour. */
export const FEED_MAX_AGE_MS: number = 60 * 60_000;

/** This function gives the time of the census of an observation, or `undefined` for a body that is not a census. */
function censusAt(observation: Observation): number | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    return isRecord(fields) && fields["type"] === "census" ? timeOf(fields, "at") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the fetch has a census,
 * and its time is at most `FEED_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  for (const observation of observations) {
    const at = censusAt(observation);
    if (at === undefined) continue;
    const minutes = ((observation.fetched - at) / 60_000).toFixed(1);
    const text = new Date(at).toISOString().replace(".000Z", "Z");
    if (observation.fetched - at > FEED_MAX_AGE_MS) {
      return { pass: false, reason: `the time of the feed is ${text}, ${minutes} minutes before the fetch: the limit is ${String(FEED_MAX_AGE_MS / 60_000)} minutes`, late: true };
    }
    return { pass: true, reason: `the time of the feed is ${text}, ${minutes} minutes before the fetch` };
  }
  return { pass: false, reason: "the fetch has no census of the feed" };
}
