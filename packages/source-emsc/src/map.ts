/**
 * The map function of the EMSC source. One observation is one event of the event service of EMSC (FDSN, format
 * `json`). The map gives one report for each band of the shaking (`INTENSITY_BANDS` of the quake package), as the USGS
 * source does. The answer has no value of an intensity map, so each disc comes from the law of a point alone.
 *
 * EMSC is a second path of the earthquakes, and for some events a second origin. For an event in the US, EMSC relays
 * the solution of a network of the ANSS. Thus the origin of a report comes from the author of its solution. A network
 * of the ANSS gives `usgs`, and each other author gives `emsc`.
 *
 * The answer is a snapshot: it holds the events of the past day. A new version of an event, for example a new
 * magnitude, is a new body. Thus the key of a report holds the id of its observation, and the id of the event joins
 * the versions in one incident. No key joins the reports of EMSC and the USGS: the link rule of the merge (rule 3) joins them.
 */

import { categoryOf, MAGNITUDE_PARAMETER, Problems, reportId, type Area, type Certainty, type Instant, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { bandDiscs, FELT_INTENSITY, intensityAt, lawAt, type BandDisc } from "@mark1russell7/alerts-quake";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "emsc" as SourceId;

/** The id of the origin of a solution of EMSC or of a network that is not in the ANSS. */
export const EMSC_ORIGIN = "emsc";

/** The id of the origin of a solution of a network of the ANSS. It is the origin of the USGS source. */
export const ANSS_ORIGIN = "usgs";

/** The system of the correlation keys of this source: the ids (`unid`) of an event of EMSC. */
export const EVENT_SYSTEM = "emsc-event";

/** The kind code of an earthquake. */
export const EARTHQUAKE_KIND = "geo.earthquake";

/** The credit that the terms of EMSC ask for. The data is under the license CC BY 4.0. */
export const EMSC_CREDIT = "EMSC-CSEM SeismicPortal, https://www.seismicportal.eu";

/** The page of one event for a person. The id of the event follows it. */
export const EVENT_PAGE = "https://www.seismicportal.eu/eventdetails.html?unid=";

/**
 * The fields of an event that the fetch keeps in the body of an observation, in this order. Each one is
 * a property of the feature, except `id` (the id of the feature) and `coordinates` (its point). The fetch
 * does not keep `lastupdate`: a change of that time only gives a new body.
 */
export const EVENT_FIELDS = ["id", "time", "mag", "magtype", "flynn_region", "evtype", "auth", "source_catalog", "depth", "coordinates"] as const;

/**
 * The time in milliseconds that a report stays in effect after the event: one day, the window of the fetch.
 * An event leaves the answer at this age, so the report ends then too.
 */
export const REPORT_LIFE_MS = 86_400_000;

/**
 * The authors of the solutions of the ANSS, as EMSC writes them in the field `auth`. The answer of 2026-11-16 had
 * `NEIC`, `AK`, `HV`, `NN`, `OK` and `PR`. The other entries are the network codes of the ANSS.
 */
export const ANSS_AUTHORS: ReadonlySet<string> = new Set(["NEIC", "US", "AK", "AT", "CI", "HV", "LD", "MB", "NC", "NM", "NN", "OK", "PR", "PT", "SE", "TX", "UU", "UW"]);

/**
 * The certainty of each event type, in the codes of the ISC that EMSC uses. The value `none` is an explosion or a
 * landslide, and it gives no report. A code with no entry gives a report with the certainty `unknown` and a problem.
 */
export const EVENT_TYPES: Readonly<Record<string, Certainty | "none">> = {
  ke: "observed",
  fe: "observed",
  de: "observed",
  ki: "observed",
  kr: "observed",
  se: "likely",
  si: "likely",
  sr: "likely",
  uk: "unknown",
  km: "none",
  sm: "none",
  kh: "none",
  sh: "none",
  kx: "none",
  sx: "none",
  kn: "none",
  sn: "none",
  ls: "none",
};

/** The format of a time of the answer: UTC, with 0 to 9 digits after the second. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * This function gives the instant of a time of the answer, for example `2026-11-16T05:16:26.0Z`. Each other value
 * gives `undefined`. A date or an hour that is not in the calendar gives `undefined` too, for example `2026-11-31`
 * or `24:00`. The parse of the platform moves such a time to the next day.
 */
export function eventTime(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !UTC_TIME.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : undefined;
}

/** This function gives the origin of a solution from its author. An author of the ANSS gives `usgs`. Each other author gives `emsc`. */
export function originOf(author: string | undefined): string {
  return author !== undefined && ANSS_AUTHORS.has(author.toUpperCase()) ? ANSS_ORIGIN : EMSC_ORIGIN;
}

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

/** This function reads the point of an event: the longitude and the latitude. The fetch reads the depth from the field `depth`. */
function pointOf(fields: Fields, problems: Problems): readonly [number, number] | undefined {
  const value = fields["coordinates"];
  if (Array.isArray(value) && value.length >= 2 && value.every((part) => typeof part === "number" && Number.isFinite(part))) {
    const [lon, lat] = value as [number, number];
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) return [lon, lat];
  }
  problems.add("coordinates", `the value ${JSON.stringify(value)} is not a longitude and a latitude: the map makes no report`, "fatal");
  return undefined;
}

/** This function gives the certainty of the event type, or `none` for an event that is not an earthquake. */
function certaintyOf(fields: Fields, problems: Problems): Certainty | "none" {
  const type = fields["evtype"];
  // `Object.hasOwn`, so a type such as `constructor` is a plain unknown code.
  if (typeof type === "string" && Object.hasOwn(EVENT_TYPES, type)) return EVENT_TYPES[type]!;
  problems.add("evtype", `the event type ${JSON.stringify(type)} is not known: the certainty is unknown`);
  return "unknown";
}

/** This function maps the fields of one event to one report for each band, and can throw. `mapObservation` catches each error. */
function mapEvent(fields: Fields, observation: Observation, problems: Problems): Report[] {
  // The answer also holds explosions and landslides. They give no report.
  const certainty = certaintyOf(fields, problems);
  if (certainty === "none") return [];
  const id = textField(fields, "id", /^[A-Za-z0-9_]+$/, "an event id", problems);
  const time = eventTime(fields["time"]);
  if (time === undefined) problems.add("time", `the value ${JSON.stringify(fields["time"])} is not a UTC time: the map makes no report`, "fatal");
  const magnitude = numberField(fields, "mag", "a magnitude", problems);
  const depthKm = numberField(fields, "depth", "a depth in kilometers", problems);
  const point = pointOf(fields, problems);
  if (id === undefined || time === undefined || magnitude === undefined || depthKm === undefined || point === undefined) return [];

  const [lon, lat] = point;
  const law = lawAt([lon, lat]);
  const atEpicenter = intensityAt(law, magnitude, Math.max(0, depthKm));
  const discs = bandDiscs(law, magnitude, depthKm);
  // An event below the felt level at its epicenter keeps one report of the felt band, with a disc of radius 0.
  const bands: readonly BandDisc[] = discs.length > 0 ? discs : [{ severity: "minor", from: FELT_INTENSITY, radiusKm: 0 }];
  const text = (field: string): string | undefined => (typeof fields[field] === "string" && fields[field] !== "" ? (fields[field] as string) : undefined);
  const region = text("flynn_region");
  const author = text("auth");
  const catalog = text("source_catalog");
  const magnitudeType = text("magtype");
  const origin = originOf(author);
  const correlation = [{ system: EVENT_SYSTEM, id }];
  return bands.map((band): Report => {
    const key = `${id}@${observation.id}/${band.severity}`;
    const areas: Area[] = [{ type: "circle", center: [lon, lat], radiusKm: band.radiusKm }];
    return {
      id: reportId({ source: SOURCE_ID, key, sent: time }),
      source: SOURCE_ID,
      origin,
      key,
      references: [],
      correlation,
      status: "actual",
      op: "alert",
      kind: { code: EARTHQUAKE_KIND, label: "Earthquake" },
      categories: [categoryOf(EARTHQUAKE_KIND)],
      severity: band.severity,
      // The shaking is over when the answer tells of it.
      urgency: "past",
      certainty,
      response: [],
      // The answer gives the time of the last change of each event, but the fetch does not keep it. So the sent time is the time of the event.
      sent: time,
      received: observation.fetched,
      onset: time,
      expires: time + REPORT_LIFE_MS,
      areas,
      ...(region === undefined ? {} : { areaText: region }),
      about: [],
      sender: author ?? "EMSC",
      headline: region === undefined ? `M ${magnitude}` : `M ${magnitude} - ${region}`,
      web: `${EVENT_PAGE}${id}`,
      observation: observation.id,
      parameters: {
        [MAGNITUDE_PARAMETER]: [String(magnitude)],
        ...(magnitudeType === undefined ? {} : { magnitudeType: [magnitudeType] }),
        depthKm: [String(depthKm)],
        strongestIntensity: [atEpicenter.toFixed(1)],
        intensitySource: ["law"],
        intensityLaw: [law.id],
        bandIntensity: [String(band.from)],
        bandRadiusKm: [String(band.radiusKm)],
        ...(author === undefined ? {} : { author: [author] }),
        ...(catalog === undefined ? {} : { catalog: [catalog] }),
        credit: [EMSC_CREDIT],
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
  // The fetch gives the whole answer as one observation when the answer is not a feature collection.
  if (!isRecord(fields) || !EVENT_FIELDS.some((field) => field in fields)) {
    return { reports: [], problems: [{ path: "", message: "the observation is not an event of the EMSC answer: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  const reports = mapEvent(fields, observation, problems);
  return { reports, problems: problems.list };
}

/**
 * This function maps one observation of the EMSC source to one report for each band of the shaking. The body is one
 * event of the answer. The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
