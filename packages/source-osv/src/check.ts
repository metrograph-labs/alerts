/**
 * The canary check of an OSV provider. Each feed changes at a known rate. An old newest change tells of a feed that its
 * owner does not keep current. For example, the exports or the repository moved.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";

import { isHeadBody } from "./body.ts";
import { DAY_MS, type OsvProvider } from "./providers.ts";

/** This function gives the time of the newest change of a head body, or `undefined`. */
export function newestOf(body: string): number | undefined {
  try {
    const fields: unknown = JSON.parse(body);
    if (!isHeadBody(fields) || typeof fields.newest !== "string") return undefined;
    const newest = Date.parse(fields.newest);
    return Number.isFinite(newest) ? newest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary of the provider. The check passes when the
 * newest change of the feed is at most `maxAge` of the provider older than the fetch. The function is pure.
 */
export function checkCanary(provider: OsvProvider, observations: readonly Observation[]): CanaryResult {
  let found: { readonly newest: number; readonly fetched: number } | undefined;
  for (const observation of observations) {
    const newest = newestOf(observation.body);
    if (newest !== undefined && (found === undefined || newest > found.newest)) found = { newest, fetched: observation.fetched };
  }
  if (found === undefined) return { pass: false, reason: "the fetch has no head with a newest change" };
  const days = ((found.fetched - found.newest) / DAY_MS).toFixed(1);
  const limit = String(Math.round(provider.maxAge / DAY_MS));
  const newest = new Date(found.newest).toISOString();
  if (found.fetched - found.newest > provider.maxAge) {
    return { pass: false, reason: `the newest change has the time ${newest}, ${days} days before the fetch: the limit is ${limit} days`, late: true, age: found.fetched - found.newest, limit: provider.maxAge };
  }
  return { pass: true, reason: `the newest change has the time ${newest}, ${days} days before the fetch`, age: found.fetched - found.newest, limit: provider.maxAge };
}
