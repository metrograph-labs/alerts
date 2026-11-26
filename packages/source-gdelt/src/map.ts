/**
 * The map function of the GDELT source. GDELT codes events from the news of the world each 15 minutes. The fetch gives
 * one observation for each event of `keepEvent`: a protest, an assault, a fight or mass violence at the point of a city.
 * Each observation gives one report of `security.civil-unrest` or `security.armed-conflict`, in a circle at that point.
 *
 * The events come from a machine that reads the news, so the certainty of each report is `possible`. A report is a
 * second witness and a weak signal near a watched place, not a warning.
 *
 * GDELT adds an event only after the news reports it, so the urgency of each report is `past`. Under the first policy
 * of the core, no class holds the two kinds, and the urgency `past` gives the digest at most. Thus a report of GDELT
 * alone sends no push. In an incident with an official warning, the merge keeps the higher urgency of the warning.
 */

import { categoryOf, kindLabel, reportId, type Area, type MapResult, type Observation, type Reading, type Report, type Severity, type SourceId } from "@mark1russell7/alerts";
import { isRecord, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { addedTime, dayStart, EVENT_FIELDS } from "./row.ts";

/** The id of this source. */
export const SOURCE_ID = "gdelt" as SourceId;

/** The id of the origin of the reports: the news media that GDELT reads. */
export const GDELT_ORIGIN = "news-media";

/** The kind of a report of a protest (root code 14). */
export const UNREST_KIND = "security.civil-unrest";

/** The kind of a report of an assault, a fight or mass violence (root codes 18, 19 and 20). */
export const CONFLICT_KIND = "security.armed-conflict";

/** The kind codes of this source. */
export const GDELT_KINDS: readonly string[] = [UNREST_KIND, CONFLICT_KIND];

/** The sender of each report. */
export const GDELT_SENDER = "The GDELT Project, coded by machine from the news";

/** The citation that the terms of GDELT ask for, with the link to the site. */
export const GDELT_CREDIT = "The GDELT Project, https://www.gdeltproject.org/";

/** The terms of use of GDELT: free use and redistribution, with a citation and a link. */
/**
 * The id of the measure of the census (AL-142). Each value is the count of the protests and the fights in one file of 15
 * minutes, in one US state with a watched place. Thus an event with only the place of a state also counts.
 */
export const CONFLICT_EVENTS_MEASURE = "conflict-events";

/** The form of the code of a region of the census: a US state in the system `state`. */
const CENSUS_REGION = /^[A-Z]{2}$/;

export const GDELT_TERMS_URL = "https://www.gdeltproject.org/about.html#termsofuse";

/**
 * The radius of the circle of a report, in kilometers. GDELT gives the center point of a city or a county of the United
 * States, not the point of the event. A circle of 25 km holds the core of most cities and most counties.
 */
export const PLACE_RADIUS_KM = 25;

/** This function gives the area of the report of an event at a point: a circle of `PLACE_RADIUS_KM` around the point. */
export function eventAreas(lat: number, lon: number): Area[] {
  return [{ type: "circle", center: [lon, lat], radiusKm: PLACE_RADIUS_KM }];
}

/** The time from the addition of an event to the end of its report: one day. A news event of one day is old after it. */
export const REPORT_LIFE_MS = 86_400_000;

/** The label of each CAMEO code that the headline names. A code with no label gets the label of its root code. */
export const CAMEO_LABELS: Readonly<Record<string, string>> = {
  "14": "Protest",
  "141": "Demonstration",
  "142": "Hunger strike",
  "143": "Strike or boycott",
  "144": "Blockade",
  "145": "Violent protest or riot",
  "18": "Assault",
  "180": "Assault",
  "181": "Abduction or hostage taking",
  "182": "Physical assault",
  "183": "Bombing",
  "184": "Use of a person as a shield",
  "185": "Attempted assassination",
  "186": "Assassination",
  "19": "Fighting",
  "190": "Fighting",
  "191": "Blockade or restriction of movement",
  "192": "Occupation of territory",
  "193": "Fighting with small arms",
  "194": "Fighting with artillery and tanks",
  "195": "Aerial attack",
  "196": "Violation of a ceasefire",
  "20": "Mass violence",
  "200": "Mass violence",
  "201": "Mass expulsion",
  "202": "Mass killings",
  "203": "Ethnic cleansing",
  "204": "Use of weapons of mass destruction",
};

/** This function gives the label of a CAMEO code: the label of the code, of its first three digits, or of its root. */
export function cameoLabel(code: string, root: string): string {
  return CAMEO_LABELS[code] ?? CAMEO_LABELS[code.slice(0, 3)] ?? CAMEO_LABELS[root] ?? `Event ${code}`;
}

/**
 * This function gives the severity of an event. Mass violence (root 20) is `severe`. A riot (145), an assault (18) and
 * a fight (19) are `moderate`. Each other protest is `minor`.
 */
export function severityOf(code: string, root: string): Severity {
  if (root === "20") return "severe";
  if (root === "18" || root === "19" || code.startsWith("145")) return "moderate";
  return "minor";
}

/** This function gives the readings of the census of one file: one reading for each region, at the time of the file. */
function censusReadings(observation: Observation, stamp: string, regions: unknown): MapResult {
  const at = addedTime(stamp);
  if (at === undefined || !isRecord(regions)) return { reports: [], problems: [{ path: "census", message: "the census has no time or no regions", fatal: true }], readings: [] };
  const readings: Reading[] = [];
  const problems: { path: string; message: string; fatal: boolean }[] = [];
  for (const [region, value] of Object.entries(regions)) {
    if (!CENSUS_REGION.test(region) || typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push({ path: `regions.${region}`, message: "the census has a region or a count that is not valid", fatal: false });
      continue;
    }
    readings.push({ source: SOURCE_ID, measure: CONFLICT_EVENTS_MEASURE, series: region, at, value, area: { type: "code", system: "state", code: region }, observation: observation.id });
  }
  return { reports: [], problems, readings };
}

/** This function maps one observation. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function gives the text of a field, or the empty string. */
function text(fields: Fields, name: string): string {
  const value = fields[name];
  return typeof value === "string" ? value.trim() : "";
}

/** This function gives the number of a field, or `undefined`. */
function number(fields: Fields, name: string): number | undefined {
  const value = fields[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The census of a file gives one reading for each region, and no report.
  if (isRecord(fields) && typeof fields["census"] === "string") return censusReadings(observation, fields["census"], fields["regions"]);
  // The head of a fetch names the newest file for the canary. It gives no report.
  if (isRecord(fields) && typeof fields["file"] === "string" && !Object.hasOwn(fields, "id")) return { reports: [], problems: [] };
  if (!isRecord(fields) || !EVENT_FIELDS.every((name) => Object.hasOwn(fields, name))) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one event of GDELT: the format changed", fatal: true }] };
  }
  const id = text(fields, "id");
  const code = text(fields, "code");
  const root = text(fields, "root");
  const lat = number(fields, "lat");
  const lon = number(fields, "lon");
  const sent = addedTime(text(fields, "added"));
  const day = dayStart(text(fields, "day"));
  const kind = root === "14" ? UNREST_KIND : ["18", "19", "20"].includes(root) ? CONFLICT_KIND : undefined;
  const problems: { path: string; message: string; fatal: boolean }[] = [];
  if (!/^\d+$/.test(id)) problems.push({ path: "id", message: "the event has no id", fatal: true });
  if (kind === undefined) problems.push({ path: "root", message: `the root code ${JSON.stringify(root)} gives no report`, fatal: true });
  if (lat === undefined || lon === undefined) problems.push({ path: "lat", message: "the event has no point", fatal: true });
  if (sent === undefined) problems.push({ path: "added", message: "the event has no time of addition", fatal: true });
  if (problems.length > 0 || kind === undefined || lat === undefined || lon === undefined || sent === undefined) return { reports: [], problems };

  const place = text(fields, "place");
  const sources = number(fields, "sources");
  const articles = number(fields, "articles");
  const actors = [text(fields, "actor1"), text(fields, "actor2")].filter((actor) => actor !== "");
  const url = text(fields, "url");
  const label = cameoLabel(code, root);
  const areas = eventAreas(lat, lon);
  const count = (value: number | undefined, one: string, many: string): string => (value === undefined ? "" : `${value} ${value === 1 ? one : many}`);
  const reach = [count(articles, "article", "articles"), count(sources, "source", "sources")].filter((part) => part !== "").join(" from ");
  const description = [
    `GDELT coded this event from the news by machine${reach === "" ? "" : `, from ${reach}`}. It is not a confirmed report.`,
    actors.length > 0 ? `Actors: ${actors.join(", ")}.` : "",
    `CAMEO code ${code}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const parameter = (value: string | number | undefined): readonly string[] => (value === undefined || value === "" ? [] : [String(value)]);
  const report: Report = {
    id: reportId({ source: SOURCE_ID, key: id, sent }),
    source: SOURCE_ID,
    origin: GDELT_ORIGIN,
    key: id,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: kind, label: kindLabel(kind) },
    categories: [categoryOf(kind)],
    severity: severityOf(code, root),
    urgency: "past",
    certainty: "possible",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: day ?? sent,
    expires: sent + REPORT_LIFE_MS,
    areas,
    about: [],
    sender: GDELT_SENDER,
    headline: place === "" ? label : `${label} in ${place}`,
    description,
    ...(/^https?:\/\//.test(url) ? { web: url } : {}),
    observation: observation.id,
    parameters: Object.fromEntries(
      Object.entries({
        cameoCode: parameter(code),
        goldstein: parameter(number(fields, "goldstein")),
        mentions: parameter(number(fields, "mentions")),
        sources: parameter(sources),
        articles: parameter(articles),
        tone: parameter(number(fields, "tone")),
        geoType: parameter(number(fields, "geoType")),
        country: parameter(text(fields, "country")),
        adm1: parameter(text(fields, "adm1")),
        featureId: parameter(text(fields, "featureId")),
        credit: [GDELT_CREDIT],
        terms: [GDELT_TERMS_URL],
      }).filter(([, values]) => values.length > 0),
    ),
  };
  return { reports: [report], problems: [] };
}
