/**
 * The road records of the NDW source near a watched place. The fetch gives one observation for each valid accident,
 * closure or obstruction whose location reaches a place with a position. The map gives one report for each of them.
 *
 * The area of a report is a circle around a point location, or the buffer of a line location. The function `bufferKm` of
 * `@mark1russell7/geo` makes the buffer. The core then matches the area with the places, as for each other report.
 */

import { categoryOf, kindLabel, reportId, type Area, type Certainty, type Instant, type MapResult, type Observation, type Position, type Report, type ResponseType, type Severity, type WatchedPlace } from "@mark1russell7/alerts";
import { isValidAt, recordGroup, type RecordGroup, type RecordLocation, type SituationPublication, type SituationRecord } from "@mark1russell7/alerts-format-datex";
import { bufferKm, distanceKm, distanceToGeometryKm, GeoError, type Geometry } from "@mark1russell7/geo";
import { isRecord } from "@mark1russell7/optional/read";

import { NDW_COUNTRY, NDW_LICENSE, NDW_ORIGIN, SOURCE_ID } from "./ids.ts";

/** The kind of each report of this source. */
export const RECORD_KIND = "transport.road.incident";

/** The groups of records that give a report. The other groups give only counts. */
export const REPORT_GROUPS: readonly RecordGroup[] = ["accident", "closure", "obstruction"];

/** The radius of the circle around a point location, in kilometres. */
export const POINT_RADIUS_KM = 0.25;

/** The distance of the buffer around a line location, in kilometres. */
export const LINE_BUFFER_KM = 0.25;

/** The tolerance of the boundary of the buffer of a line, in kilometres. */
export const LINE_TOLERANCE_KM = 0.05;

/** The system of the correlation key of a record: the id of the record at NDW. Each version of a record has the same key. */
export const RECORD_SYSTEM = "ndw-record";

/** The sender of each report. */
export const NDW_SENDER = "NDW (Nationaal Dataportaal Wegverkeer)";

/** The fields of the body of one record, in their order. */
export const RECORD_FIELDS = [
  "country",
  "license",
  "situation",
  "record",
  "version",
  "type",
  "kind",
  "group",
  "severity",
  "probability",
  "cause",
  "created",
  "updated",
  "start",
  "end",
  "shape",
  "points",
] as const;

/**
 * The body of one record. A fact that the record does not give is `null`. The body has no time of the publication. Thus
 * each fetch of one version of a record gives the same observation, and the runtime keeps it one time.
 */
export interface RecordBody {
  readonly country: string;
  readonly license: string;
  readonly situation: string;
  readonly record: string;
  readonly version: string;
  readonly type: string;
  readonly kind: string | null;
  readonly group: RecordGroup;
  readonly severity: string | null;
  readonly probability: string | null;
  readonly cause: string | null;
  /** The times of the record, in ISO 8601 with milliseconds. */
  readonly created: string | null;
  readonly updated: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly shape: RecordLocation["shape"];
  /** The points of the location, each as a longitude and a latitude. */
  readonly points: readonly Position[];
}

/** A record that gives a report: a record of `REPORT_GROUPS` with a location. */
export type LocatedRecord = SituationRecord & { readonly location: RecordLocation };

/** This function gives the text of a time, or `null`. */
const timeText = (time: Instant | undefined): string | null => (time === undefined ? null : new Date(time).toISOString());

/**
 * This function gives the body of one record of a publication: the JSON text of the fields of `RECORD_FIELDS`, in that
 * order. The country is the country of the publication: the map refuses a country that is not the Netherlands.
 */
export function recordBody(record: LocatedRecord, country: string): string {
  const body: RecordBody = {
    country,
    license: NDW_LICENSE,
    situation: record.situation,
    record: record.id,
    version: record.version,
    type: record.type,
    kind: record.kind ?? null,
    group: recordGroup(record),
    severity: record.severity ?? null,
    probability: record.probability ?? null,
    cause: record.cause ?? null,
    created: timeText(record.created),
    updated: timeText(record.updated),
    start: timeText(record.start),
    end: timeText(record.end),
    shape: record.location.shape,
    points: record.location.points.map((point) => [point.longitude, point.latitude]),
  };
  return JSON.stringify(body);
}

/** This function gives the GeoJSON geometry of the points of a location: a point, or a line. */
function geometryOf(shape: RecordLocation["shape"], points: readonly Position[]): Geometry {
  return shape === "point" || points.length === 1 ? { type: "Point", coordinates: points[0]! } : { type: "LineString", coordinates: points };
}

/**
 * This function gives the areas of a location. A point gives a circle of `POINT_RADIUS_KM`. A line gives the buffer of
 * `LINE_BUFFER_KM`, with one area for each polygon. When geo refuses the buffer, the line gives one circle that holds
 * each point: a larger area, on the safe side.
 */
export function recordAreas(shape: RecordLocation["shape"], points: readonly Position[]): Area[] {
  const first = points[0];
  if (first === undefined) return [];
  if (shape === "point" || points.length === 1) return [{ type: "circle", center: first, radiusKm: POINT_RADIUS_KM }];
  try {
    const buffer = bufferKm(geometryOf(shape, points), LINE_BUFFER_KM, { tolerance: LINE_TOLERANCE_KM });
    const polygons = buffer.type === "Polygon" ? [buffer.coordinates] : buffer.coordinates;
    // A position of geo can have an altitude. An area of the core has only the longitude and the latitude.
    return polygons.map((rings): Area => ({ type: "polygon", rings: rings.map((ring) => ring.map((position): Position => [position[0], position[1]])) }));
  } catch (error) {
    if (!(error instanceof GeoError)) throw error;
    const lons = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    const center: Position = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
    const at = { lat: center[1], lon: center[0] };
    const radius = Math.max(...points.map((point) => distanceKm(at, { lat: point[1], lon: point[0] })));
    return [{ type: "circle", center, radiusKm: radius + LINE_BUFFER_KM }];
  }
}

/**
 * This function tells if a location reaches a place with a position. Its distance to the location is at most a sum:
 * the buffer of the place, the size of the area and the tolerance. The core decides the match of a
 * report from its areas. This test only keeps the records that the core can match.
 */
export function reachesPlace(location: RecordLocation, places: readonly WatchedPlace[]): boolean {
  const points: Position[] = location.points.map((point) => [point.longitude, point.latitude]);
  if (points.length === 0) return false;
  const geometry = geometryOf(location.shape, points);
  const margin = Math.max(POINT_RADIUS_KM, LINE_BUFFER_KM + LINE_TOLERANCE_KM);
  return places.some((place) => {
    if (place.at === undefined) return false;
    try {
      return distanceToGeometryKm({ lat: place.at[1], lon: place.at[0] }, geometry) <= place.bufferKm + margin;
    } catch (error) {
      if (error instanceof GeoError) return false;
      throw error;
    }
  });
}

/**
 * This function gives the records of a publication that give a report. Each is a record of `REPORT_GROUPS` with a
 * location, valid at the time of the publication. The function is pure.
 */
export function reportRecords(publication: SituationPublication): LocatedRecord[] {
  return publication.records.flatMap((record) =>
    record.location !== undefined && REPORT_GROUPS.includes(recordGroup(record)) && isValidAt(record, publication.published) ? [{ ...record, location: record.location }] : [],
  );
}

/** The title of the headline of each group that gives a report. */
const GROUP_TITLES: Readonly<Partial<Record<RecordGroup, string>>> = { accident: "Road accident", closure: "Road closure", obstruction: "Obstruction on a road" };

/** The severity of each overall severity of DATEX II. A road event is `severe` at most. */
const SEVERITIES: Readonly<Record<string, Severity>> = { highest: "severe", high: "severe", medium: "moderate", low: "minor", lowest: "minor", none: "minor" };

/** The certainty of each probability of occurrence of DATEX II. */
const CERTAINTIES: Readonly<Record<string, Certainty>> = { certain: "observed", probable: "likely", riskOf: "possible" };

/** This function reads a text field or `null` of a body, or gives `undefined` for another value. */
function textOrNull(fields: Readonly<Record<string, unknown>>, name: string): string | null | undefined {
  const value = fields[name];
  return value === null || typeof value === "string" ? value : undefined;
}

/** This function reads a time field of a body: a time, `null`, or `undefined` for a value that is not a time in ISO 8601. */
function timeOrNull(fields: Readonly<Record<string, unknown>>, name: string): Instant | null | undefined {
  const value = fields[name];
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

/** This function reads the points of a body: a list of a longitude and a latitude, each in its range. */
function pointsOf(value: unknown): Position[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const points: Position[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return undefined;
    const [lon, lat] = item as unknown[];
    if (typeof lon !== "number" || typeof lat !== "number" || Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined;
    points.push([lon, lat]);
  }
  return points;
}

/**
 * This function maps the observation of one record. It gives one report, or a fatal problem for a body that is not one
 * record of NDW. It can throw only for an error that is not a refusal of geo.
 */
export function mapRecord(observation: Observation, fields: Readonly<Record<string, unknown>>): MapResult {
  const fatal = (path: string, message: string): MapResult => ({ reports: [], problems: [{ path, message, fatal: true }] });
  if (fields["country"] !== NDW_COUNTRY) return fatal("country", `the country ${JSON.stringify(fields["country"])} is not ${NDW_COUNTRY}: the map gives no report`);
  if (fields["license"] !== NDW_LICENSE) return fatal("license", "the license is not the license of NDW: the map gives no report");
  const record = textOrNull(fields, "record");
  const version = textOrNull(fields, "version");
  const situation = textOrNull(fields, "situation");
  const type = textOrNull(fields, "type");
  const group = textOrNull(fields, "group");
  const shape = fields["shape"];
  const points = pointsOf(fields["points"]);
  const title = typeof group === "string" ? GROUP_TITLES[group as RecordGroup] : undefined;
  if (typeof record !== "string" || typeof version !== "string" || typeof situation !== "string" || typeof type !== "string") return fatal("record", "the record has no id, no version, no situation or no type");
  if (title === undefined) return fatal("group", `the group ${JSON.stringify(group)} gives no report`);
  if ((shape !== "point" && shape !== "line") || points === undefined) return fatal("points", "the record has no location that the map can read");
  const times = ["created", "updated", "start", "end"].map((name) => timeOrNull(fields, name));
  const [created, updated, start, end] = times;
  if (times.some((time) => time === undefined)) return fatal("created", "a time of the record is not a time in ISO 8601 or null");
  const kind = textOrNull(fields, "kind") ?? null;
  const severity = textOrNull(fields, "severity") ?? null;
  const probability = textOrNull(fields, "probability") ?? null;
  const cause = textOrNull(fields, "cause") ?? null;

  // The time of the version is the time of the message. A record with no time of version has the time of its creation,
  // then the time of its start. A record with none of them has the time of the fetch of its first observation.
  const sent = updated ?? created ?? start ?? observation.fetched;
  const key = `${record}:${version}`;
  const response: ResponseType[] = group === "obstruction" ? ["monitor"] : ["avoid"];
  const facts = [
    `NDW gives the DATEX II record ${record} of the class ${type}${kind === null ? "" : `, with the type ${kind}`}.`,
    cause === null ? undefined : `The cause is ${cause}.`,
    end === null || end === undefined ? undefined : `The planned end is ${new Date(end).toISOString()}.`,
  ].filter((fact) => fact !== undefined);
  const report: Report = {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: NDW_ORIGIN,
    key,
    references: [],
    correlation: [{ system: RECORD_SYSTEM, id: record }],
    status: "actual",
    op: "alert",
    kind: { code: RECORD_KIND, label: kindLabel(RECORD_KIND) },
    categories: [categoryOf(RECORD_KIND)],
    severity: severity === null ? "unknown" : (SEVERITIES[severity] ?? "unknown"),
    urgency: "immediate",
    certainty: probability === null ? "unknown" : (CERTAINTIES[probability] ?? "unknown"),
    response,
    sent,
    received: observation.fetched,
    effective: start ?? sent,
    ...(start === null || start === undefined ? {} : { onset: start }),
    ...(end === null || end === undefined ? {} : { ends: end }),
    areas: recordAreas(shape, points),
    about: [],
    sender: NDW_SENDER,
    headline: title,
    description: facts.join(" "),
    observation: observation.id,
    parameters: Object.fromEntries(
      [
        ["situation", situation],
        ["record", record],
        ["version", version],
        ["datexClass", type],
        ["datexType", kind],
        ["datexSeverity", severity],
        ["probability", probability],
        ["cause", cause],
        ["license", NDW_LICENSE],
      ].flatMap(([name, value]) => (value === null ? [] : [[name, [value]]])),
    ),
  };
  return { reports: [report], problems: [] };
}

/** This function tells if the fields of a body are the fields of one record. */
export function isRecordBody(fields: unknown): fields is Readonly<Record<string, unknown>> {
  return isRecord(fields) && typeof fields["record"] === "string";
}
