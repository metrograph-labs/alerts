/**
 * The fetch function of the feed of the AWS Health Dashboard. It reads the RSS feed of all the services through
 * polite-crawler. The request holds no place and no query.
 *
 * The source is a snapshot. The feed holds each update of each event that has not ended. The fetch puts the updates of
 * one key of a service into one event. A new update gives a new body, and the old body leaves the list. An event that
 * ends leaves the feed, and thus the list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import { readHttpTime } from "@mark1russell7/optional/read";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { AWS_BASE, AWS_SOURCE, FEED_PATH, guidOf } from "./feed.ts";

/** The longest time of one request when the source gives none, in milliseconds. */
export const FEED_TIMEOUT_MS = 30_000;

/** The media type of each observation: the fetch gives each event as JSON. */
export const EVENT_CONTENT_TYPE = "application/json";

/** The options of the fetch function of the feed. */
export interface AwsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `FEED_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface AwsFetchInput {
  readonly watch: Watch;
}

/** The events of one feed. */
export interface Events {
  /** The body of each event, the newest event first. An item with no key of a service gives its own body, with no key. */
  readonly bodies: readonly string[];
  /** True: each item has a key of a service and a time. */
  readonly complete: boolean;
}

/** One item of the feed, with its key of a service and its time. */
interface Item {
  readonly entry: FeedEntry;
  readonly seconds: number;
  readonly time: Instant;
}

/** This function gives the time of an item: its `pubDate`, else the time in its `guid`. */
function timeOf(entry: FeedEntry, seconds: number): Instant {
  return readHttpTime(entry.updated) ?? seconds * 1000;
}

/** This function gives the body of one event: the newest update in full, and the time and the title of each earlier update. */
function eventBody(key: string, items: readonly Item[]): string {
  const [latest, ...earlier] = [...items].sort((a, b) => b.time - a.time || b.seconds - a.seconds);
  const first = Math.min(...items.map((item) => item.seconds));
  return JSON.stringify({
    key: `${key}_${String(first)}`,
    service: key,
    ...(latest!.entry.link === undefined ? {} : { link: latest!.entry.link }),
    latest: { time: new Date(latest!.time).toISOString(), title: latest!.entry.title, description: latest!.entry.summary },
    earlier: earlier.map((item) => ({ time: new Date(item.time).toISOString(), title: item.entry.title })),
  });
}

/**
 * This function puts the items of a feed into events: one event for each key of a service. Two equal `guid` values give
 * one item. An item with no key gives its own body with no key, and `complete` false. Then the map tells of the change.
 */
export function eventBodies(entries: readonly FeedEntry[]): Events {
  const groups = new Map<string, Item[]>();
  const seen = new Set<string>();
  const loose: string[] = [];
  for (const entry of entries) {
    const guid = guidOf(entry.id);
    if (guid === undefined) {
      loose.push(JSON.stringify(entry));
      continue;
    }
    if (seen.has(entry.id!)) continue;
    seen.add(entry.id!);
    const items = groups.get(guid.key) ?? [];
    items.push({ entry, seconds: guid.seconds, time: timeOf(entry, guid.seconds) });
    groups.set(guid.key, items);
  }
  const newest = (items: readonly Item[]) => Math.max(...items.map((item) => item.time));
  const events = [...groups.entries()].sort(([a, one], [b, two]) => newest(two) - newest(one) || a.localeCompare(b)).map(([key, items]) => eventBody(key, items));
  return { bodies: [...events, ...loose], complete: loose.length === 0 };
}

/**
 * This function makes the fetch function of the feed. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) with the `ETag` of the last full answer. A 304 answer has
 * no body. Then the fetch gives the events of the last full answer again. The time of the data is the `Last-Modified`
 * date of the last full answer.
 */
export function createAwsFetch(options: AwsFetchOptions): (input: AwsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: AWS_SOURCE,
    pace: options.pace,
    transport: options.transport,
    baseUrl: AWS_BASE,
    headers: { accept: "application/rss+xml, application/xml;q=0.9", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly events: Events; readonly asOf?: Instant } | undefined;

  const outcomeOf = (url: string, status: number, full: NonNullable<typeof last>, latency: number): FetchOutcome => {
    const fetched = now();
    const transport = { url, status, latency };
    const observations: Observation[] = full.events.bodies.map((body) => ({
      id: observationId({ source: AWS_SOURCE, contentType: EVENT_CONTENT_TYPE, url: `${requester.baseUrl}${FEED_PATH}`, body }),
      source: AWS_SOURCE,
      fetched,
      contentType: EVENT_CONTENT_TYPE,
      body,
      transport,
    }));
    return { ok: true, observations, complete: full.events.complete, ...(full.asOf === undefined ? {} : { asOf: full.asOf }) };
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: FEED_PATH, what: "the RSS feed of the AWS Health Dashboard", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      return outcomeOf(url, 304, last, latency);
    }
    const read = readFeed(answer.reply.body);
    if (!read.ok) {
      // poll keeps the condition of each 2xx answer. A bad body must not be the base of a later 304.
      conditions.delete(url);
      last = undefined;
      return { ok: false, failure: read.malformed ? { kind: "network", message: `truncated or malformed body: ${url}` } : { kind: "server", message: `the answer is not the RSS feed of the AWS Health Dashboard (${read.reason}): ${url}` } };
    }
    const events = eventBodies(read.entries);
    const lossy = read.problems.some((problem) => problem.lossy === true);
    const modified = readHttpTime(answer.reply.headers["last-modified"]);
    last = { url, events: lossy ? { ...events, complete: false } : events, ...(modified === undefined ? {} : { asOf: modified }) };
    return outcomeOf(url, answer.reply.status, last, latency);
  };
}
