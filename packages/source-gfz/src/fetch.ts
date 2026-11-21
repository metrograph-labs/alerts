/**
 * The fetch function of the GFZ source. It asks the JSON service of GFZ (`kp.gfz.de/app/json/`) for the index Kp of
 * the past 3 days, through polite-crawler. The answer holds one value for each 3-hour interval, and the value of the
 * current interval changes until the interval ends. The query holds only times, so a request names no place of the watch.
 *
 * The source is a snapshot. Each fetch gives the intervals of the past 6 hours: the intervals whose reports are in
 * effect. The older intervals of the answer give the start of the run of each interval.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { geomagneticLevel } from "@mark1russell7/alerts-space-weather";
import { isRecord } from "@mark1russell7/optional/read";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { GFZ_LICENSE, INTERVAL_FIELDS, INTERVAL_MS, intervalStart, intervalText, kpOf, REPORT_LIFE_MS, SOURCE_ID, STATUSES } from "./map.ts";

/** The base URL of the services of the index Kp of GFZ. */
export const GFZ_BASE_URL = "https://kp.gfz.de";

/** The path of the JSON service. */
export const SERIES_PATH = "/app/json/";

/**
 * The count of intervals before the current interval that each query asks for: 3 days. A run that starts before the
 * window gets a later start, and a new incident. The window is twice the run of the storm of May 2024 (36 hours).
 */
export const WINDOW_INTERVALS = 24;

/**
 * The largest time between the starts of two intervals of G1 or more in one run: two intervals. Thus one interval of a
 * lower value does not end a storm. The value is a shortcut with no measure. It ends when a measure of the runs of the
 * series of Kp since 1932 gives the gap (AL-14).
 */
export const RUN_GAP_MS: number = 2 * INTERVAL_MS;

/** The options of the fetch function of the GFZ source. */
export interface GfzFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `GFZ_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface GfzFetchInput {
  readonly watch: Watch;
}

/** This function gives the path of the query at the time `now`: the current interval and the `WINDOW_INTERVALS` intervals before it. */
export function queryPath(now: Instant): string {
  const current = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
  const start = intervalText(current - WINDOW_INTERVALS * INTERVAL_MS);
  const end = intervalText(current + INTERVAL_MS - 1000);
  return `${SERIES_PATH}?start=${start}&end=${end}&index=Kp`;
}

/** One value of the answer, as the columns `datetime`, `Kp` and `status` give it. */
export interface Entry {
  readonly datetime: unknown;
  readonly Kp: unknown;
  readonly status: unknown;
}

/** This function tells if an entry has the structure of the series: the start of an interval, a value of Kp and a known status. */
export function isGfzEntry(entry: Entry): boolean {
  return intervalStart(entry.datetime) !== undefined && kpOf(entry.Kp) !== undefined && typeof entry.status === "string" && Object.hasOwn(STATUSES, entry.status);
}

/** This function gives the body of the observation of one entry: the JSON text of the fields of `INTERVAL_FIELDS`, in that order. */
export function entryBody(entry: Entry, run?: Instant): string {
  const body: Record<string, unknown> = {};
  for (const field of INTERVAL_FIELDS) {
    const value = field === "run" ? (run === undefined ? undefined : intervalText(run)) : entry[field];
    if (value !== undefined) body[field] = value;
  }
  return JSON.stringify(body);
}

/** A valid interval of the answer, with the start of its run when its value is G1 or more. */
export interface Interval {
  readonly start: Instant;
  readonly entry: Entry;
  readonly run?: Instant;
}

/**
 * This function gives the start of the run of each interval of G1 or more. A run is a list of such intervals, in
 * the order of time, where each start is at most `RUN_GAP_MS` after the start before it. The input is in any order.
 * One start twice keeps the last entry.
 */
export function runsOf(entries: readonly Entry[]): Interval[] {
  const byStart = new Map<Instant, Entry>();
  for (const entry of entries) {
    const start = intervalStart(entry.datetime);
    if (start !== undefined) byStart.set(start, entry);
  }
  const intervals: Interval[] = [];
  let run: Instant | undefined;
  let last: Instant | undefined;
  for (const [start, entry] of [...byStart].sort(([a], [b]) => a - b)) {
    const level = geomagneticLevel(kpOf(entry.Kp) ?? Number.NaN) ?? 0;
    if (level === 0) {
      intervals.push({ start, entry });
      continue;
    }
    if (run === undefined || last === undefined || start - last > RUN_GAP_MS) run = start;
    last = start;
    intervals.push({ start, entry, run });
  }
  return intervals;
}

/** The observations of one answer, and the value `complete`. */
export interface Read {
  readonly observations: readonly Observation[];
  /** True: the answer has the structure of the series, each entry is valid, and the license is `GFZ_LICENSE`. */
  readonly complete: boolean;
}

/**
 * This function splits an answer into observations. It gives one for each valid interval of the past 6 hours at the
 * time `fetched`, and one for each entry that is not valid. An answer that is not the series, or that has a different
 * license, gives one observation of the whole body. Then the map tells of the change. A body that does not parse gives
 * `undefined`.
 *
 * The id of an observation has the URL of the series with no times. Thus the body of one interval keeps its id as the
 * window of the query moves.
 */
export function readAnswer(reply: Reply, url: string, series: string, fetched: Instant, latency: number): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/json";
  const transport = { url, status: reply.status, latency };
  const observation = (body: string): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType, url: series, body }),
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
  const columns = isRecord(parsed) ? ([parsed["datetime"], parsed["Kp"], parsed["status"]] as const) : undefined;
  const meta = isRecord(parsed) && isRecord(parsed["meta"]) ? parsed["meta"] : undefined;
  if (columns === undefined || !columns.every(Array.isArray) || new Set(columns.map((column) => (column as unknown[]).length)).size !== 1 || meta?.["license"] !== GFZ_LICENSE) {
    return { observations: [observation(reply.body)], complete: false };
  }
  const [datetimes, values, statuses] = columns as readonly [unknown[], unknown[], unknown[]];
  const entries: Entry[] = datetimes.map((datetime, index) => ({ datetime, Kp: values[index], status: statuses[index] }));
  const invalid = entries.filter((entry) => !isGfzEntry(entry));
  const recent = runsOf(entries.filter(isGfzEntry)).filter(({ start }) => start + REPORT_LIFE_MS > fetched);
  const bodies = new Set([...recent.map(({ entry, run }) => entryBody(entry, run)), ...invalid.map((entry) => entryBody(entry))]);
  return { observations: [...bodies].map(observation), complete: invalid.length === 0 };
}

/**
 * This function makes the fetch function of the GFZ source. The fetch does not throw for a failure of the source: it
 * gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one GET of the query of the past 3 days. The answers have no validators, so the fetch sends no
 * condition. The fetch gives no cursor and no time of the data. The canary check (`checkCanary`) tells of an old series.
 *
 * A cut with no framing can look whole to the HTTP client. A cut answer does not parse, so it fails the fetch.
 */
export function createGfzFetch(options: GfzFetchOptions): (input: GfzFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? GFZ_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const series = `${requester.baseUrl}${SERIES_PATH}?index=Kp`;

  return async (_input, signal) => {
    const requested = await requester.get({ path: queryPath(now()), what: "the index Kp of the past 3 days" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const read = readAnswer(answer.reply, url, series, now(), latency);
    if (read === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    return { ok: true, observations: read.observations, complete: read.complete };
  };
}
