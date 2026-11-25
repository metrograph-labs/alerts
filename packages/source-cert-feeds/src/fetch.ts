/**
 * The fetch function of a CERT feed. Each fetch is one conditional GET of the feed through polite-crawler. The request
 * holds no place and no query.
 *
 * The fetch gives one observation of the head of the feed, and one observation for each entry of the last
 * `ENTRY_WINDOW_MS`. An older entry gives no observation: its report has ended. Two fetches of one entry give one body,
 * and thus one observation id, so the runtime keeps one copy.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import { scanHtml } from "@mark1russell7/text/html";
import { decodeReferences } from "@mark1russell7/text/references";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { DAY_MS, type CertProvider } from "./providers.ts";

/** The age limit of an entry that gives an observation: 30 days, the life of a report. */
export const ENTRY_WINDOW_MS: number = 30 * DAY_MS;

/** The most entries that one fetch gives, the newest first. */
export const ENTRIES_PER_FETCH = 50;

/** The longest text of an entry, in characters. A longer text is cut. */
export const MAX_SUMMARY = 2000;

/** The most CVE ids of one entry. */
export const MAX_CVES = 50;

/** The longest time of one request when the source gives none, in milliseconds. The feed of CISA had 389 kB. */
export const FEED_TIMEOUT_MS = 30_000;

/** The content type of each observation. */
export const CERT_CONTENT_TYPE = "application/json";

/** The pattern of a CVE id in a text. */
const CVE_PATTERN = /\bCVE-[0-9]{4}-[0-9]{4,}\b/g;

/** The options of the fetch function of a CERT feed. */
export interface CertFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The origin of the feed. The default is the origin of the feed of the provider. A test gives a different origin. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `FEED_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface CertFetchInput {
  readonly watch: Watch;
}

/** The body of the head of the feed: the observation of each fetch that the canary reads. */
export interface HeadBody {
  readonly feed: string;
  /** The time of the newest entry, or `null` for a feed with no dated entry. */
  readonly newest: string | null;
  readonly entries: number;
  /** The count of the entries with no valid time, or with no id and no link. They give no observation. */
  readonly invalid: number;
}

/** The body of one entry. */
export interface EntryBody {
  /** The id of the entry: its `guid`, else its link. */
  readonly key: string;
  readonly title: string;
  readonly link?: string;
  /** The time of the entry, as ISO 8601. */
  readonly time: string;
  /** The plain text of the entry, cut to `MAX_SUMMARY` characters. */
  readonly summary?: string;
  readonly categories: readonly string[];
  /** The CVE ids in the title and the text, each one time, at most `MAX_CVES`. */
  readonly cves: readonly string[];
}

/** An entry of the feed with its time. */
export interface DatedEntry {
  readonly entry: FeedEntry;
  readonly key: string;
  readonly time: Instant;
}

/** The parts of a read feed that the fetch keeps for a later 304 answer. */
export interface DatedEntries {
  readonly dated: readonly DatedEntry[];
  readonly invalid: number;
}

/**
 * This function gives the plain text of the HTML of an entry: no tags, decoded references and single spaces. An empty text
 * gives `undefined`. It is the third copy of this function in the adapters. AL-183 moves it to `@mark1russell7/text`.
 */
export function plainText(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = decodeReferences(scanHtml(html).text).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

/** This function gives the CVE ids of a text, each one time, in the order of the text, at most `MAX_CVES`. */
export function cvesOf(text: string): readonly string[] {
  return [...new Set(text.match(CVE_PATTERN) ?? [])].slice(0, MAX_CVES);
}

/** This function gives the body of one entry. */
export function entryBody(dated: DatedEntry): EntryBody {
  const { entry } = dated;
  const summary = plainText(entry.summary);
  const title = plainText(entry.title) ?? dated.key;
  return {
    key: dated.key,
    title,
    ...(entry.link === undefined ? {} : { link: entry.link }),
    time: new Date(dated.time).toISOString(),
    ...(summary === undefined ? {} : { summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary }),
    categories: entry.categories ?? [],
    cves: cvesOf(`${entry.title ?? ""} ${entry.summary ?? ""}`),
  };
}

/** This function gives the entries of a feed with a time and a key, the newest first, and the count of the others. */
export function datedEntries(entries: readonly FeedEntry[]): DatedEntries {
  const dated: DatedEntry[] = [];
  let invalid = 0;
  for (const entry of entries) {
    const time = entry.updated === undefined ? Number.NaN : Date.parse(entry.updated);
    const key = entry.id ?? entry.link;
    if (key === undefined || !Number.isFinite(time)) invalid += 1;
    else dated.push({ entry, key, time });
  }
  dated.sort((a, b) => b.time - a.time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { dated, invalid };
}

/**
 * This function makes the fetch function of one provider. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * The GET is conditional. A 304 answer gives the entries of the last full answer of the process again, against the time
 * of this fetch. A 304 comes only after a full answer in the same process.
 */
export function createCertFetch(provider: CertProvider, options: CertFetchOptions): (input: CertFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const feedUrl = new URL(provider.feed);
  const source = provider.id;
  const requester = createRequester({
    source,
    pace: options.pace,
    transport: options.transport,
    baseUrl: new URL(options.baseUrl ?? feedUrl.origin).origin,
    headers: { accept: "application/rss+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.8", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly read: DatedEntries } | undefined;

  const observation = (url: string, body: string, status: number, latency: number, fetched: Instant): Observation => ({
    id: observationId({ source, contentType: CERT_CONTENT_TYPE, url, body }),
    source,
    fetched,
    contentType: CERT_CONTENT_TYPE,
    body,
    transport: { url, status, latency },
  });

  return async (_input, signal) => {
    const requested = await requester.get({ path: `${feedUrl.pathname}${feedUrl.search}`, what: `the feed of ${provider.short}`, conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    let read: DatedEntries;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      read = last.read;
    } else {
      const feed = readFeed(answer.reply.body);
      if (!feed.ok) {
        // A body that does not parse must not be the base of a later 304.
        conditions.delete(url);
        last = undefined;
        return { ok: false, failure: feed.malformed ? { kind: "network", message: `truncated or malformed feed: ${url}` } : { kind: "server", message: `the answer is not a feed (${feed.reason}): ${url}` } };
      }
      read = datedEntries(feed.entries);
      last = { url, read };
    }
    const fetched = now();
    const status = answer.reply?.status ?? 304;
    const newest = read.dated[0];
    const head: HeadBody = { feed: provider.feed, newest: newest === undefined ? null : new Date(newest.time).toISOString(), entries: read.dated.length + read.invalid, invalid: read.invalid };
    const observations: Observation[] = [observation(url, JSON.stringify(head), status, latency, fetched)];
    for (const dated of read.dated.slice(0, ENTRIES_PER_FETCH)) {
      if (fetched - dated.time > ENTRY_WINDOW_MS) break;
      observations.push(observation(dated.entry.link ?? url, JSON.stringify(entryBody(dated)), status, latency, fetched));
    }
    return { ok: true, observations, complete: true };
  };
}
