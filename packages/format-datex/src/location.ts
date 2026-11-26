/**
 * The reader of the location of a DATEX II situation record, version 3. A location is a point, a line or an itinerary of
 * them. The reader gives the WGS 84 points of each coordinate in the location: each `pointCoordinates` and each pair of a
 * GML `posList`. A location that names only an ALERT-C or an external code has no coordinates, and the reader gives no
 * location for it.
 */

import { isRecord } from "@mark1russell7/optional/read";
import { ENTITY_ACTION, EntityDecoder } from "@nodable/entities";
import { XMLParser } from "fast-xml-parser";

/** A WGS 84 point of a location. */
export interface DatexPoint {
  /** The latitude in degrees, from -90 to 90. */
  readonly latitude: number;
  /** The longitude in degrees, from -180 to 180. */
  readonly longitude: number;
}

/** The location of a record. */
export interface RecordLocation {
  /** `point` for one point, `line` for a line or for two or more points. */
  readonly shape: "point" | "line";
  /** The points, in the order of the text, with no two equal points one after the other. */
  readonly points: readonly DatexPoint[];
}

/** The largest count of points of one location. A longer line keeps its first point, its last point and points at equal steps. */
export const MAX_LOCATION_POINTS = 256;

/** The deepest level of elements that the reader examines in one location. */
const MAX_DEPTH = 32;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  entityDecoder: new EntityDecoder({
    numericAllowed: true,
    onInputEntity: () => ENTITY_ACTION.BLOCK,
    onExternalEntity: () => ENTITY_ACTION.BLOCK,
  }),
});

/** This function gives the point of a latitude and a longitude, or `undefined` for a value out of its range. */
function pointOf(latitude: number, longitude: number): DatexPoint | undefined {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/** This function gives the number of a text, or `NaN` for a value that is not a text. */
function numberOf(value: unknown): number {
  const text = isRecord(value) ? value["#text"] : value;
  return typeof text === "string" && text.trim() !== "" ? Number(text) : Number.NaN;
}

/**
 * This function adds the points of one GML `posList` to `out`. The list gives a latitude and a longitude for each point.
 * A list with an odd count of numbers, or with a number that is not a coordinate, adds nothing.
 */
function addPositions(value: unknown, out: DatexPoint[]): boolean {
  const text = isRecord(value) ? value["#text"] : value;
  if (typeof text !== "string") return false;
  const numbers = text.trim().split(/\s+/u).map(Number);
  if (numbers.length < 2 || numbers.length % 2 !== 0) return false;
  const points: DatexPoint[] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    const point = pointOf(numbers[index]!, numbers[index + 1]!);
    if (point === undefined) return false;
    points.push(point);
  }
  out.push(...points);
  return true;
}

/** This function adds the points of each coordinate under `value` to `out`, in the order of the text. It tells if it found a line. */
function gather(value: unknown, out: DatexPoint[], depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.reduce<boolean>((line, item) => gather(item, out, depth + 1) || line, false);
  if (!isRecord(value)) return false;
  if ("latitude" in value && "longitude" in value) {
    const point = pointOf(numberOf(value["latitude"]), numberOf(value["longitude"]));
    if (point !== undefined) out.push(point);
    return false;
  }
  let line = false;
  for (const [name, child] of Object.entries(value)) {
    if (name === "posList") {
      const lists = Array.isArray(child) ? child : [child];
      for (const list of lists) line = addPositions(list, out) || line;
    } else line = gather(child, out, depth + 1) || line;
  }
  return line;
}

/** This function gives at most `MAX_LOCATION_POINTS` points: the first, the last and points at equal steps between them. */
function thin(points: readonly DatexPoint[]): readonly DatexPoint[] {
  if (points.length <= MAX_LOCATION_POINTS) return points;
  const step = (points.length - 1) / (MAX_LOCATION_POINTS - 1);
  return Array.from({ length: MAX_LOCATION_POINTS }, (_, index) => points[Math.round(index * step)]!);
}

/**
 * This function reads the text of one `locationReference` element: the XML of its content. It gives `undefined` for a
 * text with no coordinate. It does not throw: a text that is not well formed gives `undefined`.
 */
export function readLocation(text: string | undefined): RecordLocation | undefined {
  if (text === undefined || text.includes("<!DOCTYPE")) return undefined;
  let document: unknown;
  try {
    document = parser.parse(`<location>${text}</location>`);
  } catch {
    return undefined;
  }
  const found: DatexPoint[] = [];
  const line = gather(isRecord(document) ? document["location"] : undefined, found, 0);
  const points = found.filter((point, index) => index === 0 || point.latitude !== found[index - 1]!.latitude || point.longitude !== found[index - 1]!.longitude);
  if (points.length === 0) return undefined;
  return { shape: line || points.length > 1 ? "line" : "point", points: thin(points) };
}
