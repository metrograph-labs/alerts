/**
 * The fetch function of a CSAF provider. Each fetch reads the ROLIE feed of the provider through polite-crawler, and
 * then the documents of the advisories that changed since the last fetch. The requests hold no place and no query.
 *
 * The fetch keeps its position in the cursor: the time and the URL of the last entry that it read. The runtime keeps the
 * cursor in the log, so a copy after a start reads the same advisories as a copy that runs. With no cursor, the fetch reads
 * the advisories of the last `BACKFILL_MS`, not the whole feed. Each fetch reads at most `ADVISORIES_PER_FETCH` documents.
 */

import { observationId, type Cursor, type FetchOutcome, type FetchSignal, type Instant, type Observation, type SourceId, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { readAdvisory } from "./document.ts";
import { readFeed, selectEntries, type Feed, type FeedEntry } from "./feed.ts";
import { DAY_MS, type CsafProvider } from "./providers.ts";

/** The time before the fetch from which a fetch with no cursor reads the advisories: 7 days. */
export const BACKFILL_MS: number = 7 * DAY_MS;

/** The most documents that one fetch reads. The next fetches read the rest, in the order of the feed. */
export const ADVISORIES_PER_FETCH = 10;

/** The longest time of one request when the source gives none, in milliseconds. The feed of CISA is 4.4 MB. */
export const CSAF_TIMEOUT_MS = 30_000;

/** The content type of each observation. */
export const CSAF_CONTENT_TYPE = "application/json";

/** The options of the fetch function of a CSAF provider. */
export interface CsafFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The origin of the feed and of its documents. The default is the origin of the feed of the provider. A test gives a different origin. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `CSAF_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface CsafFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** The body of the head of the feed: the observation of each fetch that the canary reads. */
export interface HeadBody {
  readonly feed: string;
  /** The time of the newest entry, or `null` for a feed with no entry. */
  readonly newest: string | null;
  readonly entries: number;
  /** The count of the entries with no URL or no valid time. */
  readonly invalid: number;
}

/** This function gives the cursor of the last entry that a fetch read. */
export function cursorOf(entry: FeedEntry): Cursor {
  return { updated: new Date(entry.updated).toISOString(), url: entry.url };
}

/** This function reads a cursor of the fetch. A cursor with no valid time or no URL gives `undefined`: the state of a first fetch. */
export function readCursor(cursor: Cursor | undefined): FeedEntry | undefined {
  const updated = cursor?.["updated"] === undefined ? Number.NaN : Date.parse(cursor["updated"]);
  const url = cursor?.["url"];
  return Number.isFinite(updated) && typeof url === "string" && url !== "" ? { updated, url } : undefined;
}

/** This function gives the head of a feed. */
export function headOf(provider: CsafProvider, feed: Feed): HeadBody {
  const newest = feed.entries.at(-1);
  return { feed: provider.feed, newest: newest === undefined ? null : new Date(newest.updated).toISOString(), entries: feed.entries.length, invalid: feed.invalid };
}

/**
 * This function makes the fetch function of one provider. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * - The GET of the feed is conditional. A 304 answer selects from the last feed of the process. A 304 comes only after a
 *   full answer in the same process. Thus a copy after a start gets the full feed and selects the same entries.
 * - A document that the server does not find (a 404 or a 410) is passed, so one lost document does not stop the feed. Each
 *   other failure ends the fetch at that entry, and the next fetch reads that entry again.
 * - A document on a different origin than the feed is passed: the fetch follows no link to another host.
 */
export function createCsafFetch(provider: CsafProvider, options: CsafFetchOptions): (input: CsafFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const feedUrl = new URL(provider.feed);
  const origin = new URL(options.baseUrl ?? feedUrl.origin).origin;
  const source: SourceId = provider.id;
  const requester = createRequester({
    source,
    pace: options.pace,
    transport: options.transport,
    baseUrl: origin,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? CSAF_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly feed: Feed } | undefined;

  const observation = (url: string, body: string, status: number, latency: number, fetched: Instant): Observation => ({
    id: observationId({ source, contentType: CSAF_CONTENT_TYPE, url, body }),
    source,
    fetched,
    contentType: CSAF_CONTENT_TYPE,
    body,
    transport: { url, status, latency },
  });

  return async (input, signal) => {
    const requested = await requester.get({ path: feedUrl.pathname, what: "the ROLIE feed of the advisories", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    let feed: Feed;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      feed = last.feed;
    } else {
      const read = readFeed(answer.reply.body);
      if (read === undefined) {
        // A body that does not parse must not be the base of a later 304.
        conditions.delete(url);
        last = undefined;
        return { ok: false, failure: { kind: "network", message: `truncated or malformed feed: ${url}` } };
      }
      feed = read;
      last = { url, feed };
    }
    const fetched = now();
    const observations: Observation[] = [observation(url, JSON.stringify(headOf(provider, feed)), answer.reply?.status ?? 304, latency, fetched)];
    const after = readCursor(input.cursor);
    const selection = selectEntries(feed.entries, after, fetched - BACKFILL_MS, ADVISORIES_PER_FETCH);
    let reached = after;
    let stopped = false;
    for (const entry of selection.read) {
      let path: string | undefined;
      try {
        const target = new URL(entry.url);
        path = target.origin === origin ? `${target.pathname}${target.search}` : undefined;
      } catch {
        path = undefined;
      }
      if (path !== undefined) {
        const document = await requester.get({ path, what: "the CSAF document of an advisory" }, signal);
        // Only a document that is not found is passed. A 403 or a 401 tells of a block of the host, not of one document.
        if (!document.ok && document.answer?.classified.outcome !== "not-found") {
          stopped = true;
          break;
        }
        if (document.ok) {
          const body = readAdvisory(document.answer.reply.body, entry.url);
          observations.push(observation(entry.url, JSON.stringify(body), document.answer.reply.status, document.latency, now()));
        }
      }
      reached = entry;
    }
    // With nothing to read, the cursor names the newest entry. Thus the next fetch reads only the later advisories.
    if (selection.read.length === 0 && selection.later === 0 && reached === undefined) reached = feed.entries.at(-1);
    return { ok: true, observations, complete: !stopped, ...(reached === undefined ? {} : { cursor: cursorOf(reached) }) };
  };
}
