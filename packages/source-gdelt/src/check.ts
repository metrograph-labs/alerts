/**
 * The canary check of the GDELT source. GDELT adds one event file each 15 minutes. An old newest file tells of a stop
 * of GDELT, or of a move of its files.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { headTime } from "./fetch.ts";

/** The largest age of the newest file at its fetch: one hour, the time of 4 files. */
export const FILE_MAX_AGE_MS = 3_600_000;

/**
 * This function examines the observations of one fetch against the canary. The check passes when the newest file is
 * at most `FILE_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly file: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const file = headTime(observation.body);
    if (file !== undefined && (newest === undefined || file > newest.file)) newest = { file, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no head with the time of a file" };
  const minutes = Math.round((newest.fetched - newest.file) / 60_000);
  const file = new Date(newest.file).toISOString();
  if (newest.fetched - newest.file > FILE_MAX_AGE_MS) return { pass: false, reason: `the newest file is of ${file}, ${minutes} minutes before the fetch: the limit is 60 minutes`, late: true, age: newest.fetched - newest.file, limit: FILE_MAX_AGE_MS };
  return { pass: true, reason: `the newest file is of ${file}, ${minutes} minutes before the fetch`, age: newest.fetched - newest.file, limit: FILE_MAX_AGE_MS };
}
