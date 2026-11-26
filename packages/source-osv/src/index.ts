/**
 * The OSV sources of the alert system: the records of malicious packages in the OSV format. Each provider of
 * `OSV_PROVIDERS` is one source. Each new or changed record of its feed gives a report.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { osvDescriptor } from "./descriptor.ts";
import { createOsvFetch } from "./fetch.ts";
import { createOsvMap } from "./map.ts";
import type { OsvFetchOptions } from "./options.ts";
import type { OsvProvider } from "./providers.ts";

export { fileBody, isHeadBody, isRecordBody, isRefusedBody, MAX_DETAILS, MAX_PACKAGES, MAX_REFERENCES, MAX_VERSIONS, rangeText, recordBody } from "./body.ts";
export type { HeadBody, ListHead, PackageBody, RecordBody, RefusedBody } from "./body.ts";
export { comparePositions, orderOf, orderOfInstant, positionText, readChanges, readPosition, selectChanges } from "./changes.ts";
export type { Change, ChangeList, Position, Selection } from "./changes.ts";
export { checkCanary, newestOf } from "./check.ts";
export { osvDescriptor } from "./descriptor.ts";
export { isCutRange, LARGE_LIST_BYTES, LIST_BYTES } from "./exports.ts";
export { createOsvFetch } from "./fetch.ts";
export { GITHUB_API_VERSION, githubCursor, MAX_COMPARE_FILES, readCommits, readComparison, readGithubCursor, recordFiles } from "./github.ts";
export type { CommitRef, Comparison, GithubPosition } from "./github.ts";
export { createOsvMap, CVE_SYSTEM, OSV_PAGE, OSV_SYSTEM, PURL_SYSTEM, RECORD_LIFE_MS, UPDATE_AFTER_MS } from "./map.ts";
export { BACKFILL_MS, OSV_CONTENT_TYPE, OSV_TIMEOUT_MS, RECORDS_PER_FETCH } from "./options.ts";
export type { OsvFetch, OsvFetchInput, OsvFetchOptions } from "./options.ts";
export { cwesOf, EVENT_NAMES, isWithdrawn, RANGE_TYPES, readOsv, readOsvText } from "./osv.ts";
export type { OsvAffected, OsvEvent, OsvRange, OsvRead, OsvRecord, OsvReference, OsvSeverity } from "./osv.ts";
export { DAY_MS, MALICIOUS_KIND, OSV_PROVIDERS } from "./providers.ts";
export type { ExportsFeed, GithubFeed, OsvProvider } from "./providers.ts";
export { packagePurl, PURL_TYPES, purlOf } from "./purl.ts";

/**
 * This function makes the procedures of the source of one provider. The source has a canary: the age of the newest change
 * of the feed. It has no `locate`: the source asks for no point.
 */
export function createOsvSource(provider: OsvProvider, options: OsvFetchOptions): SourceProcedures {
  const fetch = createOsvFetch(provider, options);
  const map = createOsvMap(provider);
  const descriptor = osvDescriptor(provider);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => map(observation),
    check: ({ observations }) => checkCanary(provider, observations),
  };
}
