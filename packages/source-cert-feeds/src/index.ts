/**
 * The CERT feed sources of the alert system: the alerts and reports of national computer emergency response teams, from
 * their RSS feeds. Each provider of `CERT_PROVIDERS` is one source. Each recent entry of its feed gives a report.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { certDescriptor } from "./descriptor.ts";
import { createCertFetch, type CertFetchOptions } from "./fetch.ts";
import { createCertMap } from "./map.ts";
import type { CertProvider } from "./providers.ts";

export { checkCanary, newestOf } from "./check.ts";
export { certDescriptor } from "./descriptor.ts";
export { CERT_CONTENT_TYPE, createCertFetch, cvesOf, datedEntries, ENTRIES_PER_FETCH, entryBody, ENTRY_WINDOW_MS, FEED_TIMEOUT_MS, MAX_CVES, MAX_SUMMARY, plainText } from "./fetch.ts";
export type { CertFetchInput, CertFetchOptions, DatedEntries, DatedEntry, EntryBody, HeadBody } from "./fetch.ts";
export { createCertMap, CVE_SYSTEM, ENTRY_LIFE_MS, isHeadBody, urgencyOf } from "./map.ts";
export { ADVISORY_KIND, CAMPAIGN_KIND, CERT_PROVIDERS, DAY_MS, EXPLOITED_KIND, ICS_KIND, INFRASTRUCTURE_KIND, kindOf, PUBLISHED_KIND } from "./providers.ts";
export type { CertProvider, KindRule } from "./providers.ts";

/**
 * This function makes the procedures of the source of one provider. The source has a canary: the age of the newest entry
 * of the feed. It has no `locate`: the source asks for no point.
 */
export function createCertSource(provider: CertProvider, options: CertFetchOptions): SourceProcedures {
  const fetch = createCertFetch(provider, options);
  const map = createCertMap(provider);
  const descriptor = certDescriptor(provider);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => map(observation),
    check: ({ observations }) => checkCanary(provider, observations),
  };
}
