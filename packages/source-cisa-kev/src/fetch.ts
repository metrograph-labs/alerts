/**
 * The fetch function of the CISA KEV source. It reads the JSON file of the catalog of known exploited vulnerabilities
 * through polite-crawler. The file holds each entry since 2021, and CISA adds entries on most work days. The request
 * holds no place and no query.
 *
 * The source is a snapshot. Each fetch gives the entries whose due date has not ended, and the head of the catalog. An
 * entry leaves the list at the end of its due date, or when CISA removes it. A changed entry gives a new body, and the
 * old body leaves the list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, timeOf, type Fields } from "@mark1russell7/optional/read";
import type { Condition, Pace, Reply, Transport } from "polite-crawler/api";

import { dueEnd, ENTRY_FIELDS, HEAD_FIELDS, isKevEntry, SOURCE_ID } from "./map.ts";

/** The base URL of the site of CISA. */
export const KEV_BASE_URL = "https://www.cisa.gov";

/** The path of the JSON file of the catalog. */
export const CATALOG_PATH = "/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** The longest time of one request when the source gives none, in milliseconds. The file is 1.9 MB before compression. */
export const KEV_TIMEOUT_MS = 30_000;

/** The options of the fetch function of the CISA KEV source. */
export interface KevFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `KEV_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `KEV_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface KevFetchInput {
  readonly watch: Watch;
}

/** This function gives the JSON text of the fields of `fields` that `order` names, in that order. */
function bodyOf(value: Fields, order: readonly string[]): string {
  const body: Record<string, unknown> = {};
  for (const field of order) if (value[field] !== undefined) body[field] = value[field];
  return JSON.stringify(body);
}

/** This function gives the body of the observation of one entry: the JSON text of the fields of `ENTRY_FIELDS`, in that order. */
export function entryBody(entry: Fields): string {
  return bodyOf(entry, ENTRY_FIELDS);
}

/** One body of the list, and the time at which it leaves the list. */
export interface Listed {
  readonly body: string;
  /** The end of the due date of the entry. An entry that is not valid has no end: it stays in the list. */
  readonly until?: Instant;
}

/** The parts of one answer that the fetch keeps until the next answer. */
export interface Catalog {
  /** The body of the head of the catalog. */
  readonly head: string;
  /** The entries whose due date had not ended at the fetch, and each entry that is not valid. */
  readonly listed: readonly Listed[];
  /** True: the answer has the structure of the catalog, its count is its count of entries, and each entry is valid. */
  readonly complete: boolean;
  /** The time of the release of the catalog, from its field `dateReleased`. */
  readonly asOf?: Instant;
}

/**
 * This function reads the catalog of one answer at the time `fetched`. An answer that is not the catalog gives a
 * catalog with no entries, its whole body as the head, and `complete` false. Then the map tells of the change. A body
 * that does not parse gives `undefined`.
 */
export function readCatalog(body: string, fetched: Instant): Catalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const entries = isRecord(parsed) && Array.isArray(parsed["vulnerabilities"]) ? (parsed["vulnerabilities"] as unknown[]) : undefined;
  if (!isRecord(parsed) || entries === undefined || typeof parsed["catalogVersion"] !== "string") return { head: body, listed: [], complete: false };
  const listed: Listed[] = [];
  let valid = 0;
  for (const entry of entries) {
    if (isRecord(entry) && isKevEntry(entry)) {
      valid += 1;
      const until = dueEnd(entry["dueDate"])!;
      if (until > fetched) listed.push({ body: entryBody(entry), until });
    } else listed.push({ body: isRecord(entry) ? entryBody(entry) : JSON.stringify(entry) });
  }
  const released = timeOf(parsed, "dateReleased");
  const complete = valid === entries.length && parsed["count"] === entries.length && released !== undefined;
  return { head: bodyOf(parsed, HEAD_FIELDS), listed, complete, ...(released === undefined ? {} : { asOf: released }) };
}

/** This function gives the bodies of a catalog that are in the list at the time `now`, with no body twice. */
export function listedAt(catalog: Catalog, now: Instant): string[] {
  return [...new Set([catalog.head, ...catalog.listed.filter(({ until }) => until === undefined || until > now).map(({ body }) => body)])];
}

/**
 * This function makes the fetch function of the CISA KEV source. The fetch does not throw for a failure of the source:
 * it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the file, with the `ETag` of the last full answer.
 * A 304 answer has no body. Then the fetch gives the list of the last full answer again, less the entries whose due
 * date ended since. The fetch gives no cursor, and the time of the data is the release of the catalog.
 */
export function createKevFetch(options: KevFetchOptions): (input: KevFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? KEV_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? KEV_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly catalog: Catalog; readonly contentType: string } | undefined;

  const observationsOf = (reply: Reply | undefined, url: string, contentType: string, catalog: Catalog, latency: number): Observation[] => {
    const fetched = now();
    const transport = { url, status: reply?.status ?? 304, latency };
    return listedAt(catalog, fetched).map((body) => ({
      id: observationId({ source: SOURCE_ID, contentType, url: `${requester.baseUrl}${CATALOG_PATH}`, body }),
      source: SOURCE_ID,
      fetched,
      contentType,
      body,
      transport,
    }));
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: CATALOG_PATH, what: "the catalog of known exploited vulnerabilities", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      const { catalog, contentType } = last;
      return { ok: true, observations: observationsOf(undefined, url, contentType, catalog, latency), complete: catalog.complete, ...(catalog.asOf === undefined ? {} : { asOf: catalog.asOf }) };
    }
    const catalog = readCatalog(answer.reply.body, now());
    if (catalog === undefined) {
      // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
      conditions.delete(url);
      last = undefined;
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    const contentType = answer.reply.headers["content-type"] ?? "application/json";
    last = { url, catalog, contentType };
    return { ok: true, observations: observationsOf(answer.reply, url, contentType, catalog, latency), complete: catalog.complete, ...(catalog.asOf === undefined ? {} : { asOf: catalog.asOf }) };
  };
}

/** This function gives the time of the release of the catalog from the body of its head, or `undefined`. */
export function releasedOf(head: string): Instant | undefined {
  try {
    const fields: unknown = JSON.parse(head);
    return isRecord(fields) ? timeOf(fields, "dateReleased") : undefined;
  } catch {
    return undefined;
  }
}
