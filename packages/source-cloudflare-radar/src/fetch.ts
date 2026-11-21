/**
 * The fetch function of a list of Cloudflare Radar. Each fetch is one GET through polite-crawler. The request holds the
 * token in the header `authorization`, and no place.
 *
 * The source is a snapshot. The list of the last day holds each record whose time overlaps the day. The fetch gives one
 * body for each record with no end, or with an end after the time of the fetch. A record that ends leaves the list.
 */

import { observationId, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type SourceId, type Watch } from "@mark1russell7/alerts";
import { createRequester, type Requested } from "@mark1russell7/alerts-fetch";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import type { Pace, Transport } from "polite-crawler/api";

import { ANOMALIES_PATH, ANOMALIES_SOURCE, OUTAGES_PATH, OUTAGES_SOURCE, PAGE_LIMIT, RADAR_BASE } from "./feed.ts";

/** The longest time of one request when the source gives none, in milliseconds. */
export const RADAR_TIMEOUT_MS = 30_000;

/** The media type of each observation: the fetch gives each record as JSON. */
export const RECORD_CONTENT_TYPE = "application/json";

/**
 * The error codes of the API that tell of the token. The code 9106 tells of no token or a token with a bad form, and the
 * code 10000 tells of an unknown token.
 */
export const AUTH_ERROR_CODES: readonly number[] = [9106, 10000];

/** The two lists of Cloudflare Radar. */
export type RadarList = "outages" | "anomalies";

/** The facts of one list. */
export interface RadarListFacts {
  /** The id of the source of the list. */
  readonly source: SourceId;
  /** The path of the list of the last day. */
  readonly path: string;
  /** The field of the list in the field `result` of an answer. */
  readonly field: string;
  /** The field of the id of a record. */
  readonly id: string;
  /** The words of the list in a message of polite-crawler. */
  readonly what: string;
}

/** The facts of each list. */
export const RADAR_LISTS: Readonly<Record<RadarList, RadarListFacts>> = {
  outages: { source: OUTAGES_SOURCE, path: OUTAGES_PATH, field: "annotations", id: "id", what: "the outages of Cloudflare Radar" },
  anomalies: { source: ANOMALIES_SOURCE, path: ANOMALIES_PATH, field: "trafficAnomalies", id: "uuid", what: "the traffic anomalies of Cloudflare Radar" },
};

/** The options of the fetch function of a list. */
export interface RadarFetchOptions {
  /** The list of the source. */
  readonly list: RadarList;
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The API token of Cloudflare, with the permission to read Radar. It goes only into the header `authorization`. */
  readonly token: string;
  /** The base URL. The default is `RADAR_BASE`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `RADAR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface RadarFetchInput {
  readonly watch: Watch;
}

/** One error of an answer of the API. */
interface ApiError {
  readonly code?: number;
  readonly message: string;
}

/** This function gives the errors of an answer of the API. A body that is not JSON gives no error. */
function errorsOf(body: string): readonly ApiError[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const errors = isRecord(parsed) && Array.isArray(parsed["errors"]) ? (parsed["errors"] as unknown[]) : [];
  return errors.flatMap((error) => {
    if (!isRecord(error) || typeof error["message"] !== "string") return [];
    return [typeof error["code"] === "number" ? { code: error["code"], message: error["message"] } : { message: error["message"] }];
  });
}

/**
 * This function gives the problem text of an answer that is not a success: each error with its code, for example
 * `10000 Authentication error`. The requester removes the token from each message.
 */
export function errorsDetail(body: string): string | undefined {
  const errors = errorsOf(body);
  return errors.length === 0 ? undefined : errors.map((error) => (error.code === undefined ? error.message : `${error.code} ${error.message}`)).join("; ");
}

/**
 * This function gives the failure of a request. An error code of `AUTH_ERROR_CODES` makes it the failure `auth`. The API
 * answers 400 to a request with no token, and the requester reads a 400 as a refusal.
 */
export function failureOfRequest(requested: Extract<Requested, { ok: false }>): FetchFailure {
  const codes = requested.answer === undefined ? [] : errorsOf(requested.answer.reply.body).map((error) => error.code);
  return codes.some((code) => code !== undefined && AUTH_ERROR_CODES.includes(code)) ? { kind: "auth", message: requested.failure.message } : requested.failure;
}

/**
 * This function tells if a record is live at the time `now`: its end is `null` or absent, or its end is after `now`. An
 * end that is not a time keeps the record, and the map tells of the change.
 */
export function isLive(record: Fields, now: Instant): boolean {
  const end = record["endDate"];
  if (end === null || end === undefined) return true;
  const time = typeof end === "string" ? Date.parse(end) : Number.NaN;
  return Number.isFinite(time) ? time > now : true;
}

/** This function tells if a body is JSON. */
function parses(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/** The records of one answer. */
export interface Records {
  /** The body of each live record, in the order of the list. A record with no id gives its own body. */
  readonly bodies: readonly string[];
  /** True: each record has an id, and the list is shorter than one page. */
  readonly complete: boolean;
}

/** This function gives the id of a record as text, or `undefined` for a record with no id. */
function idOf(record: Fields, field: string): string | undefined {
  const id = record[field];
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

/**
 * This function reads the records of one answer. The body of a live record is its JSON text with no change. Two records
 * with one id give one body, the first. An answer that is not a list of the API gives `undefined`.
 */
export function readRecords(list: RadarList, body: string, now: Instant): Records | undefined {
  const facts = RADAR_LISTS[list];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["success"] !== true || !isRecord(parsed["result"])) return undefined;
  const records = parsed["result"][facts.field];
  if (!Array.isArray(records)) return undefined;
  const seen = new Set<string>();
  const bodies: string[] = [];
  let complete = records.length < PAGE_LIMIT;
  for (const record of records as unknown[]) {
    const id = isRecord(record) ? idOf(record, facts.id) : undefined;
    if (!isRecord(record) || id === undefined) {
      bodies.push(JSON.stringify(record));
      complete = false;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (isLive(record, now)) bodies.push(JSON.stringify(record));
  }
  return { bodies, complete };
}

/**
 * This function makes the fetch function of a list. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * The API sends no `ETag`, so each answer is a full answer. A cache keeps each answer for some minutes. The time of the
 * data is the `Last-Modified` date of the answer.
 */
export function createRadarFetch(options: RadarFetchOptions): (input: RadarFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const facts = RADAR_LISTS[options.list];
  const requester = createRequester({
    source: facts.source,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? RADAR_BASE,
    headers: { accept: "application/json", authorization: `Bearer ${options.token}`, "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? RADAR_TIMEOUT_MS,
    detail: errorsDetail,
    secrets: [options.token],
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;

  return async (_input, signal) => {
    const requested = await requester.get({ path: facts.path, what: facts.what }, signal);
    if (!requested.ok) return { ok: false, failure: failureOfRequest(requested) };
    const { url, answer, latency } = requested;
    const fetched = now();
    const read = readRecords(options.list, answer.reply.body, fetched);
    if (read === undefined) {
      // A body that does not parse is a cut answer. A body that parses is an answer of a different form.
      const failure: FetchFailure = parses(answer.reply.body) ? { kind: "server", message: `the answer is not the list of ${facts.what}: ${url}` } : { kind: "network", message: `truncated or malformed body: ${url}` };
      return { ok: false, failure };
    }
    const transport = { url, status: answer.reply.status, latency };
    const observations: Observation[] = read.bodies.map((body) => ({
      id: observationId({ source: facts.source, contentType: RECORD_CONTENT_TYPE, url, body }),
      source: facts.source,
      fetched,
      contentType: RECORD_CONTENT_TYPE,
      body,
      transport,
    }));
    const modified = Date.parse(answer.reply.headers["last-modified"] ?? "");
    return { ok: true, observations, complete: read.complete, ...(read.complete && Number.isFinite(modified) ? { asOf: modified } : {}) };
  };
}
