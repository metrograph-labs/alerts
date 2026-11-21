/**
 * The fetch function of the SWPC source. It asks `services.swpc.noaa.gov` for the product list `alerts.json`, through
 * polite-crawler. The list holds the messages of approximately the past 30 days, newest first. The file is a fixed URL, so a
 * request names no place of the watch.
 *
 * The source is a stream: a message stays in the list after it ends, and it leaves the list after approximately 30 days. The
 * runtime keeps the ids of the observations that it knows, so each fetch gives the whole list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord } from "@mark1russell7/optional/read";
import type { Condition, Pace, Reply, Transport } from "polite-crawler/api";

import { ENTRY_FIELDS, entryTime, SOURCE_ID } from "./map.ts";

/** The base URL of the data services of the SWPC. */
export const SWPC_BASE_URL = "https://services.swpc.noaa.gov";

/** The path of the product list of the alerts, the watches, the warnings and the summaries. */
export const ALERTS_PATH = "/products/alerts.json";

/** The options of the fetch function of the SWPC source. */
export interface SwpcFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `SWPC_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface SwpcFetchInput {
  readonly watch: Watch;
}

/** The tests of the fields of an entry: the structure that the fetch examines. */
const FIELD_TYPES: Readonly<Record<(typeof ENTRY_FIELDS)[number], (value: unknown) => boolean>> = {
  product_id: (value) => typeof value === "string",
  issue_datetime: (value) => entryTime(value) !== undefined,
  message: (value) => typeof value === "string" && value.length > 0,
};

/** This function tells if an entry has the structure of the list: each field of `ENTRY_FIELDS` with its type. */
export function isSwpcEntry(entry: unknown): boolean {
  return isRecord(entry) && ENTRY_FIELDS.every((field) => FIELD_TYPES[field](entry[field]));
}

/**
 * This function gives the body of the observation of one entry: the JSON text of the fields of `ENTRY_FIELDS`, in
 * that order. A field that the entry does not have is absent. A value that is not an object gives its own JSON text,
 * and the map tells of the change.
 */
export function entryBody(entry: unknown): string {
  if (!isRecord(entry)) return JSON.stringify(entry);
  const kept: Record<string, unknown> = {};
  for (const field of ENTRY_FIELDS) if (entry[field] !== undefined) kept[field] = entry[field];
  return JSON.stringify(kept);
}

/** The observations of one answer. The value `complete` is true if each entry has the structure of the list. */
export interface Read {
  readonly observations: readonly Observation[];
  readonly complete: boolean;
}

/**
 * This function splits an answer into observations: one for each entry of the list, in the order of the list. One
 * body twice gives one observation. A JSON body that is not a list gives one observation of the whole body. Then the
 * answer is not complete, and the map tells of the change. A body that does not parse gives `undefined`.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/json";
  const transport = { url, status: reply.status, latency };
  const observation = (body: string): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType, url, body }),
    source: SOURCE_ID,
    fetched,
    contentType,
    body,
    transport,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return { observations: [observation(reply.body)], complete: false };
  const bodies = new Set(parsed.map(entryBody));
  return { observations: [...bodies].map(observation), complete: parsed.every(isSwpcEntry) };
}

/**
 * This function makes the fetch function of the SWPC source. The fetch does not throw for a failure of the source:
 * it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the list, with the validators of the last full
 * answer. A 304 answer tells that the list did not change, so the fetch gives no observation. A full answer gives
 * one observation for each entry. The fetch gives no cursor.
 *
 * A cut with no framing can look whole to the HTTP client. A cut list does not parse, so it fails the fetch.
 */
export function createSwpcFetch(options: SwpcFetchOptions): (input: SwpcFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? SWPC_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let answered = false;

  return async (_input, signal) => {
    const requested = await requester.get({ path: ALERTS_PATH, what: "the space weather messages of the past 30 days", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (answered) return { ok: true, observations: [], complete: true };
      // A 304 with no earlier full answer: the next request sends no condition
      conditions.delete(url);
      return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
    }
    const read = readAnswer(answer.reply, url, now(), latency);
    if (read === undefined) {
      // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
      conditions.delete(url);
      answered = false;
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    answered = true;
    return { ok: true, observations: read.observations, complete: read.complete };
  };
}
