/**
 * The map function of the USGS source. One observation is one event of the earthquake feed of the USGS.
 * The map gives one report for each band of the shaking (`INTENSITY_BANDS` of the quake package), each with its
 * severity and its disc. The discs are nested, so a place gets the severity of the smallest disc that holds it. The
 * reports of one event have the same correlation keys, so they join in one incident.
 *
 * The feed gives only the strongest value of the intensity map. So each disc comes from the law of a point, moved
 * by that value. Along the fault of a large event, the shaking is stronger than the disc gives. The contours of the
 * ShakeMap product replace these discs (AL-14).
 *
 * The feed is a snapshot: it holds the events of the past day. An event that the USGS deletes leaves the
 * feed with no cancel. A new version of an event, for example a new magnitude, is a new body. Thus the
 * key of a report holds the id of its observation, and the ids of the event join the versions in one incident.
 */

import { categoryOf, Problems, reportId, type Area, type Certainty, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { bandDiscs, FELT_INTENSITY, intensityAt, lawAt, type BandDisc } from "@mark1russell7/alerts-quake";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "usgs" as SourceId;

/** The id of the origin of the signals of this source: the US Geological Survey and its networks. */
export const USGS_ORIGIN = "usgs";

/** The system of the correlation keys of this source: the ids of an event in the catalog of the USGS. */
export const EVENT_SYSTEM = "usgs-event";

/** The kind code of an earthquake. */
export const EARTHQUAKE_KIND = "geo.earthquake";

/**
 * The fields of an event that the fetch keeps in the body of an observation, in this order. Each one is
 * a property of the feature, except `id` (the id of the feature) and `coordinates` (its point).
 */
export const EVENT_FIELDS = ["id", "ids", "time", "mag", "magType", "place", "title", "url", "status", "type", "alert", "tsunami", "mmi", "net", "coordinates"] as const;

/**
 * The time in milliseconds that a report stays in effect after the event: one day, the window of the feed.
 * An event leaves the feed at this age, so the report ends then too.
 */
export const REPORT_LIFE_MS = 86_400_000;

/** The certainty of each status of a solution. A solution that a person reviewed is `observed`. */
const CERTAINTY: Readonly<Record<string, Certainty>> = { reviewed: "observed", automatic: "likely" };

/** This function reads a text field. A different value is a fatal problem. */
function textField(fields: Fields, field: string, pattern: RegExp, what: string, problems: Problems): string | undefined {
  const value = fields[field];
  if (typeof value === "string" && pattern.test(value)) return value;
  problems.add(field, `the value ${JSON.stringify(value)} is not ${what}: the map makes no report`, "fatal");
  return undefined;
}

/** This function reads a number field. A different value is a fatal problem. */
function numberField(fields: Fields, field: string, what: string, problems: Problems): number | undefined {
  const value = fields[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  problems.add(field, `the value ${JSON.stringify(value)} is not ${what}: the map makes no report`, "fatal");
  return undefined;
}

/** This function reads the point of an event: the longitude, the latitude and the depth in kilometers. */
function pointOf(fields: Fields, problems: Problems): readonly [number, number, number] | undefined {
  const value = fields["coordinates"];
  const valid =
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part)) &&
    Math.abs(value[0] as number) <= 180 &&
    Math.abs(value[1] as number) <= 90;
  if (valid) return value as [number, number, number];
  problems.add("coordinates", `the value ${JSON.stringify(value)} is not a longitude, a latitude and a depth: the map makes no report`, "fatal");
  return undefined;
}

/** This function gives the ids of an event from the text of the feed, for example `,us7000ki5u,at00rq5jzw,`. */
export function eventIds(text: string): string[] {
  return [...new Set(text.split(",").filter((id) => /^[a-z0-9]+$/.test(id)))].sort();
}

/** This function maps the fields of one event to one report for each band, and can throw. `mapObservation` catches each error. */
function mapEvent(fields: Fields, observation: Observation, problems: Problems): Report[] {
  // The feed also holds quarry blasts, explosions and other events. Only an earthquake gives a report.
  if (fields["type"] !== "earthquake") return [];
  // A deleted event leaves the feed, but a deleted solution can show for a short time.
  if (fields["status"] === "deleted") return [];
  const id = textField(fields, "id", /^[a-z0-9]+$/, "an event id", problems);
  const time = numberField(fields, "time", "a time in milliseconds", problems);
  const magnitude = numberField(fields, "mag", "a magnitude", problems);
  const point = pointOf(fields, problems);
  const title = textField(fields, "title", /\S/, "a title", problems);
  if (id === undefined || time === undefined || magnitude === undefined || point === undefined || title === undefined) return [];

  const [lon, lat, depthKm] = point;
  const law = lawAt([lon, lat]);
  const atEpicenter = intensityAt(law, magnitude, Math.max(0, depthKm));
  // The intensity map of the USGS (ShakeMap) gives the strongest shaking when it exists. Then the bias moves the law,
  // so the law agrees with the map at the epicenter. The feed gives only this one value of the map.
  const mapped = fields["mmi"];
  const measured = typeof mapped === "number" && Number.isFinite(mapped) ? mapped : undefined;
  const bias = measured === undefined ? 0 : measured - atEpicenter;
  const discs = bandDiscs(law, magnitude, depthKm, bias);
  // An event below the felt level at its epicenter keeps one report of the felt band, with a disc of radius 0.
  const bands: readonly BandDisc[] = discs.length > 0 ? discs : [{ severity: "minor", from: FELT_INTENSITY, radiusKm: 0 }];
  const status = fields["status"];
  const certainty = typeof status === "string" ? CERTAINTY[status] : undefined;
  if (certainty === undefined) problems.add("status", `the status ${JSON.stringify(status)} is not known: the certainty is unknown`);
  const ids = typeof fields["ids"] === "string" ? eventIds(fields["ids"]) : [];
  const correlation = [...new Set([id, ...ids])].sort().map((each) => ({ system: EVENT_SYSTEM, id: each }));
  const text = (field: string): string | undefined => (typeof fields[field] === "string" && fields[field] !== "" ? (fields[field] as string) : undefined);
  const place = text("place");
  const web = text("url");
  const alert = text("alert");
  const magnitudeType = text("magType");
  const net = text("net") ?? "us";
  return bands.map((band): Report => {
    const key = `${id}@${observation.id}/${band.severity}`;
    const areas: Area[] = [{ type: "circle", center: [lon, lat], radiusKm: band.radiusKm }];
    return {
      id: reportId({ source: SOURCE_ID, key, sent: time }),
      source: SOURCE_ID,
      origin: USGS_ORIGIN,
      key,
      references: [],
      correlation,
      status: "actual",
      op: "alert",
      kind: { code: EARTHQUAKE_KIND, label: "Earthquake" },
      categories: [categoryOf(EARTHQUAKE_KIND)],
      severity: band.severity,
      // The shaking is over when the feed tells of it.
      urgency: "past",
      certainty: certainty ?? "unknown",
      response: [],
      // The feed gives no time of each version that a count of felt reports leaves alone, so the sent time is the time of the event.
      sent: time,
      received: observation.fetched,
      onset: time,
      expires: time + REPORT_LIFE_MS,
      areas,
      ...(place === undefined ? {} : { areaText: place }),
      about: [],
      sender: net,
      headline: title,
      ...(web === undefined ? {} : { web }),
      observation: observation.id,
      parameters: {
        magnitude: [String(magnitude)],
        ...(magnitudeType === undefined ? {} : { magnitudeType: [magnitudeType] }),
        depthKm: [String(depthKm)],
        strongestIntensity: [(measured ?? atEpicenter).toFixed(1)],
        intensitySource: [measured === undefined ? "law" : "shakemap"],
        intensityBias: [bias.toFixed(2)],
        intensityLaw: [law.id],
        bandIntensity: [String(band.from)],
        bandRadiusKm: [String(band.radiusKm)],
        ...(alert === undefined ? {} : { pager: [alert] }),
        tsunami: [String(fields["tsunami"])],
      },
    };
  });
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The fetch gives the whole answer as one observation when the answer is not the feed
  if (!isRecord(fields) || !EVENT_FIELDS.some((field) => field in fields)) {
    return { reports: [], problems: [{ path: "", message: "the observation is not an event of the USGS feed: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  const reports = mapEvent(fields, observation, problems);
  return { reports, problems: problems.list };
}

/**
 * This function maps one observation of the USGS source to one report for each band of the shaking. The body is one event of the feed.
 * The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
