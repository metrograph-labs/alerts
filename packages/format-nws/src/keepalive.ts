/**
 * The keepalive of the NWS. The NWS sends a test message each 10 minutes, with the AWIPS id `KEPWBC`. A recent
 * keepalive proves that the full path works: the alert system of the NWS, the path of the source and the network. The NWS API source and the NWWS-OI source use the same rule for their canary checks.
 */

import type { CanaryResult, Instant } from "@mark1russell7/alerts";

/** The AWIPS id of the keepalive message of the NWS. */
export const KEEPALIVE_AWIPS_ID = "KEPWBC";

/** The longest age of the newest keepalive at the fetch: the period of 10 minutes and a margin. */
export const KEEPALIVE_MAX_AGE_MS: number = 15 * 60_000;

const KEEPALIVE_ID = /KEEPALIVE/i;

/** This function tells if a message is a keepalive of the NWS, from its identifier and its AWIPS ids. */
export function isKeepalive(identifier: string | undefined, awipsIds: readonly string[]): boolean {
  return (identifier !== undefined && KEEPALIVE_ID.test(identifier)) || awipsIds.some((id) => id.trim().toUpperCase() === KEEPALIVE_AWIPS_ID);
}

/**
 * This function gives the result of the canary check from the newest keepalive of a fetch. The check passes when the
 * keepalive is at most `KEEPALIVE_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function keepaliveCheck(newest: { readonly sent: Instant; readonly fetched: Instant } | undefined): CanaryResult {
  if (newest === undefined) return { pass: false, reason: "the fetch has no keepalive message of the NWS" };
  const age = newest.fetched - newest.sent;
  const minutes = (age / 60_000).toFixed(1);
  if (age > KEEPALIVE_MAX_AGE_MS) {
    return { pass: false, reason: `the newest keepalive message of the NWS is ${minutes} minutes old: the limit is 15 minutes`, late: true };
  }
  return { pass: true, reason: `the newest keepalive message of the NWS is ${minutes} minutes old` };
}
