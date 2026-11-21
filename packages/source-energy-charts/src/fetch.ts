/**
 * The fetch function of the Energy-Charts source. It asks the API of Energy-Charts (`api.energy-charts.info/v2/frequency`)
 * for the grid frequency of the past minutes, through polite-crawler. The answer holds one value for each second. The
 * query holds only the region of the meter and times, so a request names no place of the watch.
 *
 * The fetch splits the answer into one observation for each complete minute. The id of an observation has the URL of
 * the series with no times. Thus a minute that two fetches give keeps its id, and the runtime keeps it one time.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, readTime, timeOf, type Fields } from "@mark1russell7/optional/read";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { ENERGY_CHARTS_LICENSE, FREQUENCY_REGION, FREQUENCY_UNIT, minuteBody, MINUTE_MS, SECONDS, SOURCE_ID } from "./map.ts";

/** The base URL of the API of Energy-Charts. */
export const ENERGY_CHARTS_BASE_URL = "https://api.energy-charts.info";

/** The path of the frequency series. */
export const FREQUENCY_PATH = "/v2/frequency";

/**
 * The count of whole minutes before the current minute that each query asks for. Each fetch gives the minutes again,
 * so a fetch can fail four times in a row with no lost minute at a fetch each 2 minutes.
 */
export const WINDOW_MINUTES = 10;

/** The shortest time between two requests to the host. The published limit of the API is 2 requests each minute. */
export const MIN_INTERVAL_MS = 30_000;

/** The options of the fetch function of the Energy-Charts source. */
export interface EnergyChartsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `ENERGY_CHARTS_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface EnergyChartsFetchInput {
  readonly watch: Watch;
}

/** This function gives the path of the query at the time `now`: the `WINDOW_MINUTES` whole minutes before the current minute, and the current minute. */
export function queryPath(now: Instant): string {
  const start = (Math.floor(now / MINUTE_MS) - WINDOW_MINUTES) * (MINUTE_MS / 1000);
  return `${FREQUENCY_PATH}?region=${FREQUENCY_REGION}&start=${String(start)}&end=${String(Math.floor(now / 1000))}`;
}

/** The observations of one answer, and the value `complete`. */
export interface Read {
  readonly observations: readonly Observation[];
  /** True: the answer has the envelope of the frequency series with its license, and each row is valid. */
  readonly complete: boolean;
}

/** This function gives the time of a row: a whole second. Each other value gives `undefined`. */
function secondOf(value: unknown): Instant | undefined {
  const time = readTime(value);
  return time !== undefined && time % 1000 === 0 ? time : undefined;
}

/** This function gives the value of a row: a number or `null`. Each other value gives `undefined`. */
function valueOf(row: Fields): number | null | undefined {
  const values = row["values"];
  if (!isRecord(values)) return undefined;
  const value = values["frequency"];
  return value === null || typeof value === "number" ? value : undefined;
}

/**
 * This function splits an answer into observations. It gives one for each complete minute. A complete minute starts at
 * the time `available_from` or after, and its last second is at the time `available_until` or before. It gives one for
 * each row that is not valid.
 *
 * An answer that is not the frequency series, or that has a different license, gives one observation of the whole body.
 * Then the map tells of the change. A body that does not parse gives `undefined`.
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
  const from = isRecord(parsed) ? timeOf(parsed, "available_from") : undefined;
  const until = isRecord(parsed) ? timeOf(parsed, "available_until") : undefined;
  if (
    !isRecord(parsed) ||
    parsed["endpoint"] !== "frequency" ||
    parsed["unit"] !== FREQUENCY_UNIT ||
    parsed["timezone"] !== "UTC" ||
    parsed["license"] !== ENERGY_CHARTS_LICENSE ||
    !Array.isArray(parsed["data"]) ||
    from === undefined ||
    until === undefined
  ) {
    return { observations: [observation(reply.body)], complete: false };
  }
  const minutes = new Map<Instant, (number | null)[]>();
  const invalid = new Set<string>();
  for (const row of parsed["data"] as unknown[]) {
    const time = isRecord(row) ? secondOf(row["timestamp"]) : undefined;
    const value = isRecord(row) ? valueOf(row) : undefined;
    if (time === undefined || value === undefined) {
      invalid.add(JSON.stringify(row));
      continue;
    }
    const minute = Math.floor(time / MINUTE_MS) * MINUTE_MS;
    const values = minutes.get(minute) ?? Array.from({ length: SECONDS }, (): number | null => null);
    // One second twice keeps the last row.
    values[(time - minute) / 1000] = value;
    minutes.set(minute, values);
  }
  // A minute that starts before `available_from` is a part of a minute: the query or the data starts in it.
  const complete = [...minutes].filter(([minute]) => minute >= from && minute + MINUTE_MS - 1000 <= until).sort(([a], [b]) => a - b);
  const bodies = new Set([...complete.map(([minute, values]) => minuteBody(minute, values)), ...invalid]);
  return { observations: [...bodies].map(observation), complete: invalid.size === 0 };
}

/**
 * This function makes the fetch function of the Energy-Charts source. The fetch does not throw for a failure of the
 * source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one GET of the past minutes. The answers have no validators, so the fetch sends no condition. The fetch
 * gives no cursor. The canary check (`checkCanary`) tells of an old series.
 *
 * A cut with no framing can look whole to the HTTP client. A cut answer does not parse, so it fails the fetch.
 */
export function createEnergyChartsFetch(options: EnergyChartsFetchOptions): (input: EnergyChartsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? ENERGY_CHARTS_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const series = `${requester.baseUrl}${FREQUENCY_PATH}?region=${FREQUENCY_REGION}`;

  return async (_input, signal) => {
    const requested = await requester.get({ path: queryPath(now()), what: "the grid frequency of the past minutes" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const read = readAnswer(answer.reply, url, series, now(), latency);
    if (read === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    return { ok: true, observations: read.observations, complete: read.complete };
  };
}
