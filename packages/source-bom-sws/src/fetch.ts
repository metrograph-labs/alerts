/**
 * The fetch function of the BoM SWS source. Each fetch sends three POSTs through polite-crawler to the space weather API
 * of BoM. They ask for the current magnetic alert, the current geophysical warning and the newest K index of the
 * Australian region. The body of each POST holds the API key. The requests name no place of the watch.
 *
 * The source is a snapshot. Each answer gives the items that are current, and an empty list tells of no item.
 */

import { observationId, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester, type Requested } from "@mark1russell7/alerts-fetch";
import { isRecord } from "@mark1russell7/optional/read";
import { redactSecrets } from "@mark1russell7/text/redact";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { isValidItem, METHODS, REGION, SOURCE_ID, type ItemBody, type Method } from "./map.ts";

/** The base URL of the space weather API of BoM, with its version. */
export const BOM_SWS_BASE_URL = "https://sws-data.sws.bom.gov.au/api/v1";

/**
 * The `accept` header of each request. The server chooses a variant of each method by its type, and it answers 406 to
 * the type `application/json` alone. Thus the header accepts each other type at a lower weight.
 */
export const ACCEPT = "application/json, */*;q=0.5";

/** The error codes of the API that tell of the key. The codes are 21 (no key), 22 (an unknown key) and 23 (no permission). */
export const KEY_ERROR_CODES: readonly number[] = [21, 22, 23];

/** The methods of each fetch, in this order, and the words of each in a message of polite-crawler. */
export const FETCH_METHODS: readonly (readonly [Method, string])[] = [
  [METHODS.alert, "the current magnetic alert"],
  [METHODS.warning, "the current geophysical warning"],
  [METHODS.kIndex, "the newest K index of the Australian region"],
];

/** The options of the fetch function of the BoM SWS source. */
export interface BomSwsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The API key of BoM. It goes only into the body of each POST, and no message of a failure holds it. */
  readonly apiKey: string;
  /** The base URL. The default is `BOM_SWS_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface BomSwsFetchInput {
  readonly watch: Watch;
}

/** This function gives the body of the POST of a method. The K index asks for the Australian region. */
export function requestBody(method: Method, apiKey: string): string {
  return JSON.stringify(method === METHODS.kIndex ? { api_key: apiKey, options: { location: REGION } } : { api_key: apiKey });
}

/** One error of an answer that is not a success: its code, when it has one, and its message. */
export interface ApiErrorItem {
  readonly code?: number;
  readonly message: string;
}

/** This function reads the list `errors` of an answer. A body with no such list gives an empty list. */
export function errorsOf(body: string): ApiErrorItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const errors = isRecord(parsed) && Array.isArray(parsed["errors"]) ? (parsed["errors"] as unknown[]) : [];
  return errors.flatMap((error) => {
    if (!isRecord(error) || typeof error["message"] !== "string") return [];
    const code = typeof error["code"] === "number" ? error["code"] : Number.parseInt(String(error["code"]), 10);
    return [Number.isInteger(code) ? { code, message: error["message"] } : { message: error["message"] }];
  });
}

/**
 * This function gives the problem text of an answer that is not a success: each error with its code, for example
 * `43 Unsupported option value`. The message of an error can hold the key, so the requester removes the key.
 */
export function errorsDetail(body: string): string | undefined {
  const errors = errorsOf(body);
  return errors.length === 0 ? undefined : errors.map((error) => (error.code === undefined ? error.message : `${error.code} ${error.message}`)).join("; ");
}

/** This function gives the failure of a request. An error code of `KEY_ERROR_CODES` makes it the failure `auth`. */
export function failureOfRequest(requested: Extract<Requested, { ok: false }>): FetchFailure {
  const codes = requested.answer === undefined ? [] : errorsOf(requested.answer.reply.body).map((error) => error.code);
  return codes.some((code) => code !== undefined && KEY_ERROR_CODES.includes(code)) ? { kind: "auth", message: requested.failure.message } : requested.failure;
}

/** The observations of one answer, and the value `complete`. */
export interface Read {
  readonly observations: readonly Observation[];
  /** True: the answer has a list `data`, and each item of the list is valid (`isValidItem`). */
  readonly complete: boolean;
}

/**
 * This function splits one answer of a method into observations: one for each item of its list `data`. The body of
 * each is the JSON text of `ItemBody`. An answer with no list `data` gives one observation of the whole body, with
 * the secrets removed. Then the map tells of the change. A body that does not parse gives `undefined`.
 */
export function readAnswer(method: Method, reply: Reply, url: string, fetched: Instant, latency: number, secrets: readonly string[] = []): Read | undefined {
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
  const data = isRecord(parsed) ? parsed["data"] : undefined;
  if (!Array.isArray(data)) return { observations: [observation(redactSecrets(reply.body, secrets))], complete: false };
  const bodies = new Set(data.map((item: unknown) => JSON.stringify({ method, item } satisfies Record<keyof ItemBody, unknown>)));
  const complete = data.every((item: unknown) => isRecord(item) && isValidItem(method, item));
  return { observations: [...bodies].map(observation), complete };
}

/**
 * This function makes the fetch function of the BoM SWS source. The fetch does not throw for a failure of the source:
 * it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * A failure of the alert or of the warning fails the fetch. A failure of the K index does not fail the fetch. The
 * lists of the alerts and the warnings stay whole, and the canary check (`checkCanary`) fails.
 *
 * The answers have no validators, so the fetch sends no condition. A cut answer does not parse, so it fails the fetch.
 */
export function createBomSwsFetch(options: BomSwsFetchOptions): (input: BomSwsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const secrets = [options.apiKey];
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? BOM_SWS_BASE_URL,
    headers: { accept: ACCEPT, "content-type": "application/json", "user-agent": options.userAgent },
    detail: errorsDetail,
    secrets,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;

  return async (_input, signal) => {
    const observations: Observation[] = [];
    let complete = true;
    for (const [method, what] of FETCH_METHODS) {
      const requested = await requester.get({ path: `/${method}`, what, body: requestBody(method, options.apiKey) }, signal);
      if (!requested.ok) {
        if (method === METHODS.kIndex) continue;
        return { ok: false, failure: failureOfRequest(requested) };
      }
      const { url, answer, latency } = requested;
      const read = readAnswer(method, answer.reply, url, now(), latency, secrets);
      if (read === undefined) {
        if (method === METHODS.kIndex) continue;
        return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
      }
      observations.push(...read.observations);
      complete &&= read.complete || method === METHODS.kIndex;
    }
    return { ok: true, observations, complete };
  };
}
