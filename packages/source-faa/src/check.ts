/**
 * The canary check of the FAA source. The FAA updates the status approximately one time each minute, also with no delay. Thus a
 * fetch with an old update tells of a stopped status.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

/** The largest age of the update of the status at its fetch: 15 minutes. */
export const STATUS_MAX_AGE_MS: number = 15 * 60_000;

/** This function gives the time of the update of a census, or `undefined` for a body that is not a census. */
function updateOf(observation: Observation): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    const time = isRecord(fields) && typeof fields["status"] === "string" ? Date.parse(fields["status"]) : Number.NaN;
    return Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  }
}

/** This function examines the observations of one fetch against the canary. The function is pure. */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly update: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const update = updateOf(observation);
    if (update !== undefined && (newest === undefined || update > newest.update)) newest = { update, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no census of the airport status" };
  const minutes = ((newest.fetched - newest.update) / 60_000).toFixed(1);
  const text = new Date(newest.update).toISOString().replace(".000Z", "Z");
  if (newest.fetched - newest.update > STATUS_MAX_AGE_MS) {
    return { pass: false, reason: `the airport status has the update ${text}, ${minutes} minutes before the fetch: the limit is 15 minutes` };
  }
  return { pass: true, reason: `the airport status has the update ${text}, ${minutes} minutes before the fetch` };
}
