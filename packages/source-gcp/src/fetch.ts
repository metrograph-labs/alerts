/**
 * The fetch function of the dashboards of Google. It reads the history of the incidents of one dashboard
 * (`/incidents.json`) through polite-crawler. The request holds no place and no query.
 *
 * The source is a snapshot. The file holds each incident of some months, and an incident that has ended has the field
 * `end`. Each fetch gives the incidents that have not ended. An incident that ends leaves the list. A new update gives a
 * new body, and the old body leaves the list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, readHttpTime, timeOf, type Fields } from "@mark1russell7/optional/read";
import { keptReplies, type Condition, type Pace, type Transport } from "polite-crawler/api";

import { GCP_DASHBOARD, INCIDENTS_PATH, type GoogleDashboard } from "./feed.ts";
import { HISTORY_FIELDS, INCIDENT_FIELDS, isIncident, ITEM_FIELDS, UPDATE_FIELDS } from "./map.ts";

/** The longest time of one request when the source gives none, in milliseconds. */
export const INCIDENTS_TIMEOUT_MS = 30_000;

/** The options of the fetch function of the feed. */
export interface GcpFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `INCIDENTS_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The dashboard. The default is the dashboard of Google Cloud (`GCP_DASHBOARD`). */
  readonly dashboard?: GoogleDashboard;
}

/** The input of the fetch function, as the contract gives it. */
export interface GcpFetchInput {
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
 * that order. The most recent update keeps its text. Each earlier update keeps only its time and its status.
 */
export function incidentBody(incident: Fields): string {
  const body = pick(incident, INCIDENT_FIELDS);
  for (const field of ["affected_products", "currently_affected_locations", "previously_affected_locations"]) {
    if (body[field] !== undefined) body[field] = pickEach(body[field], ITEM_FIELDS);
  }
  if (isRecord(body["most_recent_update"])) {
    const latest = pick(body["most_recent_update"], UPDATE_FIELDS);
    if (latest["affected_locations"] !== undefined) latest["affected_locations"] = pickEach(latest["affected_locations"], ITEM_FIELDS);
    body["most_recent_update"] = latest;
  }
  if (body["updates"] !== undefined) body["updates"] = pickEach(body["updates"], HISTORY_FIELDS);
  return JSON.stringify(body);
}

/**
 * This function tells if an incident is live at the time `now`: it has no end, or its end is after `now`. An entry that
 * is not an object is live, so the map tells of the change of the format.
 */
export function isLive(incident: unknown, now: Instant): boolean {
  if (!isRecord(incident)) return true;
  const end = timeOf(incident, "end");
  return end === undefined ? incident["end"] === undefined || incident["end"] === null || incident["end"] === "" : end > now;
}

/** The incidents of one answer. */
export interface Incidents {
  /** The body of each incident that has not ended, or the whole body of an answer that is not a list. */
  readonly bodies: readonly string[];
  /** True: the answer is a list, and each incident that has not ended is valid. */
  readonly complete: boolean;
}

/**
 * This function reads the incidents of one answer at the time `now`. An answer that is not a list gives its whole body
 * as one body, and `complete` false. Then the map tells of the change. A body that does not parse gives `undefined`.
 */
export function readIncidents(body: string, now: Instant): Incidents | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return { bodies: [body], complete: false };
  const live = parsed.filter((incident) => isLive(incident, now));
  return {
    bodies: [...new Set(live.map((incident) => (isRecord(incident) ? incidentBody(incident) : JSON.stringify(incident))))],
    complete: live.every((incident) => isRecord(incident) && isIncident(incident)),
  };
}

// The last full answer: its body, its content type and its `Last-Modified` time.
interface Full {
  readonly body: string;
  readonly contentType: string;
  readonly asOf?: Instant;
}

/**
 * This function makes the fetch function of the feed. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) with the `Last-Modified` date of the last full answer.
 * A 304 answer has no body. The fetch keeps the last full answer as compressed bytes (`keptReplies` of
 * `polite-crawler/api`). After a 304, it reads that answer again at the time of the fetch. Thus an incident
 * whose end time passes leaves the list. The time of the data is the `Last-Modified` date of the last full answer.
 */
export function createGcpFetch(options: GcpFetchOptions): (input: GcpFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const dashboard = options.dashboard ?? GCP_DASHBOARD;
  const requester = createRequester({
    source: dashboard.id,
    pace: options.pace,
    transport: options.transport,
    baseUrl: dashboard.base,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? INCIDENTS_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  const lastAnswer = keptReplies<{ readonly contentType: string; readonly asOf?: Instant }>();
  let keptUrl: string | undefined;

  const outcomeOf = (url: string, status: number, full: Full, latency: number): FetchOutcome => {
    const fetched = now();
    const incidents = readIncidents(full.body, fetched)!;
    const transport = { url, status, latency };
    const observations: Observation[] = incidents.bodies.map((body) => ({
      id: observationId({ source: dashboard.id, contentType: full.contentType, url: `${requester.baseUrl}${INCIDENTS_PATH}`, body }),
      source: dashboard.id,
      fetched,
      contentType: full.contentType,
      body,
      transport,
    }));
    return { ok: true, observations, complete: incidents.complete, ...(full.asOf === undefined ? {} : { asOf: full.asOf }) };
  };

  const forget = (): void => {
    if (keptUrl !== undefined) lastAnswer.delete(keptUrl);
    keptUrl = undefined;
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: INCIDENTS_PATH, what: `the incidents of ${dashboard.sender}`, conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      const previous = keptUrl === url ? await lastAnswer.get(url).catch(() => undefined) : undefined;
      if (previous === undefined) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
      return outcomeOf(url, 304, { body: previous.reply.body, ...previous.extra }, latency);
    }
    if (readIncidents(answer.reply.body, now()) === undefined) {
      // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
      conditions.delete(url);
      forget();
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    const modified = readHttpTime(answer.reply.headers["last-modified"]);
    const extra = { contentType: answer.reply.headers["content-type"] ?? "application/json", ...(modified === undefined ? {} : { asOf: modified }) };
    forget();
    lastAnswer.keep(url, answer.reply, extra);
    keptUrl = url;
    return outcomeOf(url, answer.reply.status, { body: answer.reply.body, ...extra }, latency);
  };
}
