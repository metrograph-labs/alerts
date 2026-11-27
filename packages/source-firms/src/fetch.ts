/**
 * The fetch function of the FIRMS source. It asks the area API of NASA FIRMS for the VIIRS hotspots of the past two days.
 * It asks for a box around each watched place with a position, through polite-crawler.
 *
 * A place gives its position to this source only when it shares the position with the source. The box of a request has
 * whole degrees as its edges. Thus a request names a cell of approximately 100 km, not the point of a place. Two places in one
 * cell share one request.
 *
 * The API takes the key only in the path of the URL. The fetch removes the key from each URL and each message that it
 * gives. Each fetch first reads the dates of the data of each product. The canary reads them.
 */

import { matchPlaces, observationId, type FetchFailure, type FetchOutcome, type FetchSignal, type Observation, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import { createRequester, type Requested } from "@mark1russell7/alerts-fetch";
import { bboxOfGeoJson, circleKm, GeoError, type BBox } from "@mark1russell7/geo";
import { redactSecrets } from "@mark1russell7/text/redact";
import type { Pace, Transport } from "polite-crawler/api";

import { AVAILABILITY_TYPE, hotspotArea, hotspotBody, HOTSPOT_TYPE, REPORT_CONFIDENCES, SOURCE_ID, type HotspotBody, type ReportConfidence } from "./map.ts";

/** The base URL of FIRMS. */
export const FIRMS_BASE_URL = "https://firms.modaps.eosdis.nasa.gov";

/**
 * The products of the near real-time VIIRS data that the fetch reads. The Terra satellite of MODIS stops on 2026-12-01,
 * and the pixel of VIIRS is 375 m, not 1 km. Thus the fetch reads no MODIS product.
 */
export const PRODUCTS: readonly string[] = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT"];

/** The count of days of one request: the day of the request in UTC and the day before. Thus a pass before midnight stays in. */
export const DAY_RANGE = 2;

/** The distance that the box adds to the buffer of a place, in kilometres. */
export const BOX_MARGIN_KM = 5;

/** The most boxes of one fetch. Each box gives one request for each product. */
export const MAX_BOXES = 16;

/**
 * The shortest time between two requests to the host. FIRMS permits 5000 transactions in each 10 minutes for one key. One
 * fetch of 16 boxes sends 49 requests.
 */
export const MIN_INTERVAL_MS = 1000;

/** The longest time of one request, in milliseconds. Two days of a box of 3 degrees are less than 100 kB. */
export const TIMEOUT_MS = 30_000;

/** The header of each CSV answer of a VIIRS product. */
export const VIIRS_HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";

/** The header of the CSV answer of the dates of the data. */
export const AVAILABILITY_HEADER = "data_id,min_date,max_date";

/** The options of the fetch function of the FIRMS source. */
export interface FirmsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The MAP_KEY of FIRMS. It goes into the path of each URL, and no URL or message of the fetch holds it. */
  readonly mapKey: string;
  /** The base URL. The default is `FIRMS_BASE_URL`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface FirmsFetchInput {
  readonly watch: Watch;
}

/** A box of whole degrees. The west edge is less than the east edge: a box does not cross the antimeridian. */
export interface Box {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** This function gives the text of a box in the path of a request: `west,south,east,north`. */
export function boxText(box: Box): string {
  return [box.west, box.south, box.east, box.north].map(String).join(",");
}

/**
 * This function gives the boxes of whole degrees that hold the buffer of a place and `BOX_MARGIN_KM`. The edges of the box of
 * a polygon of the circle go out to whole degrees, so the box holds the whole circle. A buffer that crosses the
 * antimeridian gives two boxes. A place with no position gives no box.
 */
export function placeBoxes(place: WatchedPlace): readonly Box[] {
  if (place.at === undefined) return [];
  const [lon, lat] = place.at;
  let box: BBox | undefined;
  try {
    box = bboxOfGeoJson(circleKm({ lat, lon }, place.bufferKm + BOX_MARGIN_KM));
  } catch (error) {
    if (error instanceof GeoError) return [];
    throw error;
  }
  if (box === undefined) return [];
  const south = Math.max(-90, Math.floor(box.south));
  const north = Math.min(90, Math.ceil(box.north));
  const west = Math.max(-180, Math.floor(box.west));
  const east = Math.min(180, Math.ceil(box.east));
  if (box.west <= box.east) return [{ west, south, east, north }];
  return [
    { west, south, east: 180, north },
    { west: -180, south, east, north },
  ];
}

/** This function gives the boxes of the places, with no box twice, in the order of the places. */
export function watchBoxes(places: readonly WatchedPlace[]): readonly Box[] {
  const boxes = new Map<string, Box>();
  for (const box of places.flatMap(placeBoxes)) boxes.set(boxText(box), box);
  return [...boxes.values()];
}

/** The read of one CSV answer of a product. */
export interface ProductRows {
  /** One body for each hotspot of the nominal or the high confidence, in the order of the rows. */
  readonly hotspots: readonly HotspotBody[];
  /** The count of the rows of the low confidence. */
  readonly low: number;
  /** The text of each row that is not valid. */
  readonly invalid: readonly string[];
}

/** This function gives the time of a scan in ISO 8601 from the fields `acq_date` and `acq_time` (`HHMM` in UTC, with no zero at the start). */
export function scanTime(date: string, time: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return undefined;
  const padded = time.padStart(4, "0");
  const text = `${date}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === text.replace("Z", ".000Z") ? text : undefined;
}

/** This function gives the number of a decimal text of a CSV field, or `undefined`. */
function decimal(text: string | undefined): number | undefined {
  return text !== undefined && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : undefined;
}

/**
 * This function reads one CSV answer of a VIIRS product. An answer with a different header gives `undefined`. An answer
 * with only the header has no hotspot.
 */
export function readProduct(product: string, body: string): ProductRows | undefined {
  const lines = body.split(/\r?\n/u).filter((line) => line !== "");
  if (lines[0] !== VIIRS_HEADER) return undefined;
  const hotspots: HotspotBody[] = [];
  const invalid: string[] = [];
  let low = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const [latitude, longitude, , scan, track, date, time, satellite, instrument, confidence, version, , frp, daynight] = cells.map((cell) => cell.trim());
    if (cells.length !== 14) {
      invalid.push(line);
      continue;
    }
    if (confidence === "l") {
      low += 1;
      continue;
    }
    const scanned = scanTime(date ?? "", time ?? "");
    const lat = decimal(latitude);
    const lon = decimal(longitude);
    const scanKm = decimal(scan);
    const trackKm = decimal(track);
    const power = frp === "" ? null : decimal(frp);
    const valid = scanned !== undefined && lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && scanKm !== undefined && trackKm !== undefined && power !== undefined;
    if (!valid || !REPORT_CONFIDENCES.includes(confidence as ReportConfidence) || !satellite || !instrument || !version || !daynight) {
      invalid.push(line);
      continue;
    }
    hotspots.push({ type: HOTSPOT_TYPE, product, latitude: lat, longitude: lon, scanned, satellite, instrument, confidence: confidence as ReportConfidence, version, frp: power, scanKm, trackKm, daynight });
  }
  return { hotspots, low, invalid };
}

/**
 * This function reads the CSV answer of the dates of the data. It gives the newest date of each product of `PRODUCTS`
 * that the answer names, or `undefined` for an answer with a different header.
 */
export function readAvailability(body: string): Readonly<Record<string, string>> | undefined {
  const lines = body.split(/\r?\n/u).filter((line) => line !== "");
  if (lines[0] !== AVAILABILITY_HEADER) return undefined;
  const dates: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const [id, , max] = line.split(",").map((cell) => cell.trim());
    if (id !== undefined && PRODUCTS.includes(id) && max !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(max)) dates[id] = max;
  }
  return dates;
}

/** The text of the answer of FIRMS for a key that it does not accept. FIRMS gives it with the status 400. */
export const INVALID_KEY_TEXT = "Invalid MAP_KEY";

/** The words of the answer of FIRMS when a key has used its transactions of the 10 minutes. */
export const LIMIT_TEXT = "transaction limit";

/** The wait after the answer of the limit: the length of the window of the transactions. */
export const LIMIT_WAIT_MS = 600_000;

/**
 * This function gives the failure of a request. A 400 with the text `INVALID_KEY_TEXT` is `auth`: the key is bad, and a new
 * try does not help. An answer with the text of the limit is `rate-limited`. Each other failure stays as the requester gives it.
 */
export function failureOfRequest(requested: Extract<Requested, { ok: false }>): FetchFailure {
  const body = requested.answer?.reply.body ?? "";
  if (requested.answer?.reply.status === 400 && body.includes(INVALID_KEY_TEXT)) return { kind: "auth", message: requested.failure.message };
  if (body.toLowerCase().includes(LIMIT_TEXT)) return { kind: "rate-limited", message: requested.failure.message, retryAfter: LIMIT_WAIT_MS };
  return requested.failure;
}

/**
 * This function makes the fetch function of the FIRMS source. The fetch does not throw for a failure of the source: it
 * gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * - A failure of a request fails the fetch.
 * - The answers have no validators, so the fetch sends no condition.
 * - An answer that is not the CSV of its product fails the fetch, with the start of its text and no key.
 */
export function createFirmsFetch(options: FirmsFetchOptions): (input: FirmsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const secrets = [options.mapKey];
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? FIRMS_BASE_URL,
    headers: { accept: "text/csv", "user-agent": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    secrets,
  });
  const now = options.pace.now;
  const key = encodeURIComponent(options.mapKey);
  const malformed = (url: string, body: string): FetchOutcome => ({ ok: false, failure: { kind: "server", message: `the answer is not the CSV of FIRMS: ${url}: ${JSON.stringify(redactSecrets(body.slice(0, 120), secrets))}` } });

  return async (input, signal) => {
    const places = input.watch.places.filter((place) => place.at !== undefined);
    const boxes = watchBoxes(places).slice(0, MAX_BOXES);
    const dates = await requester.get({ path: `/api/data_availability/csv/${key}/ALL`, what: "the dates of the data" }, signal);
    if (!dates.ok) return { ok: false, failure: failureOfRequest(dates) };
    const datesUrl = redactSecrets(dates.url, secrets);
    const products = readAvailability(dates.answer.reply.body);
    if (products === undefined) return malformed(datesUrl, dates.answer.reply.body);
    let latency = dates.latency;
    const found = new Map<string, HotspotBody>();
    let invalid = 0;
    for (const box of boxes) {
      for (const product of PRODUCTS) {
        const requested = await requester.get({ path: `/api/area/csv/${key}/${product}/${boxText(box)}/${String(DAY_RANGE)}`, what: `the hotspots of ${product}` }, signal);
        if (!requested.ok) return { ok: false, failure: failureOfRequest(requested) };
        latency += requested.latency;
        const rows = readProduct(product, requested.answer.reply.body);
        if (rows === undefined) return malformed(redactSecrets(requested.url, secrets), requested.answer.reply.body);
        invalid += rows.invalid.length;
        for (const hotspot of rows.hotspots) {
          // The core matches each report with the places. The fetch keeps only the hotspots that the core matches.
          if (matchPlaces({ areas: [hotspotArea(hotspot)] }, places).length === 0) continue;
          const body = hotspotBody(hotspot);
          found.set(body, hotspot);
        }
      }
    }
    const fetched = now();
    const transport = { url: datesUrl, status: dates.answer.reply.status, latency };
    const series = `${requester.baseUrl}/api/area/csv`;
    const observation = (body: string, url: string): Observation => ({
      id: observationId({ source: SOURCE_ID, contentType: "application/json", url, body }),
      source: SOURCE_ID,
      fetched,
      contentType: "application/json",
      body,
      transport,
    });
    const availability = JSON.stringify({ type: AVAILABILITY_TYPE, products: Object.fromEntries(PRODUCTS.flatMap((product) => (products[product] === undefined ? [] : [[product, products[product]]]))) });
    const observations = [observation(availability, `${requester.baseUrl}/api/data_availability/csv`), ...[...found.keys()].map((body) => observation(body, series))];
    return { ok: true, observations, complete: invalid === 0 && boxes.length === watchBoxes(places).length };
  };
}
