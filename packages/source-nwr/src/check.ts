/**
 * The canary check of the weather radio source. Each transmitter of NOAA Weather Radio sends a weekly test (`RWT`). In the
 * week of a monthly test (`RMT`), the monthly test takes its place. A recent test proves
 * that the transmitter, the receiver and the decoder work.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { parseSameHeader, sameIssuedAt } from "@mark1russell7/alerts-format-nws";

/** The event codes of the tests of the transmitter. */
export const TEST_EVENTS: ReadonlySet<string> = new Set(["RWT", "RMT"]);

/**
 * The largest age of the newest test. A test comes each week, so the limit is one week and one day. The NWS can move
 * a test to a later day in severe weather. This limit comes from the rule, not from a measure of a receiver.
 */
export const TEST_MAX_AGE_MS: number = 8 * 24 * 3_600_000;

/** This function gives the time of the issue of a test in an observation. Another observation gives `undefined`. */
export function testIssuedAt(observation: Observation): Instant | undefined {
  const header = parseSameHeader(observation.body);
  if (header === undefined || !TEST_EVENTS.has(header.event)) return undefined;
  return sameIssuedAt(header, observation.fetched);
}

/** The decoder at a check: the time of its start, and the time of the check. */
export interface CanaryDecoder {
  readonly started: Instant;
  readonly now: Instant;
}

/**
 * This function examines the observations of one fetch against the canary. The fetch gives the newest test again
 * each time, with the time of the fetch. The check passes when the newest test is at most 8 days old.
 *
 * A new decoder hears no test before the next one. Thus with no test, the check gives no read (`undefined`) in the
 * first 8 days of the decoder. After them, or with no decoder, it fails. The function is pure.
 */
export function checkCanary(observations: readonly Observation[], decoder?: CanaryDecoder): CanaryResult | undefined {
  let newest: { readonly issued: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const issued = testIssuedAt(observation);
    if (issued !== undefined && (newest === undefined || issued > newest.issued)) newest = { issued, fetched: observation.fetched };
  }
  if (newest !== undefined) {
    const age = newest.fetched - newest.issued;
    const hours = (age / 3_600_000).toFixed(1);
    return age <= TEST_MAX_AGE_MS ? { pass: true, reason: `The newest weekly test is ${hours} hours old.`, age: age, limit: TEST_MAX_AGE_MS } : { pass: false, reason: `The newest weekly test is ${hours} hours old. The limit is 8 days.`, late: true, age: age, limit: TEST_MAX_AGE_MS };
  }
  if (decoder !== undefined && decoder.now - decoder.started < TEST_MAX_AGE_MS) return undefined;
  return { pass: false, reason: "The receiver heard no weekly test in 8 days." };
}
