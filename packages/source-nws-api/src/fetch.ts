/**
 * The fetch function of the NWS API source. It asks for the active alerts of the watched regions,
 * through polite-crawler, and gives one observation for each alert.
 */

import { observationId, type Cursor, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester, problemDetail } from "@mark1russell7/alerts-fetch";
import { isUgcCode, WEA_EVENT_CODES } from "@mark1russell7/alerts-format-nws";
import { isRecord } from "@mark1russell7/optional/read";
import { keptReplies, type Condition, type Pace, type Reply, type Transport } from "polite-crawler/api";

import { SOURCE_ID } from "./map.ts";

/** The base URL of the NWS API. */
export const NWS_BASE_URL = "https://api.weather.gov";

/** The provider of the NWS API, in the field `dependsOn` of each source that sends its requests to `NWS_BASE_URL`. */
export const NWS_PROVIDER = "provider:nws-api";

/** The query of the canary: the newest test messages. The NWS sends a keepalive test message each 10 minutes. */
export const CANARY_PATH = "/alerts?status=test&limit=2";

/** The options of the fetch function of the NWS API source. */
export interface NwsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /**
   * The `User-Agent` header. The NWS API refuses a request with no `User-Agent`. The NWS asks for a
   * name of the application and a contact. The instance gives it from its private settings.
   */
  readonly userAgent: string;
  /** The base URL. The default is `NWS_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
  /** True: each fetch also asks for the national WEA messages (`WEA_PATH`). The default is true. */
  readonly weaCopies?: boolean;
}

/** The input of the fetch function, as the contract gives it. */
export interface NwsFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** One query of a fetch: its path, and the effect of its failure. */
export interface Query {
  readonly path: string;
  /**
   * True: the alerts of the watch. False: a query of the health of the source, the canary or the WEA
   * copies. The failure of such a query does not fail the fetch.
   */
  readonly main: boolean;
}

/**
 * The national query of the actual WEA messages. The lateness of IPAWS against this source needs each
 * WEA message of the country, because the IPAWS feed is national. The core filters the reports by `WEAHandling`.
 */
export const WEA_PATH: string = `/alerts/active?status=actual&code=${WEA_EVENT_CODES.join(",")}`;

/** The options of the queries of a watch. */
export interface QueryOptions {
  /** True: the queries include the national query of the WEA messages. The default is true. */
  readonly weaCopies?: boolean;
}

const STATE = /^[A-Z]{2}$/;

/**
 * This function calculates the queries of a watch. A place with a state code gives a query by state
 * (`area=`). A place with zone codes and no state code gives a query by zone (`zone=`). A place with
 * no such code gives the national query. A watch with no place gives no query of alerts. Each
 * watch also gives the canary query, so the health of the source is known with no place.
 *
 * The queries of the watch ask for all kinds and all statuses. The core filters the reports. The
 * national query of the WEA messages comes after the queries of the watch. The national query of all
 * alerts holds the WEA messages, so then the WEA query is not necessary.
 */
export function queriesOf(watch: Watch, options: QueryOptions = {}): Query[] {
  const canary: Query = { path: CANARY_PATH, main: false };
  const health: Query[] = options.weaCopies === false ? [canary] : [{ path: WEA_PATH, main: false }, canary];
  if (watch.places.length === 0) return health;
  const states = new Set<string>();
  const zones = new Set<string>();
  let national = false;
  for (const place of watch.places) {
    const own = place.codes
      .filter((code) => code.system === "state")
      .map((code) => code.code.trim().toUpperCase())
      .filter((code) => STATE.test(code));
    if (own.length > 0) {
      for (const state of own) states.add(state);
      continue;
    }
    const ugc = place.codes
      .filter((code) => code.system === "ugc" || code.system === "ugc-fire")
      .map((code) => code.code.trim().toUpperCase())
      .filter((code) => isUgcCode(code));
    if (ugc.length > 0) for (const zone of ugc) zones.add(zone);
    else national = true;
  }
  const list = (values: Set<string>): string => [...values].sort().join(",");
  if (national) return [{ path: "/alerts/active", main: true }, canary];
  return [
    ...(states.size > 0 ? [{ path: `/alerts/active?area=${list(states)}`, main: true }] : []),
    ...(zones.size > 0 ? [{ path: `/alerts/active?zone=${list(zones)}`, main: true }] : []),
    ...health,
  ];
}

/** The observations of one answer. The value `complete` is true if the answer was a full list of alerts. */
interface Read {
  readonly observations: Observation[];
  readonly complete: boolean;
}

/**
 * This function splits an answer of the NWS API into observations: one for each alert. A JSON body
 * that is not a feature collection gives one observation of the whole body. Then the answer is not complete.
 *
 * A body that is not valid JSON gives `undefined`, and the fetch fails. A cut with no framing can look
 * whole to the HTTP client. Thus a body that does not parse is not a change of the format.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/geo+json";
  const etag = reply.headers["etag"];
  const lastModified = reply.headers["last-modified"];
  const transport = {
    url,
    status: reply.status,
    latency,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
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
  const features = isRecord(parsed) && Array.isArray(parsed["features"]) ? (parsed["features"] as unknown[]) : undefined;
  if (features === undefined) return { observations: [observation(reply.body)], complete: false };
  return { observations: features.map((feature) => observation(JSON.stringify(feature))), complete: true };
}

/** The result of one query. */
type QueryResult = { readonly ok: true; readonly read: Read } | { readonly ok: false; readonly failure: FetchFailure };

/**
 * This function makes the fetch function of the NWS API source. The fetch does not throw for a
 * failure of the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each query is a conditional GET (`poll` of polite-crawler), with the ETag and the date of the last
 * full answer of its URL. A 304 answer has no body. Then the query gives the observations of the
 * last full answer again, unchanged. No message is new, so the log gets no new fact. The fetch keeps the last full
 * answer of each URL as compressed bytes (`keptReplies` of `polite-crawler/api`, AL-145), and it reads the answer
 * again at a 304.
 *
 * The requester of `@mark1russell7/alerts-fetch` sends each query. It reads the problem text of the
 * NWS API (RFC 9457) into the message of a failure.
 */
export function createNwsFetch(options: NwsFetchOptions): (input: NwsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? NWS_BASE_URL,
    headers: { accept: "application/geo+json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    detail: problemDetail,
  });
  const now = options.pace.now;
  // One store of conditions, because each query sends the same accept header
  const conditions = new Map<string, Condition>();
  // The last full answer of each URL, with its time of fetch and its latency. A 304 answer gives its read again.
  const lastAnswer = keptReplies<{ readonly fetched: Instant; readonly latency: number }>();

  async function query(path: string, signal: FetchSignal | undefined): Promise<QueryResult> {
    const requested = await requester.get({ path, what: `the alerts ${path}`, conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      const previous = await lastAnswer.get(url).catch(() => undefined);
      const read = previous === undefined ? undefined : readAnswer(previous.reply, url, previous.extra.fetched, previous.extra.latency);
      if (read !== undefined) return { ok: true, read };
      lastAnswer.delete(url);
      // A 304 with no earlier full answer: the next request of the URL sends no condition
      conditions.delete(url);
      return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
    }
    const fetched = now();
    const read = readAnswer(answer.reply, url, fetched, latency);
    if (read === undefined) {
      // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
      conditions.delete(url);
      lastAnswer.delete(url);
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    lastAnswer.keep(url, answer.reply, { fetched, latency });
    return { ok: true, read };
  }

  return async ({ watch }, signal) => {
    const queries = queriesOf(watch, options.weaCopies === undefined ? {} : { weaCopies: options.weaCopies });
    const observations: Observation[] = [];
    // An alert in two answers is one observation: the first answer gives it
    const bodies = new Set<string>();
    let complete = true;
    for (const { path, main } of queries) {
      const result = await query(path, signal);
      if (!result.ok) {
        // The failure of a health query does not fail the fetch. The canary check, or the lateness check, then has less data.
        if (main) return { ok: false, failure: result.failure };
        continue;
      }
      for (const observation of result.read.observations) {
        if (bodies.has(observation.body)) continue;
        bodies.add(observation.body);
        observations.push(observation);
      }
      if (main && !result.read.complete) complete = false;
    }
    return { ok: true, observations, complete };
  };
}
