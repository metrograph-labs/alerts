/**
 * The canary check of a CSAF provider. Each provider publishes or updates advisories at a known rate. An old newest advisory
 * tells of a feed that the provider no longer keeps current, for example after a move of the feed.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

import { isHeadBody } from "./map.ts";
import { DAY_MS, type CsafProvider } from "./providers.ts";

/** This function gives the time of the newest entry of a head body, or `undefined`. */
export function newestOf(body: string): number | undefined {
  try {
    const fields: unknown = JSON.parse(body);
    if (!isRecord(fields) || !isHeadBody(fields) || typeof fields["newest"] !== "string") return undefined;
    const newest = Date.parse(fields["newest"]);
    return Number.isFinite(newest) ? newest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary of the provider. The check passes when the
 * newest advisory of the feed is at most `maxAge` of the provider older than the fetch. The function is pure.
 */
export function checkCanary(provider: CsafProvider, observations: readonly Observation[]): CanaryResult {
  let found: { readonly newest: number; readonly fetched: number } | undefined;
  for (const observation of observations) {
    const newest = newestOf(observation.body);
    if (newest !== undefined && (found === undefined || newest > found.newest)) found = { newest, fetched: observation.fetched };
  }
  if (found === undefined) return { pass: false, reason: "the fetch has no head of the feed with a newest advisory" };
  const days = ((found.fetched - found.newest) / DAY_MS).toFixed(1);
  const limit = String(Math.round(provider.maxAge / DAY_MS));
  const newest = new Date(found.newest).toISOString();
  if (found.fetched - found.newest > provider.maxAge) {
    return { pass: false, reason: `the newest advisory has the time ${newest}, ${days} days before the fetch: the limit is ${limit} days`, late: true };
  }
  return { pass: true, reason: `the newest advisory has the time ${newest}, ${days} days before the fetch` };
}
