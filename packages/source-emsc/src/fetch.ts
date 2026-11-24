/**
 * The fetch function of the EMSC source. It asks the event service of EMSC (FDSN) for the events of magnitude 2.5 or
 * more of the past day, through polite-crawler. It gives one observation for each event of the answer.
 *
 * The service is global. The fetch asks with no filter of place, so a request names no place of the watch. The fetch
 * sends no cookie and keeps none: the answers set a cookie of the load balancer, and the source does not use it.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { answerStore, createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import type { Condition, Conditions, Pace, Reply, Transport } from "polite-crawler/api";

import { EVENT_FIELDS, eventTime, REPORT_LIFE_MS, SOURCE_ID } from "./map.ts";

/** The base URL of the SeismicPortal of EMSC. */
export const EMSC_BASE_URL = "https://www.seismicportal.eu";

/** The path of the event service (FDSN). */
export const QUERY_PATH = "/fdsnws/event/1/query";

/** The smallest magnitude of the query: the magnitude of the feed of the USGS source. */
export const MIN_MAGNITUDE = 2.5;

/**
 * The most events of one answer. The past day had 183 events of magnitude 2.5 or more on 2026-11-16. An answer with
 * this count can have no room for each event, so it is not complete.
 */
export const QUERY_LIMIT = 500;

const HOUR_MS = 3_600_000;

/**
 * This function gives the path of the query at the time `now`, with its query. The query asks for the events after the
 * start of the hour one day before, newest first. Thus the path stays the same for one hour, and a conditional GET can
 * get the answer 304.
 */
export function queryPath(now: Instant): string {
  const start = new Date(Math.floor((now - REPORT_LIFE_MS) / HOUR_MS) * HOUR_MS).toISOString().slice(0, 19);
  return `${QUERY_PATH}?format=json&minmag=${MIN_MAGNITUDE}&start=${start}&orderby=time&limit=${QUERY_LIMIT}`;
}

/** The options of the fetch function of the EMSC source. */
export interface EmscFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `EMSC_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface EmscFetchInput {
  readonly watch: Watch;
}

const isText = (value: unknown): boolean => typeof value === "string";
const isNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isTextOrNull = (value: unknown): boolean => value === null || isText(value);

/** The types of the fields of an event that the fetch keeps: the structure that the fetch examines. */
const FIELD_TYPES: Readonly<Record<(typeof EVENT_FIELDS)[number], (value: unknown) => boolean>> = {
  id: isText,
  time: (value) => eventTime(value) !== undefined,
  mag: isNumber,
  magtype: isTextOrNull,
  flynn_region: isTextOrNull,
  evtype: isTextOrNull,
  auth: isTextOrNull,
  source_catalog: isTextOrNull,
  depth: isNumber,
  coordinates: (value) => Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(isNumber),
};

/**
 * This function gives the fields of one feature of the answer that the fetch keeps, in the order of `EVENT_FIELDS`.
 * The fields are the id of the feature, the properties and the coordinates of the point. A field that the feature does
 * not have is absent. A value that is not a feature gives `undefined`.
 */
export function eventFields(feature: unknown): Fields | undefined {
  if (!isRecord(feature)) return undefined;
  const properties = isRecord(feature["properties"]) ? feature["properties"] : {};
  const geometry = isRecord(feature["geometry"]) ? feature["geometry"] : {};
  const all: Fields = { ...properties, id: feature["id"], coordinates: geometry["coordinates"] };
  const kept: Record<string, unknown> = {};
  for (const field of EVENT_FIELDS) if (all[field] !== undefined) kept[field] = all[field];
  return kept;
}

/**
 * This function gives the body of the observation of one feature: the JSON text of `eventFields`. The fetch keeps no
 * time of the last change and no id of the database of EMSC. A change of those values only gives a new body, and a new
 * body gives a new report.
 */
export function eventBody(feature: unknown): string {
  return JSON.stringify(eventFields(feature) ?? feature);
}

/** This function tells if a feature has the structure of the answer: each field of `EVENT_FIELDS` with its type. */
export function isEmscEvent(feature: unknown): boolean {
  const fields = eventFields(feature);
  return fields !== undefined && EVENT_FIELDS.every((field) => field in fields && FIELD_TYPES[field](fields[field]));
}

/** One observation of an answer, with the time of its event. A time that does not parse is `undefined`. */
interface Listed {
  readonly time: Instant | undefined;
  readonly observation: Observation;
}

/** The observations of one answer. The value `complete` is true if the answer held each event of the query. */
interface Read {
  readonly listed: readonly Listed[];
  readonly complete: boolean;
}

/**
 * This function splits an answer of the query into observations: one for each feature. A JSON body that is not a
 * feature collection gives one observation of the whole body. Then the answer is not complete, and the map tells of
 * the change.
 *
 * The answer is complete when its body parses and it has one feature or more, and fewer than `QUERY_LIMIT`. Also,
 * its count is the count of its features, and each feature has the structure of `isEmscEvent`. The core ends the
 * events that leave a complete answer, so a change of the format must end no event. A body that does not parse
 * gives `undefined`, and the fetch fails. The answer has no time of its data, so the runtime reads it as current.
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
  const features = isRecord(parsed) && parsed["type"] === "FeatureCollection" && Array.isArray(parsed["features"]) ? (parsed["features"] as unknown[]) : undefined;
  if (features === undefined || !isRecord(parsed)) return { listed: [{ time: undefined, observation: observation(reply.body) }], complete: false };
  const metadata = isRecord(parsed["metadata"]) ? parsed["metadata"] : {};
  const counted = metadata["count"] === features.length;
  const complete = features.length > 0 && features.length < QUERY_LIMIT && counted && features.every(isEmscEvent);
  // The answer has one feature for each event. One body twice gives one observation.
  const bodies = new Map<string, Instant | undefined>();
  for (const feature of features) {
    const body = eventBody(feature);
    if (!bodies.has(body)) bodies.set(body, eventTime(eventFields(feature)?.["time"]));
  }
  return { listed: [...bodies].map(([body, time]) => ({ time, observation: observation(body) })), complete };
}

/**
 * This function gives the observations of the events of the past day at the time `now`. The query starts at the
 * start of an hour, so an answer holds older events too. Their reports have expired. An event with no time stays, so
 * the map tells of its problem.
 */
export function pastDay(listed: readonly Listed[], now: Instant): Observation[] {
  return listed.filter(({ time }) => time === undefined || time > now - REPORT_LIFE_MS).map(({ observation }) => observation);
}

/** A store of the condition of one URL. The path of the query changes each hour, so the store keeps only the last URL. */
function lastUrlStore(): Conditions & { clear(): void } {
  let held: { readonly url: string; readonly condition: Condition } | undefined;
  return {
    get: (url) => (held?.url === url ? held.condition : undefined),
    set: (url, condition) => void (held = { url, condition }),
    clear: () => void (held = undefined),
  };
}

/**
 * This function makes the fetch function of the EMSC source. The fetch does not throw for a failure of the source:
 * it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the query of the past day, with the ETag of the last
 * full answer. A 304 answer has no body. Then the fetch gives the observations of the last full answer again, with
 * only the events of the past day. The fetch gives no cursor: the answer holds each event of the past day. The fetch
 * keeps the last full answer as compressed bytes (`answerStore`), and it reads the answer again at a 304.
 */
export function createEmscFetch(options: EmscFetchOptions): (input: EmscFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? EMSC_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const conditions = lastUrlStore();
  // The last full answer, with its time of fetch and its latency. A 304 answer gives its read again. The path of the
  // query changes each hour, so the store keeps only the answer of the last URL.
  const lastAnswer = answerStore<{ readonly fetched: Instant; readonly latency: number }>();
  let keptUrl: string | undefined;
  const forget = (): void => {
    if (keptUrl !== undefined) lastAnswer.delete(keptUrl);
    keptUrl = undefined;
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path: queryPath(now()), what: "the earthquakes of the past day", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    let read: Read | undefined;
    if (answer.classified.outcome === "not-modified") {
      const previous = keptUrl === url ? await lastAnswer.get(url).catch(() => undefined) : undefined;
      read = previous === undefined ? undefined : readAnswer(previous.reply, url, previous.extra.fetched, previous.extra.latency);
      if (read === undefined) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.clear();
        forget();
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
    } else {
      const fetched = now();
      read = readAnswer(answer.reply, url, fetched, latency);
      if (read === undefined) {
        // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
        conditions.clear();
        forget();
        return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
      }
      forget();
      lastAnswer.keep(url, answer.reply, { fetched, latency });
      keptUrl = url;
    }
    return { ok: true, observations: pastDay(read.listed, now()), complete: read.complete };
  };
}
