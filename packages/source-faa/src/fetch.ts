/**
 * The fetch function of the FAA source. It asks for the airport status of the FAA (`nasstatus.faa.gov`) through
 * polite-crawler. The request names no place. The fetch makes the census of the status for the US states of the watched
 * places on the computer, and gives it as one observation. Then it gives one observation for each program (`programs.ts`).
 *
 * The census holds the time of the update of the status. Thus two fetches of one update give one observation id, and the
 * runtime keeps it one time.
 */

import { observationId, watchedStates, type Cursor, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { censusOf } from "./census.ts";
import { SOURCE_ID } from "./map.ts";
import { programsOf } from "./programs.ts";
import { readStatus } from "./status.ts";

/** The base URL of the airport status of the FAA. */
export const FAA_BASE_URL = "https://nasstatus.faa.gov";

/** The path of the status of all the airports. */
export const STATUS_PATH = "/api/airport-status-information";

/** The content type of each census and each program. */
export const CENSUS_CONTENT_TYPE = "application/json";

/** The shortest time between two requests to the host. The FAA publishes no limit. The status changes approximately one time each minute. */
export const MIN_INTERVAL_MS = 60_000;

/** The options of the fetch function of the FAA source. */
export interface FaaFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `FAA_BASE_URL`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface FaaFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** The observations of one answer, and the value `complete`. */
export interface Read {
  readonly observations: readonly Observation[];
  /** True: the answer is a status with a valid time. */
  readonly complete: boolean;
  /** The programs of the status, for the next fetch. Absent for a status with no valid time: the cursor stays. */
  readonly cursor?: Cursor;
  /** The time of the update of the status. */
  readonly asOf?: Instant;
}

/**
 * This function reads one answer. A status with a valid time gives one census of the states `states`. It also gives one
 * observation for each program, with the cursor `cursor` of the last fetch. A status with no valid time gives one observation of the whole body, and then the map tells of the change. A cut answer, or a body that
 * is not a status, gives `undefined`.
 */
export function readAnswer(reply: Reply, url: string, states: readonly string[], fetched: Instant, latency: number, cursor?: Cursor): Read | undefined {
  const status = readStatus(reply.body);
  if (status === undefined) return undefined;
  const transport = { url, status: reply.status, latency };
  const observation = (contentType: string, body: string): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType, url, body }),
    source: SOURCE_ID,
    fetched,
    contentType,
    body,
    transport,
  });
  const { updated } = status;
  if (updated === undefined) return { observations: [observation(reply.headers["content-type"] ?? "application/xml", reply.body)], complete: false };
  const programs = programsOf({ ...status, updated }, cursor);
  const census = observation(CENSUS_CONTENT_TYPE, JSON.stringify(censusOf({ ...status, updated }, states)));
  const bodies = programs.bodies.map((body) => observation(CENSUS_CONTENT_TYPE, JSON.stringify(body)));
  return { observations: [census, ...bodies], complete: true, cursor: programs.cursor, asOf: updated };
}

/**
 * This function makes the fetch function of the FAA source. The fetch does not throw for a failure of the source: it
 * gives `{ ok: false }`. It throws only when the signal of the caller aborts. Each fetch is one GET of the status. The
 * answers have no validators, so the fetch sends no condition. The canary check (`checkCanary`) tells of an old status.
 */
export function createFaaFetch(options: FaaFetchOptions): (input: FaaFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? FAA_BASE_URL,
    headers: { accept: "application/xml", "user-agent": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;

  return async (input, signal) => {
    const requested = await requester.get({ path: STATUS_PATH, what: "the airport status" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const read = readAnswer(answer.reply, url, watchedStates(input.watch.places), now(), latency, input.cursor);
    if (read === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    const { observations, complete, cursor, asOf } = read;
    return { ok: true, observations, complete, ...(cursor === undefined ? {} : { cursor }), ...(asOf === undefined ? {} : { asOf }) };
  };
}
