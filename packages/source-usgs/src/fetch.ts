/**
 * The fetch function of the USGS source. It asks the earthquake feed of the USGS for the events of
 * magnitude 2.5 or more of the past day, through polite-crawler. It gives one observation for each event
 * of the feed.
 *
 * The feed is global. The fetch asks with no filter, so a request names no place of the watch.
 *
 * A felt event can have a ShakeMap product. Then the fetch also reads the detail of the event and the grid of its
 * intensity. It adds the region of each band of the shaking to the body (`shakemap.ts`).
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { FELT_INTENSITY } from "@mark1russell7/alerts-quake";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { keptReplies, type Condition, type Pace, type Reply, type Transport } from "polite-crawler/api";

import { EVENT_FIELDS, NUCLEAR_TYPE, SOURCE_ID } from "./map.ts";
import { intensityGridOf, shakeContours, shakeProductOf, type ShakeContours, type ShakeProduct } from "./shakemap.ts";

/** The base URL of the earthquake site of the USGS. */
export const USGS_BASE_URL = "https://earthquake.usgs.gov";

/** The path of the feed: the events of magnitude 2.5 or more of the past day, updated each minute. */
export const FEED_PATH = "/earthquakes/feed/v1.0/summary/2.5_day.geojson";

/** This function gives the path of the detail of one event, with its products. */
export function detailPath(id: string): string {
  return `/earthquakes/feed/v1.0/detail/${id}.geojson`;
}

/**
 * The most events whose ShakeMap the fetch reads in one fetch. Each event takes two requests. The other events wait
 * for the next fetch, so one fetch stays short.
 */
export const SHAKEMAP_READS = 2;

/** The time in milliseconds before the fetch reads the ShakeMap of an event again after a failure. */
export const SHAKEMAP_RETRY_MS = 600_000;

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
 *
 * With `contours`, the body also has the field `shakemap`: the regions of the bands on the ShakeMap grid. A new
 * version of the product gives a new body.
 */
export function eventBody(feature: unknown, contours?: ShakeContours): string {
  const fields = eventFields(feature);
  if (fields === undefined) return JSON.stringify(feature);
  return JSON.stringify(contours === undefined ? fields : { ...fields, shakemap: contours });
}

/** This function gives the id of a feature, or an empty text for a value that is not a feature. */
function featureId(feature: unknown): string {
  return isRecord(feature) && typeof feature["id"] === "string" ? feature["id"] : "";
}

/** An event of the feed with a ShakeMap product, and the time of its last change. */
export interface ShakeEvent {
  readonly id: string;
  readonly updated: number;
}

/**
 * This function gives the events of a body of the feed that have a ShakeMap product and an intensity of the felt
 * level or more. Only an earthquake and a nuclear test count. A body that does not parse gives no event.
 */
export function shakeEvents(body: string): ShakeEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const features = isRecord(parsed) && Array.isArray(parsed["features"]) ? (parsed["features"] as unknown[]) : [];
  return features.flatMap((feature): ShakeEvent[] => {
    const properties = isRecord(feature) && isRecord(feature["properties"]) ? feature["properties"] : {};
    const { types, mmi, updated, type } = properties;
    const id = featureId(feature);
    const felt = isNumber(mmi) && (mmi as number) >= FELT_INTENSITY;
    const shaken = type === "earthquake" || type === NUCLEAR_TYPE;
    const listed = typeof types === "string" && types.includes(",shakemap,");
    return /^[a-z0-9]+$/.test(id) && listed && felt && shaken && isNumber(updated) ? [{ id, updated: updated as number }] : [];
  });
}

/** The ShakeMap of one event that the fetch keeps. */
interface KeptShake {
  /** The time of the change of the event at the last read. It is absent after a failure with no earlier read. */
  readonly updated?: number;
  /** The contours of the last read. An event with no product or no usable grid has none. */
  readonly contours?: ShakeContours;
  /** After a failure: the time of the next read. */
  readonly retryAt?: Instant;
}

/** The result of one read of the ShakeMap of an event. A failure keeps the earlier contours. */
type ShakeRead = { readonly ok: false } | { readonly ok: true; readonly contours?: ShakeContours };

/** The store of the ShakeMap contours of the events of the feed. */
interface ShakeStore {
  /** This method reads the ShakeMap of each event that changed, at most `SHAKEMAP_READS` events. */
  refresh(events: readonly ShakeEvent[], signal?: FetchSignal): Promise<void>;
  /** This method gives the contours of an event, or `undefined`. */
  contoursOf(id: string): ShakeContours | undefined;
}

/** This function parses a JSON text, and gives `undefined` for a text that does not parse. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * This function makes the store of the ShakeMap contours. The store reads the detail of an event when the event
 * changed, and the grid only when the version of the product changed. It keeps only the events of the last feed.
 * After a failure, it keeps the earlier contours and reads again after `SHAKEMAP_RETRY_MS`.
 */
function createShakeStore(requester: Requester, now: () => Instant): ShakeStore {
  const kept = new Map<string, KeptShake>();
  const readGrid = async (product: ShakeProduct, signal?: FetchSignal): Promise<ShakeRead> => {
    // The fetch asks only the host of the feed.
    const url = new URL(product.gridUrl);
    if (url.host !== requester.host) return { ok: true };
    const grid = await requester.get({ path: `${url.pathname}${url.search}`, what: "the grid of the shaking of an earthquake" }, signal);
    if (!grid.ok) return { ok: false };
    const body = parsed(grid.answer.reply.body);
    if (body === undefined) return { ok: false };
    const values = intensityGridOf(body);
    if (values === undefined) return { ok: true };
    try {
      return { ok: true, contours: shakeContours(product.version, values) };
    } catch {
      // gridRegion refuses a grid across the antimeridian. Then the bands keep their discs.
      return { ok: true };
    }
  };
  const read = async (id: string, earlier: ShakeContours | undefined, signal?: FetchSignal): Promise<ShakeRead> => {
    const detail = await requester.get({ path: detailPath(id), what: "the detail of an earthquake" }, signal);
    if (!detail.ok) return { ok: false };
    const body = parsed(detail.answer.reply.body);
    if (body === undefined) return { ok: false };
    const product = shakeProductOf(body);
    if (product === undefined) return { ok: true };
    if (earlier?.version === product.version) return { ok: true, contours: earlier };
    return readGrid(product, signal);
  };
  return {
    async refresh(events, signal) {
      const live = new Set(events.map((event) => event.id));
      for (const id of [...kept.keys()]) if (!live.has(id)) kept.delete(id);
      let reads = 0;
      for (const event of events) {
        const earlier = kept.get(event.id);
        if (earlier?.updated === event.updated) continue;
        if (earlier?.retryAt !== undefined && now() < earlier.retryAt) continue;
        if (reads >= SHAKEMAP_READS) break;
        reads += 1;
        const result = await read(event.id, earlier?.contours, signal);
        const contours = result.ok ? result.contours : earlier?.contours;
        const updated = result.ok ? event.updated : earlier?.updated;
        kept.set(event.id, {
          ...(updated === undefined ? {} : { updated }),
          ...(contours === undefined ? {} : { contours }),
          ...(result.ok ? {} : { retryAt: now() + SHAKEMAP_RETRY_MS }),
        });
      }
    },
    contoursOf: (id) => kept.get(id)?.contours,
  };
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
 *
 * The function `contoursOf` gives the ShakeMap contours of an event by its id. The default gives none.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number, contoursOf: (id: string) => ShakeContours | undefined = () => undefined): Read | undefined {
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
  const bodies = [...new Set(features.map((feature) => eventBody(feature, contoursOf(featureId(feature)))))];
  return { observations: bodies.map(observation), complete, ...(complete ? { asOf: generated as Instant } : {}) };
}

/**
 * This function makes the fetch function of the USGS source. The fetch does not throw for a failure of
 * the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the whole feed, with the date of the
 * last full answer. The feed has no ETag. A 304 answer has no body. Then the fetch gives the
 * observations of the last full answer again, unchanged. The fetch gives no cursor: the feed holds each
 * event of the past day. The fetch keeps the last full answer as compressed bytes (`keptReplies` of
 * `polite-crawler/api`), and it reads the answer again at a 304.
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
  const lastAnswer = keptReplies<{ readonly fetched: Instant; readonly latency: number }>();
  const shakes = createShakeStore(requester, now);

  return async (_input, signal) => {
    const requested = await requester.get({ path: FEED_PATH, what: "the earthquakes of the past day", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    let read: Read | undefined;
    if (answer.classified.outcome === "not-modified") {
      const previous = await lastAnswer.get(url).catch(() => undefined);
      if (previous !== undefined) await shakes.refresh(shakeEvents(previous.reply.body), signal);
      read = previous === undefined ? undefined : readAnswer(previous.reply, url, previous.extra.fetched, previous.extra.latency, shakes.contoursOf);
      if (read === undefined) {
        lastAnswer.delete(url);
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
      }
    } else {
      const fetched = now();
      await shakes.refresh(shakeEvents(answer.reply.body), signal);
      read = readAnswer(answer.reply, url, fetched, latency, shakes.contoursOf);
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
