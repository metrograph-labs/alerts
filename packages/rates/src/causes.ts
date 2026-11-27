/**
 * The cited shares of the deaths of a kind from one cause, for example CO poisoning after a hurricane. A planner
 * multiplies the harm of a kind by the share of a cause. Then it multiplies by the share of that cause that a step averts.
 *
 * - Each read is a count from a cited source: the deaths of the cause in all the deaths that the source counted.
 * - The value of a share is the pooled share of its reads. The interval is the hull of the Wilson interval of the
 *   pooled counts and the share of each read. Thus the interval holds the spread of the sources.
 * - A cause with no cited read is absent. It does not take 0.
 */

import type { CauseRead, CauseShare } from "@mark1russell7/alerts";
import { wilson } from "@mark1russell7/rigor-statistics";

/** The cited counts of each cause, by the prefix of the kind and then by the id of the cause. */
export const CAUSE_READS: Readonly<Record<string, Readonly<Record<string, readonly CauseRead[]>>>> = {
  "met.tropical": {
    "co-poisoning": [
      {
        deaths: 9,
        of: 117,
        source: "CDC. Deaths Associated with Hurricane Sandy, October-November 2012. MMWR 62(20), 2013",
        url: "https://www.cdc.gov/mmwr/preview/mmwrhtml/mm6220a1.htm",
      },
      {
        deaths: 16,
        of: 129,
        source: "CDC. Deaths Related to Hurricane Irma, Florida, Georgia, and North Carolina, 2017. MMWR 67(30), 2018",
        url: "https://www.cdc.gov/mmwr/volumes/67/wr/mm6730a5.htm",
      },
    ],
  },
};

/**
 * This function gives the share of a cause from its reads.
 *
 * @throws RangeError when the list has no read, or when a read has a count that is not valid
 */
export function causeShareOf(reads: readonly CauseRead[]): CauseShare {
  if (reads.length === 0) throw new RangeError("A cause share has one read or more.");
  for (const read of reads) {
    if (!Number.isInteger(read.deaths) || !Number.isInteger(read.of) || read.deaths < 0 || read.of < 1 || read.deaths > read.of) {
      throw new RangeError(`The read of ${read.source} has a count that is not valid: ${read.deaths} of ${read.of}.`);
    }
  }
  const deaths = reads.reduce((sum, read) => sum + read.deaths, 0);
  const of = reads.reduce((sum, read) => sum + read.of, 0);
  const value = deaths / of;
  const pooled = wilson(deaths, of);
  const shares = reads.map((read) => read.deaths / read.of);
  return { share: { value, low: Math.min(pooled.low, value, ...shares), high: Math.max(pooled.high, value, ...shares) }, reads };
}

/** This function gives the cause shares of each prefix of a kind in the table. */
export function causeSharesOf(table: typeof CAUSE_READS): Map<string, Record<string, CauseShare>> {
  const kinds = new Map<string, Record<string, CauseShare>>();
  for (const [kind, causes] of Object.entries(table)) {
    const shares = Object.fromEntries(Object.entries(causes).map(([cause, reads]) => [cause, causeShareOf(reads)] as const));
    if (Object.keys(shares).length > 0) kinds.set(kind, shares);
  }
  return kinds;
}
