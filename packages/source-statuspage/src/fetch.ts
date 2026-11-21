/**
 * The fetch function of a status page. It reads the summary of the page (`/api/v2/summary.json`) through
 * polite-crawler. Atlassian Statuspage gives this API on each page that it hosts, and incident.io gives the same format.
 * A page of the format `statusiq` gives its RSS feed (`/rss`) in place of the summary. The request holds no place and no
 * query.
 *
 * The page documents the API for programs. Its `robots.txt` file stops crawlers under `/api/`. This source is not a
 * crawler: it asks for one documented file, at most one time in each interval of the page. A page of StatusIQ links its
 * feed for its subscribers, and the host of the feed had no `robots.txt` file.
 *
 * The source is a snapshot. Each fetch gives the incidents that are not resolved, and the head of the page. A resolved
 * incident leaves the list. A new update gives a new body, and the old body leaves the list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, timeOf, type Fields } from "@mark1russell7/optional/read";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { COMPONENT_FIELDS, INCIDENT_FIELDS, isIncident, PAGE_FIELDS, UPDATE_FIELDS } from "./map.ts";
import type { PageFormat, StatusPage } from "./page.ts";
import { readComponents, STATUSIQ_PATH } from "./statusiq.ts";

/** The path of the summary of a page. */
export const SUMMARY_PATH = "/api/v2/summary.json";

/** The longest time of one request when the source gives none, in milliseconds. */
export const SUMMARY_TIMEOUT_MS = 30_000;

/** The fields of the status of a page in the body of the head, in this order. */
export const STATUS_FIELDS = ["indicator", "description"] as const;

/** The options of the fetch function of a status page. */
export interface StatusPageFetchOptions {
  /** The config of the page. */
  readonly page: StatusPage;
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `SUMMARY_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface StatusPageFetchInput {
  readonly watch: Watch;
}

/** This function gives the fields of `value` that `order` names, in that order. */
function pick(value: Fields, order: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of order) if (value[field] !== undefined) picked[field] = value[field];
  return picked;
}

/** This function gives the listed values of a field, each with only the fields of `order`. */
function pickEach(value: unknown, order: readonly string[]): unknown {
  return Array.isArray(value) ? value.map((each) => (isRecord(each) ? pick(each, order) : each)) : value;
}

/**
 * This function gives the body of the observation of one incident: the JSON text of the fields of `INCIDENT_FIELDS`, in
 * that order. Each component keeps the fields of `COMPONENT_FIELDS`, and each update the fields of `UPDATE_FIELDS`.
 */
export function incidentBody(incident: Fields): string {
  const body = pick(incident, INCIDENT_FIELDS);
  if (body["components"] !== undefined) body["components"] = pickEach(body["components"], COMPONENT_FIELDS);
  if (body["incident_updates"] !== undefined) body["incident_updates"] = pickEach(body["incident_updates"], UPDATE_FIELDS);
  return JSON.stringify(body);
}

/** The parts of one answer that the fetch keeps until the next answer. */
export interface Summary {
  /** The body of the head of the page. */
  readonly head: string;
  /** The body of each incident that is not resolved. */
  readonly incidents: readonly string[];
  /** True: the answer has the structure of a summary, and each incident is valid. */
  readonly complete: boolean;
  /** The time of the last change of the page, from its field `updated_at`. */
  readonly asOf?: Instant;
}

/**
 * This function reads the summary of one answer. An answer that is not a summary gives a summary with no incidents, its
 * whole body as the head, and `complete` false. Then the map tells of the change. A body that does not parse gives
 * `undefined`.
 */
export function readSummary(body: string): Summary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const page = isRecord(parsed) ? parsed["page"] : undefined;
  const incidents = isRecord(parsed) ? parsed["incidents"] : undefined;
  if (!isRecord(parsed) || !isRecord(page) || typeof page["id"] !== "string" || !Array.isArray(incidents)) return { head: body, incidents: [], complete: false };
  const status = isRecord(parsed["status"]) ? pick(parsed["status"], STATUS_FIELDS) : parsed["status"];
  const head = JSON.stringify({ page: pick(page, PAGE_FIELDS), ...(status === undefined ? {} : { status }) });
  const updated = timeOf(page, "updated_at");
  return {
    head,
    incidents: [...new Set(incidents.map((incident) => (isRecord(incident) ? incidentBody(incident) : JSON.stringify(incident))))],
    complete: incidents.every((incident) => isRecord(incident) && isIncident(incident)),
    ...(updated === undefined ? {} : { asOf: updated }),
  };
}

/** The request of one format of a page, and the reader of its answer. */
interface FormatRequest {
  /** The path of the file that the fetch asks for. */
  readonly path: string;
  /** The `Accept` header of the request. */
  readonly accept: string;
  /** The words of the request in a failure text. */
  readonly what: string;
  /** The reader of a full answer. */
  readonly read: (body: string) => Summary | undefined;
  /** The media type of each body that the fetch makes, when it is not the type of the answer. */
  readonly bodyType?: string;
}

/** The request of each format. A body of a component of StatusIQ is JSON that the fetch makes from one item of the feed. */
const FORMATS: Readonly<Record<PageFormat, FormatRequest>> = {
  statuspage: { path: SUMMARY_PATH, accept: "application/json", what: "the summary of the status page", read: readSummary },
  statusiq: { path: STATUSIQ_PATH, accept: "application/rss+xml, application/xml;q=0.9", what: "the RSS feed of the status page", read: readComponents, bodyType: "application/json" },
};

/** This function gives the path of the file that the fetch of a page asks for: the summary, or the feed of StatusIQ. */
export function pagePath(page: Pick<StatusPage, "format">): string {
  return FORMATS[page.format ?? "statuspage"].path;
}

/**
 * This function makes the fetch function of a status page. The fetch does not throw for a failure of the source: it
 * gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the file of the format, with the `ETag` of the last full answer.
 * A 304 answer has no body. Then the fetch gives the list of the last full answer again. The fetch gives no cursor, and
 * the time of the data is the last change of the page.
 */
export function createStatusPageFetch(options: StatusPageFetchOptions): (input: StatusPageFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const { page } = options;
  const format = FORMATS[page.format ?? "statuspage"];
  const requester = createRequester({
    source: page.id,
    pace: options.pace,
    transport: options.transport,
    baseUrl: page.base,
    headers: { accept: format.accept, "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly summary: Summary; readonly contentType: string } | undefined;

  const outcomeOf = (url: string, status: number, contentType: string, summary: Summary, latency: number): FetchOutcome => {
    const fetched = now();
    const transport = { url, status, latency };
    const observations: Observation[] = [summary.head, ...summary.incidents].map((body) => ({
      id: observationId({ source: page.id, contentType, url: `${requester.baseUrl}${format.path}`, body }),
      source: page.id,
      fetched,
      contentType,
      body,
      transport,
    }));
    return { ok: true, observations, complete: summary.complete, ...(summary.asOf === undefined ? {} : { asOf: summary.asOf }) };
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: format.path, what: format.what, conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      return outcomeOf(url, 304, last.contentType, last.summary, latency);
    }
    const summary = format.read(answer.reply.body);
    if (summary === undefined) {
      // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
      conditions.delete(url);
      last = undefined;
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    const contentType = format.bodyType ?? answer.reply.headers["content-type"] ?? "application/json";
    last = { url, summary, contentType };
    return outcomeOf(url, answer.reply.status, contentType, summary, latency);
  };
}
