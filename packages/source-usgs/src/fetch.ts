/**
 * The fetch function of the USGS source. It asks the earthquake feed of the USGS for the events of
 * magnitude 2.5 or more of the past day, through polite-crawler. It gives one observation for each event
 * of the feed.
 *
 * The feed is global. The fetch asks with no filter, so a request names no place of the watch.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { answerStore, createRequester } from "@mark1russell7/alerts-fetch";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import type { Condition, Pace, Reply, Transport } from "polite-crawler/api";

import { EVENT_FIELDS, SOURCE_ID } from "./map.ts";

/** The base URL of the earthquake site of the USGS. */
export const USGS_BASE_URL = "https://earthquake.usgs.gov";

/** The path of the feed: the events of magnitude 2.5 or more of the past day, updated each minute. */
export const FEED_PATH = "/earthquakes/feed/v1.0/summary/2.5_day.geojson";

/** The options of the fetch function of the USGS source. */
export interface UsgsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `USGS_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface UsgsFetchInput {
  readonly watch: Watch;
}

const isText = (value: unknown): boolean => typeof value === "string";
const isNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isTextOrNull = (value: unknown): boolean => value === null || isText(value);
const isNumberOrNull = (value: unknown): boolean => value === null || isNumber(value);

/** The types of the fields of an event that the fetch keeps: the structure that the fetch examines. */
const FIELD_TYPES: Readonly<Record<(typeof EVENT_FIELDS)[number], (value: unknown) => boolean>> = {
  id: isText,
  ids: isText,
  time: isNumber,
  mag: isNumber,
  magType: isTextOrNull,
  place: isTextOrNull,
  title: isText,
  url: isText,
  status: isText,
  type: isText,
  alert: isTextOrNull,
  tsunami: isNumber,
  mmi: isNumberOrNull,
  net: isText,
  coordinates: (value) => Array.isArray(value) && value.length === 3 && value.every(isNumber),
};

/**
 * This function gives the fields of one feature of the feed that the fetch keeps, in the order of
 * `EVENT_FIELDS`. The fields are the id of the feature, the properties and the coordinates of the point. A field that
 * the feature does not have is absent. A value that is not a feature gives `undefined`.
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
 * This function gives the body of the observation of one feature: the JSON text of `eventFields`.
 * The fetch keeps no count of felt reports and no time of the last change. Those values change each few
 * minutes after an event that people feel, and a new body each time gives a new report.
 */
export function eventBody(feature: unknown): string {
  return JSON.stringify(eventFields(feature) ?? feature);
}

/** This function tells if a feature has the structure of the feed: each field of `EVENT_FIELDS` with its type. */
export function isFeedEvent(feature: unknown): boolean {
  const fields = eventFields(feature);
  return fields !== undefined && EVENT_FIELDS.every((field) => field in fields && FIELD_TYPES[field](fields[field]));
}

/** The observations of one answer. The value `complete` is true if the answer was the whole feed. */
interface Read {
  readonly observations: Observation[];
  readonly complete: boolean;
  /** The time when the USGS made the feed, for a complete feed only. */
  readonly asOf?: Instant;
}

/**
 * This function splits an answer of the feed into observations: one for each feature. A JSON body that
 * is not a feature collection gives one observation of the whole body. Then the answer is not complete,
 * and the map tells of the change.
 *
 * The feed is complete when its body parses and it has one feature or more. Also, its count is the count of its
 * features, and each feature has the structure of `isFeedEvent`. The core ends the events that leave a
 * complete feed, so a change of the format must end no event. A body that does not parse gives
 * `undefined`, and the fetch fails. The feed had 51 or more events in each day of 12 days of one year,
 * so an empty feed is a fault of the USGS.
 *
 * A complete feed has the time of its data (`asOf`): the time `generated` of its metadata. A cache can
 * give an old feed, and the runtime reads an old feed by this time.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/json";
  const lastModified = reply.headers["last-modified"];
  const transport = { url, status: reply.status, latency, ...(lastModified === undefined ? {} : { lastModified }) };
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
  if (features === undefined || !isRecord(parsed)) return { observations: [observation(reply.body)], complete: false };
  const metadata = isRecord(parsed["metadata"]) ? parsed["metadata"] : {};
  const generated = metadata["generated"];
  const counted = metadata["count"] === features.length;
  const complete = features.length > 0 && counted && isNumber(generated) && features.every(isFeedEvent);
  // The feed has one feature for each event. One body twice gives one observation.
  const bodies = [...new Set(features.map(eventBody))];
  return { observations: bodies.map(observation), complete, ...(complete ? { asOf: generated as Instant } : {}) };
}

/**
 * This function makes the fetch function of the USGS source. The fetch does not throw for a failure of
 * the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the whole feed, with the date of the
 * last full answer. The feed has no ETag. A 304 answer has no body. Then the fetch gives the
 * observations of the last full answer again, unchanged. The fetch gives no cursor: the feed holds each
 * event of the past day. The fetch keeps the last full answer as compressed bytes (`answerStore`), and it
 * reads the answer again at a 304.
 */
export function createUsgsFetch(options: UsgsFetchOptions): (input: UsgsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? USGS_BASE_URL,
    headers: { accept: "application/geo+json, application/json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  // The last full answer, with its time of fetch and its latency. A 304 answer gives its read again.
  const lastAnswer = answerStore<{ readonly fetched: Instant; readonly latency: number }>();

  return async (_input, signal) => {
    const requested = await requester.get({ path: FEED_PATH, what: "the earthquakes of the past day", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    let read: Read | undefined;
    if (answer.classified.outcome === "not-modified") {
      const previous = await lastAnswer.get(url).catch(() => undefined);
      read = previous === undefined ? undefined : readAnswer(previous.reply, url, previous.extra.fetched, previous.extra.latency);
      if (read === undefined) {
        lastAnswer.delete(url);
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
    } else {
      const fetched = now();
      read = readAnswer(answer.reply, url, fetched, latency);
      if (read === undefined) {
        // poll keeps the condition of each 2xx answer. A body that does not parse must not be the base of a later 304.
        conditions.delete(url);
        lastAnswer.delete(url);
        return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
      }
      lastAnswer.keep(url, answer.reply, { fetched, latency });
    }
    return { ok: true, observations: read.observations, complete: read.complete, ...(read.asOf === undefined ? {} : { asOf: read.asOf }) };
  };
}
