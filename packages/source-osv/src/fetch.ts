/**
 * The fetch function of an OSV provider. A provider of the exports reads the change lists of OSV.dev (`exports.ts`). A
 * provider of a GitHub repository reads the commits of the repository (`github.ts`). The requests hold no place, no
 * query of a person and no key.
 *
 * Each fetch gives one observation of the head of the fetch, for the canary, and one observation for each record that it
 * read. Each fetch reads at most `RECORDS_PER_FETCH` records, the oldest change first. The cursor holds the position of
 * the fetch, so the next fetch reads the rest.
 */

import { createExportsFetch } from "./exports.ts";
import { createGithubFetch } from "./github.ts";
import type { OsvFetch, OsvFetchOptions } from "./options.ts";
import type { OsvProvider } from "./providers.ts";

/**
 * This function makes the fetch function of one provider. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 */
export function createOsvFetch(provider: OsvProvider, options: OsvFetchOptions): OsvFetch {
  const feed = provider.feed;
  return feed.type === "exports" ? createExportsFetch(provider, feed, options) : createGithubFetch(provider, feed, options);
}
