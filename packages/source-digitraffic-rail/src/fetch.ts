/**
 * The fetch function of the Digitraffic rail source. Each fetch is one GraphQL query of the open rail API of Digitraffic
 * (`rata.digitraffic.fi`) through polite-crawler. The query asks for the trains that run at this time, each with its last
 * stop that has an actual time. It also asks for the cancelled trains of the day in Finland. The request holds no place of
 * the watch.
 *
 * The fetch counts the trains of each passenger category, and it gives the counts as one observation. The id of an
 * observation has the URL and the counts. Thus two fetches with the same counts give one observation, and the runtime keeps
 * it one time. The answer of the query is approximately 50 kB. The log keeps only the counts.
 */

import { localTime } from "@mark1russell7/algebra/clock";
import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord } from "@mark1russell7/optional/read";
import type { Pace, Transport } from "polite-crawler/api";

import { MEASURE_IDS, railBody, SERIES_CATEGORIES, SERIES_IDS, SOURCE_ID, type SeriesCounts, type SeriesId } from "./map.ts";

/** The base URL of the rail API of Digitraffic. */
export const RAIL_BASE_URL = "https://rata.digitraffic.fi";

/** The path of the GraphQL endpoint. */
export const GRAPHQL_PATH = "/api/v2/graphql/graphql";

/** The time zone of the departure dates of the trains. */
export const RAIL_TIME_ZONE = "Europe/Helsinki";

/** The content type of the body of each observation. */
export const BODY_TYPE = "application/json";

/**
 * The shortest time between two requests to the host. The terms of Digitraffic limit the rail API to 30 requests each
 * minute from one address. The source sends one request each 5 minutes.
 */
export const MIN_INTERVAL_MS = 60_000;

/** The longest time of one request. A read on 2026-11-25 took less than 1 second. */
export const TIMEOUT_MS = 30_000;

/**
 * The delay in minutes at which a running train is late. The punctuality figures of Finland count a long-distance train
 * that is 5 minutes late or more as late. The source uses the same limit for each category.
 */
export const LATE_MINUTES = 5;

/** The longest text of a GraphQL error in a failure. */
const MAX_ERROR_TEXT = 200;

/** The options of the fetch function of the Digitraffic rail source. */
export interface RailFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. The `Digitraffic-User` header has the same text. */
  readonly userAgent: string;
  /** The base URL. The default is `RAIL_BASE_URL`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface RailFetchInput {
  readonly watch: Watch;
}

/** This function gives the departure date in Finland at an instant, as `YYYY-MM-DD`, or `undefined` for a bad instant. */
export function departureDate(at: Instant): string | undefined {
  const local = Number.isFinite(at) ? localTime(at, RAIL_TIME_ZONE) : undefined;
  if (local === undefined) return undefined;
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${String(local.year)}-${two(local.month)}-${two(local.day)}`;
}

/**
 * This function gives the GraphQL query of one fetch, for the departure date `date` (`YYYY-MM-DD`). For each running
 * train, the query asks for one stop: the stop with the newest actual time. A read on 2026-11-25 gave this stop for 132 of
 * 133 trains. The other train had two stops with the same actual time.
 */
export function railQuery(date: string): string {
  return [
    "{",
    "running: currentlyRunningTrains {",
    "trainType { trainCategory { name } }",
    // The API ignores a filter of the stops. The order by the actual time puts the stops with no actual time last.
    "timeTableRows(orderBy: {actualTime: DESCENDING}, take: 1) { differenceInMinutes actualTime }",
    "}",
    `cancelled: trainsByDepartureDate(departureDate: "${date}", where: {cancelled: {equals: true}}) {`,
    "trainType { trainCategory { name } }",
    "}",
    "}",
  ].join(" ");
}

/** The counts of one answer of the query. */
export interface RailCounts {
  /** The newest actual time of a running train, or `undefined` when no running train has one. */
  readonly newest: Instant | undefined;
  /** The count of the running trains of all categories. */
  readonly trains: number;
  readonly series: Readonly<Record<SeriesId, SeriesCounts>>;
}

/** The result of `readAnswer`: the counts of the answer, or the reason of an answer that is not an answer of the query. */
export type AnswerRead = { readonly ok: true; readonly counts: RailCounts } | { readonly ok: false; readonly reason: string };

/** This function gives the category name of a train of the answer, or `undefined` for a train with no category. */
function categoryOf(train: unknown): string | undefined {
  if (!isRecord(train) || !isRecord(train["trainType"]) || !isRecord(train["trainType"]["trainCategory"])) return undefined;
  const name = train["trainType"]["trainCategory"]["name"];
  return typeof name === "string" ? name : undefined;
}

/** This function gives the series of a category name, or `undefined` for a category that is not a passenger category. */
function seriesOf(category: string): SeriesId | undefined {
  return SERIES_IDS.find((id) => SERIES_CATEGORIES[id] === category);
}

/**
 * This function reads the text of an answer of the query. It does not throw. A text that is not JSON, a GraphQL error and
 * a train with no category give a reason. A stop with an actual time that is not a time, or with no delay, also gives a
 * reason.
 */
export function readAnswer(text: string): AnswerRead {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the answer is not JSON" };
  }
  if (!isRecord(answer)) return { ok: false, reason: "the answer is not an object" };
  const errors = answer["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first: unknown = errors[0];
    const message = isRecord(first) && typeof first["message"] === "string" ? first["message"].slice(0, MAX_ERROR_TEXT) : "no message";
    return { ok: false, reason: `the query gave ${String(errors.length)} GraphQL errors, the first: ${message}` };
  }
  const data = answer["data"];
  const running: unknown = isRecord(data) ? data["running"] : undefined;
  const cancelled: unknown = isRecord(data) ? data["cancelled"] : undefined;
  if (!Array.isArray(running) || !Array.isArray(cancelled)) return { ok: false, reason: "the answer has no lists of running and cancelled trains" };
  const series = Object.fromEntries(SERIES_IDS.map((id) => [id, Object.fromEntries(MEASURE_IDS.map((measure) => [measure, 0]))])) as Record<SeriesId, Record<(typeof MEASURE_IDS)[number], number>>;
  let newest: Instant | undefined;
  for (const [index, train] of (running as unknown[]).entries()) {
    const category = categoryOf(train);
    if (category === undefined) return { ok: false, reason: `the running train ${String(index)} has no category` };
    const rows = isRecord(train) ? train["timeTableRows"] : undefined;
    if (!Array.isArray(rows)) return { ok: false, reason: `the running train ${String(index)} has no list of stops` };
    const row: unknown = rows[0];
    let minutes: number | undefined;
    // A train with no stop, or with no actual time at its stop, runs with no known delay.
    if (row !== undefined && !(isRecord(row) && row["actualTime"] === null)) {
      const time = isRecord(row) && typeof row["actualTime"] === "string" ? Date.parse(row["actualTime"]) : Number.NaN;
      const difference = isRecord(row) ? row["differenceInMinutes"] : undefined;
      if (!Number.isFinite(time) || typeof difference !== "number" || !Number.isFinite(difference)) return { ok: false, reason: `the last stop of the running train ${String(index)} has no actual time or no delay` };
      if (newest === undefined || time > newest) newest = time;
      minutes = difference;
    }
    const id = seriesOf(category);
    if (id === undefined) continue;
    series[id].running += 1;
    if (minutes !== undefined && minutes >= LATE_MINUTES) series[id].late += 1;
  }
  for (const [index, train] of (cancelled as unknown[]).entries()) {
    const category = categoryOf(train);
    if (category === undefined) return { ok: false, reason: `the cancelled train ${String(index)} has no category` };
    const id = seriesOf(category);
    if (id !== undefined) series[id].cancelled += 1;
  }
  return { ok: true, counts: { newest, trains: running.length, series } };
}

/**
 * This function makes the fetch function of the Digitraffic rail source. The fetch does not throw for a failure of the
 * source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one POST of the query, with the departure date in Finland at the time of the fetch. A POST has no
 * condition, so each fetch reads the full answer.
 */
export function createRailFetch(options: RailFetchOptions): (input: RailFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? RAIL_BASE_URL,
    // Digitraffic asks each client to name itself in the header `Digitraffic-User`.
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": options.userAgent, "digitraffic-user": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  });
  const now = options.pace.now;
  const endpoint = `${requester.baseUrl}${GRAPHQL_PATH}`;

  return async (_input, signal) => {
    const date = departureDate(now());
    if (date === undefined) return { ok: false, failure: { kind: "network", message: `the clock gives no date in ${RAIL_TIME_ZONE}` } };
    const requested = await requester.get({ path: GRAPHQL_PATH, what: "the running and cancelled trains of Finland", body: JSON.stringify({ query: railQuery(date) }) }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const reply = answer.reply;
    if (reply === undefined) return { ok: false, failure: { kind: "server", message: `the answer has no body: ${endpoint}` } };
    const read = readAnswer(reply.body);
    if (!read.ok) return { ok: false, failure: { kind: "server", message: `the answer is not an answer of the rail query: ${read.reason}: ${endpoint}` } };
    const { counts } = read;
    const body = railBody(counts.newest, date, counts.trains, counts.series);
    const fetched = now();
    const observation: Observation = {
      id: observationId({ source: SOURCE_ID, contentType: BODY_TYPE, url: endpoint, body }),
      source: SOURCE_ID,
      fetched,
      contentType: BODY_TYPE,
      body,
      transport: { url, status: reply.status, latency },
    };
    // The newest actual time of a train is the time of the data. A time after the fetch is a difference of the two clocks.
    return { ok: true, observations: [observation], complete: true, asOf: Math.min(counts.newest ?? fetched, fetched) };
  };
}
