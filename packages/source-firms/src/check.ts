/**
 * The canary check of the FIRMS source. Each fetch reads the dates of the data of each product. The satellites pass each
 * place two times each day. Thus a product is old when it has no data of the day of its fetch or of the day before.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

import { AVAILABILITY_TYPE } from "./map.ts";

/** The largest age of the newest date of the data at a fetch, in days of UTC. The day of the fetch and the day before pass. */
export const NEWEST_MAX_DAYS = 1;

const DAY_MS = 86_400_000;

/** This function gives the newest date of the data of an observation of the dates, or `undefined` for each other body. */
function newestOf(observation: Observation): string | undefined {
  try {
    const fields: unknown = JSON.parse(observation.body);
    if (!isRecord(fields) || fields["type"] !== AVAILABILITY_TYPE || !isRecord(fields["products"])) return undefined;
    const dates = Object.values(fields["products"]).filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date));
    return dates.sort().at(-1);
  } catch {
    return undefined;
  }
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when the newest date of the
 * data of a product is at most `NEWEST_MAX_DAYS` before the day of the fetch in UTC. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  for (const observation of observations) {
    const newest = newestOf(observation);
    if (newest === undefined) continue;
    const today = new Date(Math.floor(observation.fetched / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    const days = Math.round((Date.parse(today) - Date.parse(newest)) / DAY_MS);
    if (days > NEWEST_MAX_DAYS) return { pass: false, reason: `the newest data of the VIIRS products is of ${newest}, ${String(days)} days before the day of the fetch: the limit is ${String(NEWEST_MAX_DAYS)} day` };
    return { pass: true, reason: `the newest data of the VIIRS products is of ${newest}, the day of the fetch is ${today}` };
  }
  return { pass: false, reason: "the fetch has no dates of the data" };
}
