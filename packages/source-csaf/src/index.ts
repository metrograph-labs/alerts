/**
 * The CSAF sources of the alert system: the security advisories of agencies and vendors in the format CSAF 2.0. Each
 * provider of `CSAF_PROVIDERS` is one source. Each new or changed advisory of its ROLIE feed gives a report.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { csafDescriptor } from "./descriptor.ts";
import { createCsafFetch, type CsafFetchOptions } from "./fetch.ts";
import { createCsafMap } from "./map.ts";
import type { CsafProvider } from "./providers.ts";

export { checkCanary, newestOf } from "./check.ts";
export { csafDescriptor } from "./descriptor.ts";
export { flawsOf, MAX_FLAWS, MAX_PRODUCTS, MAX_SUMMARY, productNames, readAdvisory, SHARED_LABELS } from "./document.ts";
export type { AdvisoryBody, Flaw, RefusedBody } from "./document.ts";
export { AFFECTED_STATUS, affectedPackages, MAX_PACKAGES, MAX_RANGES, productsOf, rangeOf } from "./products.ts";
export type { AffectedPackages, ProductPackage } from "./products.ts";
export { compareEntries, readFeed, selectEntries } from "./feed.ts";
export type { Feed, FeedEntry, Selection } from "./feed.ts";
export { ADVISORIES_PER_FETCH, BACKFILL_MS, createCsafFetch, CSAF_CONTENT_TYPE, CSAF_TIMEOUT_MS, cursorOf, headOf, readCursor } from "./fetch.ts";
export type { CsafFetchInput, CsafFetchOptions, HeadBody } from "./fetch.ts";
export { ADVISORY_LIFE_MS, AGGREGATE_SEVERITY, createCsafMap, CVE_SYSTEM, highestScore, isHeadBody, severityOfScore } from "./map.ts";
export { ADVISORY_KIND, CSAF_PROVIDERS, DAY_MS, ICS_ADVISORY_KIND } from "./providers.ts";
export type { CsafProvider } from "./providers.ts";

/**
 * This function makes the procedures of the source of one provider. The source has a canary: the age of the newest
 * advisory of the feed. It has no `locate`: the source asks for no point.
 */
export function createCsafSource(provider: CsafProvider, options: CsafFetchOptions): SourceProcedures {
  const fetch = createCsafFetch(provider, options);
  const map = createCsafMap(provider);
  const descriptor = csafDescriptor(provider);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => map(observation),
    check: ({ observations }) => checkCanary(provider, observations),
  };
}
