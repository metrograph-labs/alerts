/**
 * The map of the FIRMS source. The fetch gives one observation for each satellite hotspot near a watched place, and one
 * observation of the dates of the data (`AVAILABILITY_TYPE`). The map gives one report for each hotspot, and no report for
 * the dates.
 *
 * A hotspot has no official confirmation. Thus a hotspot of the nominal confidence is a notice, and a hotspot of the high
 * confidence is urgent. No hotspot is a life-safety alert. The fetch keeps no hotspot of the low confidence.
 */

import { categoryOf, kindLabel, reportId, type Area, type Certainty, type MapResult, type Observation, type Report, type Severity, type SourceId } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

/** The id of the source. */
export const SOURCE_ID = "firms" as SourceId;

/** The origin of each report: the Fire Information for Resource Management System of NASA. */
export const FIRMS_ORIGIN = "nasa";

/** The sender of each report. */
export const FIRMS_SENDER = "NASA FIRMS (Fire Information for Resource Management System)";

/**
 * The credit of the data. NASA gives the data of its missions with no restriction (CC0), and it asks for this credit in
 * each use of the data.
 */
export const FIRMS_CREDIT = "NASA FIRMS, Fire Information for Resource Management System, https://firms.modaps.eosdis.nasa.gov";

/** The kind of each report of this source. */
export const HOTSPOT_KIND = "fire.wildfire.hotspot";

/** The type of the body of the observation of the dates of the data. */
export const AVAILABILITY_TYPE = "availability";

/** The type of the body of the observation of one hotspot. */
export const HOTSPOT_TYPE = "hotspot";

/** The system of the correlation key of a hotspot: the cell of `CELL_DEGREES` degrees that holds its point. */
export const CELL_SYSTEM = "firms-cell";

/**
 * The size of a cell of the correlation key, in degrees. The hotspots of one fire are mostly in one cell of approximately 11 km.
 * Thus they are one incident. A fire on the edge of two cells gives two incidents.
 */
export const CELL_DEGREES = 0.1;

/** The time from the scan of a hotspot to the end of its report, in milliseconds: 12 hours, approximately two passes of each satellite. */
export const HOTSPOT_LIFE_MS: number = 12 * 3_600_000;

/** The confidence values of a VIIRS hotspot that give a report: nominal and high. */
export const REPORT_CONFIDENCES = ["n", "h"] as const;

/** A confidence value of a VIIRS hotspot that gives a report. */
export type ReportConfidence = (typeof REPORT_CONFIDENCES)[number];

/** The words of each confidence value. */
const CONFIDENCE_WORDS: Readonly<Record<ReportConfidence, string>> = { n: "nominal", h: "high" };

/** The severity of each confidence value. A hotspot is not a confirmed fire, so the severity stays below `severe`. */
const SEVERITIES: Readonly<Record<ReportConfidence, Severity>> = { n: "minor", h: "moderate" };

/** The certainty of each confidence value. */
const CERTAINTIES: Readonly<Record<ReportConfidence, Certainty>> = { n: "possible", h: "likely" };

/** The names of the satellites of the VIIRS instrument, by the code of the field `satellite`. */
export const SATELLITES: Readonly<Record<string, string>> = { N: "Suomi NPP", N20: "NOAA-20", N21: "NOAA-21" };

/** The fields of the body of one hotspot, in their order. */
export const HOTSPOT_FIELDS = ["type", "product", "latitude", "longitude", "scanned", "satellite", "instrument", "confidence", "version", "frp", "scanKm", "trackKm", "daynight"] as const;

/** The body of one hotspot. */
export interface HotspotBody {
  readonly type: typeof HOTSPOT_TYPE;
  /** The product of FIRMS, for example `VIIRS_NOAA20_NRT`. */
  readonly product: string;
  readonly latitude: number;
  readonly longitude: number;
  /** The time of the scan in ISO 8601, in UTC. */
  readonly scanned: string;
  /** The code of the satellite, as FIRMS gives it. */
  readonly satellite: string;
  readonly instrument: string;
  readonly confidence: ReportConfidence;
  readonly version: string;
  /** The fire radiative power in megawatts, or `null` when the row has no value. */
  readonly frp: number | null;
  /** The size of the pixel along the scan, in kilometres. */
  readonly scanKm: number;
  /** The size of the pixel along the track, in kilometres. */
  readonly trackKm: number;
  /** `D` for a scan in the day, `N` for a scan in the night. */
  readonly daynight: string;
}

/** This function gives the JSON text of the body of one hotspot, with the fields in the order of `HOTSPOT_FIELDS`. */
export function hotspotBody(hotspot: HotspotBody): string {
  return JSON.stringify(Object.fromEntries(HOTSPOT_FIELDS.map((name) => [name, hotspot[name]])));
}

/** This function gives the id of the cell of a point, for example `51.8,4.6`. The cell holds its south-west corner. */
export function cellOf(latitude: number, longitude: number): string {
  const corner = (value: number): string => (Math.floor(value / CELL_DEGREES + 1e-9) * CELL_DEGREES).toFixed(1);
  return `${corner(latitude)},${corner(longitude)}`;
}

/**
 * This function gives the area of a hotspot: a circle around its point that holds the whole pixel. The radius is half of
 * the diagonal of the pixel.
 */
export function hotspotArea(hotspot: Pick<HotspotBody, "latitude" | "longitude" | "scanKm" | "trackKm">): Area {
  return { type: "circle", center: [hotspot.longitude, hotspot.latitude], radiusKm: Math.hypot(hotspot.scanKm, hotspot.trackKm) / 2 };
}

/** This function gives the number of a field when it is a finite number in its range. */
function numberIn(fields: Readonly<Record<string, unknown>>, name: string, low: number, high: number): number | undefined {
  const value = fields[name];
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : undefined;
}

/** This function gives a field when it is a text that is not empty. */
function text(fields: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** This function reads the body of one hotspot. A body that is not valid gives the path and the text of its first fault. */
export function readHotspot(fields: Readonly<Record<string, unknown>>): { readonly ok: true; readonly hotspot: HotspotBody } | { readonly ok: false; readonly path: string; readonly message: string } {
  const fault = (path: string, message: string) => ({ ok: false as const, path, message });
  const latitude = numberIn(fields, "latitude", -90, 90);
  const longitude = numberIn(fields, "longitude", -180, 180);
  if (latitude === undefined || longitude === undefined) return fault("latitude", "the hotspot has no point in the range of WGS 84");
  const scanned = text(fields, "scanned");
  if (scanned === undefined || !Number.isFinite(Date.parse(scanned))) return fault("scanned", "the time of the scan is not a time in ISO 8601");
  const confidence = fields["confidence"];
  if (confidence !== "n" && confidence !== "h") return fault("confidence", `the confidence ${JSON.stringify(confidence)} gives no report`);
  const scanKm = numberIn(fields, "scanKm", 0, 50);
  const trackKm = numberIn(fields, "trackKm", 0, 50);
  if (scanKm === undefined || trackKm === undefined) return fault("scanKm", "the size of the pixel is not a number from 0 to 50 km");
  const product = text(fields, "product");
  const satellite = text(fields, "satellite");
  const instrument = text(fields, "instrument");
  const version = text(fields, "version");
  const daynight = text(fields, "daynight");
  if (product === undefined || satellite === undefined || instrument === undefined || version === undefined || daynight === undefined) return fault("product", "the hotspot has no product, satellite, instrument, version or day flag");
  const frp = fields["frp"] === null ? null : numberIn(fields, "frp", 0, Number.MAX_VALUE);
  if (frp === undefined) return fault("frp", "the fire radiative power is not a number of 0 or more, or null");
  return { ok: true, hotspot: { type: HOTSPOT_TYPE, product, latitude, longitude, scanned, satellite, instrument, confidence, version, frp, scanKm, trackKm, daynight } };
}

/**
 * This function gives the report of one hotspot. The key of the report is the product, the time and the point of the
 * scan. Thus a later fetch of the same hotspot gives the same report, also after a new version of the row.
 */
export function hotspotReport(observation: Observation, hotspot: HotspotBody): Report {
  const sent = Date.parse(hotspot.scanned);
  const key = `${hotspot.product}:${hotspot.scanned}:${String(hotspot.latitude)},${String(hotspot.longitude)}`;
  const satellite = SATELLITES[hotspot.satellite] ?? hotspot.satellite;
  const facts = [
    `The ${hotspot.instrument} instrument of ${satellite} detected a hotspot at ${hotspot.scanned}, with the ${CONFIDENCE_WORDS[hotspot.confidence]} confidence.`,
    hotspot.frp === null ? undefined : `The fire radiative power is ${String(hotspot.frp)} MW.`,
    "A hotspot is a hot pixel in a satellite image. It can be a fire, a flare or a hot surface, and nobody has confirmed it.",
    `Data: ${FIRMS_CREDIT}.`,
  ].filter((fact) => fact !== undefined);
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: FIRMS_ORIGIN,
    key,
    references: [],
    correlation: [{ system: CELL_SYSTEM, id: cellOf(hotspot.latitude, hotspot.longitude) }],
    status: "actual",
    op: "alert",
    kind: { code: HOTSPOT_KIND, label: kindLabel(HOTSPOT_KIND) },
    categories: [categoryOf(HOTSPOT_KIND)],
    severity: SEVERITIES[hotspot.confidence],
    urgency: "immediate",
    certainty: CERTAINTIES[hotspot.confidence],
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: sent,
    onset: sent,
    expires: sent + HOTSPOT_LIFE_MS,
    areas: [hotspotArea(hotspot)],
    about: [],
    sender: FIRMS_SENDER,
    headline: kindLabel(HOTSPOT_KIND),
    description: facts.join(" "),
    observation: observation.id,
    parameters: {
      product: [hotspot.product],
      satellite: [satellite],
      confidence: [CONFIDENCE_WORDS[hotspot.confidence]],
      version: [hotspot.version],
      daynight: [hotspot.daynight],
      ...(hotspot.frp === null ? {} : { frp: [String(hotspot.frp)] }),
      credit: [FIRMS_CREDIT],
    },
  };
}

/**
 * This function maps one observation of the source. A hotspot gives one report. The dates of the data give no report and
 * no problem. Each other body gives a fatal problem and no report.
 */
export function mapObservation(observation: Observation): MapResult {
  const fatal = (path: string, message: string): MapResult => ({ reports: [], problems: [{ path, message, fatal: true }] });
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return fatal("body", "the body is not JSON");
  }
  if (!isRecord(fields)) return fatal("body", "the body is not a JSON object");
  if (fields["type"] === AVAILABILITY_TYPE) return { reports: [], problems: [] };
  if (fields["type"] !== HOTSPOT_TYPE) return fatal("type", `the type ${JSON.stringify(fields["type"])} is not a type of this source`);
  const read = readHotspot(fields);
  if (!read.ok) return fatal(read.path, read.message);
  return { reports: [hotspotReport(observation, read.hotspot)], problems: [] };
}
