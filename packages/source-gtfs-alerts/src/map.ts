/**
 * The map function of a GTFS Realtime feed of service alerts. The fetch gives two kinds of observation. The census of a
 * fetch gives two indicator readings. They are the count of the alerts in effect, and the count of those alerts that
 * stop a service. Each alert that has not ended gives one report of `transport.transit.service-alert`.
 *
 * The key of a report is the id of the entity of the alert. An alert has no time of its own, so the time of a report is
 * the fetch of the first observation with its text. The id of a report has no fetch time: its version is the id of the
 * observation. Thus each copy and each start of the runtime give one id to one text. A new text of an alert is a new
 * observation, and a new report with the same key. The feed is a snapshot, so an alert that leaves the feed ends its report.
 *
 * The body of an alert has no end of a period that is still to come (`stableAlert`). Some feeds move each end at each
 * fetch, for example to two hours after the fetch. Thus a report has no `expires` while its end is to come, and the
 * snapshot ends it.
 *
 * The areas of a report are the stops and the routes of its alert with a known place (`areasOf`). The box of the
 * feed is not an area of a report. The subjects of a report are the feed, its routes and its stops (`subjectsOf`). With the default
 * policy, a transit report reaches the digest at most.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Instant, type MapResult, type Observation, type Reading, type Report, type Severity, type Subject } from "@mark1russell7/alerts";
import { isRecord, timeOf, type Fields } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { boxArea, intervalOf, sourceIdOf, type GtfsFeed } from "./feed.ts";
import type { Alert, EntitySelector, TimeRange, TranslatedString } from "./proto.ts";

/** The taxonomy code of each report. */
export const GTFS_KIND = "transport.transit.service-alert";

/** The id of the measure of the count of the alerts in effect. */
export const ACTIVE_ALERTS = "active-alerts";

/** The id of the measure of the count of the alerts in effect with the effect `NO_SERVICE`. */
export const NO_SERVICE_ALERTS = "no-service-alerts";

/** The unit of the values of the two measures: a count of alerts. */
export const ALERT_UNIT = "{alert}";

/** The value of the effect `NO_SERVICE` in the GTFS Realtime reference. */
export const NO_SERVICE = 1;

/** The names of the causes of the GTFS Realtime reference, at their values. */
export const CAUSES: Readonly<Record<number, string>> = {
  1: "UNKNOWN_CAUSE",
  2: "OTHER_CAUSE",
  3: "TECHNICAL_PROBLEM",
  4: "STRIKE",
  5: "DEMONSTRATION",
  6: "ACCIDENT",
  7: "HOLIDAY",
  8: "WEATHER",
  9: "MAINTENANCE",
  10: "CONSTRUCTION",
  11: "POLICE_ACTIVITY",
  12: "MEDICAL_EMERGENCY",
};

/** The names of the effects of the GTFS Realtime reference, at their values. */
export const EFFECTS: Readonly<Record<number, string>> = {
  1: "NO_SERVICE",
  2: "REDUCED_SERVICE",
  3: "SIGNIFICANT_DELAYS",
  4: "DETOUR",
  5: "ADDITIONAL_SERVICE",
  6: "MODIFIED_SERVICE",
  7: "OTHER_EFFECT",
  8: "UNKNOWN_EFFECT",
  9: "STOP_MOVED",
  10: "NO_EFFECT",
  11: "ACCESSIBILITY_ISSUE",
};

/** The severity of a report at each severity level of the reference: `INFO`, `WARNING` and `SEVERE`. */
export const SEVERITY_LEVELS: Readonly<Record<number, Severity>> = { 2: "minor", 3: "moderate", 4: "severe" };

/** The most values of one parameter of a report. A long list of stops says little more than its start. */
export const MAX_PARAMETER_VALUES = 50;

/** The radius of the area of one stop, in kilometers: the stop and its platforms. */
export const STOP_RADIUS_KM = 0.2;

/** The system of the subject of a feed. Its id is the id of the feed. */
export const FEED_SUBJECT = "gtfs-feed";

/** The system of the subject of a route. Its id is the id of the feed, a slash and the `route_id`. */
export const ROUTE_SUBJECT = "gtfs-route";

/** The system of the subject of a stop. Its id is the id of the feed, a slash and the `stop_id`. */
export const STOP_SUBJECT = "gtfs-stop";

/** The census of one fetch of a feed: the counts of its alerts at the time of the feed. */
export interface CensusBody {
  readonly type: "census";
  readonly feed: string;
  /** The time of the feed: its header time, or the time of the fetch when the header has no time. */
  readonly at: string;
  readonly entities: number;
  readonly alerts: number;
  readonly active: number;
  readonly noService: number;
}

/** The body of one alert: the feed, the id of its entity and the alert as the decoder gives it. */
export interface AlertBody {
  readonly type: "alert";
  readonly feed: string;
  readonly entity: string;
  readonly alert: Alert;
}

/** This function gives the JSON text of a census. */
export function censusText(census: Omit<CensusBody, "type">): string {
  const body: CensusBody = { type: "census", ...census };
  return JSON.stringify(body);
}

/** This function gives the JSON text of an alert. The text has no time of the fetch, so the same alert gives the same text. */
export function alertText(feed: string, entity: string, alert: Alert): string {
  const body: AlertBody = { type: "alert", feed, entity, alert };
  return JSON.stringify(body);
}

/** This function gives the time of a value of the reference in seconds, in milliseconds. */
const millis = (seconds: number | undefined): Instant | undefined => (seconds === undefined ? undefined : seconds * 1000);

/** This function tells if a time range holds a time. An absent start or end is open. */
function holds(range: TimeRange, time: Instant): boolean {
  const start = millis(range.start);
  const end = millis(range.end);
  return (start === undefined || start <= time) && (end === undefined || time <= end);
}

/** This function tells if an alert is in effect at a time. An alert with no time range is in effect at each time. */
export function inEffect(alert: Alert, time: Instant): boolean {
  const periods = alert.activePeriod ?? [];
  return periods.length === 0 || periods.some((range) => holds(range, time));
}

/** This function tells if each time range of an alert ended before a time. An alert with no time range does not end. */
export function ended(alert: Alert, time: Instant): boolean {
  const periods = alert.activePeriod ?? [];
  return periods.length > 0 && periods.every((range) => range.end !== undefined && millis(range.end)! < time);
}

/** This function gives the start of the time range that holds a time, or else of the next time range. */
function startAt(alert: Alert, time: Instant): Instant | undefined {
  const periods = alert.activePeriod ?? [];
  const current = periods.find((range) => holds(range, time));
  if (current !== undefined) return millis(current.start);
  const starts = periods.map((range) => millis(range.start)).filter((start): start is Instant => start !== undefined && start > time);
  return starts.length === 0 ? undefined : Math.min(...starts);
}

/**
 * This function gives an alert with no end of a period that is still to come at a time. Some feeds move each end at each
 * fetch, for example to two hours after the fetch. Thus an alert with no change gives the same text at each fetch. An end
 * that passed stays, because it does not move. The fetch gives the full alert to `ended` and to the census first.
 */
export function stableAlert(alert: Alert, time: Instant): Alert {
  const periods = alert.activePeriod;
  if (periods === undefined) return alert;
  return { ...alert, activePeriod: periods.map((range) => (range.end === undefined || millis(range.end)! < time ? range : withoutEnd(range))) };
}

/** This function gives a time range with no end. */
function withoutEnd(range: TimeRange): TimeRange {
  const { end: _end, ...rest } = range;
  return rest;
}

/** This function gives the end of the last time range of an alert, or `undefined` when a time range has no end. */
function lastEnd(alert: Alert): Instant | undefined {
  const periods = alert.activePeriod ?? [];
  if (periods.length === 0 || periods.some((range) => range.end === undefined)) return undefined;
  return Math.max(...periods.map((range) => millis(range.end)!));
}

/** The languages that a reader of the reports reads first, in their order. */
const LANGUAGES = ["en"];

/** This function gives the text of a translated string in the first language of `LANGUAGES`, or with no language, or else its first text. */
export function textIn(value: TranslatedString | undefined): string | undefined {
  const translations = (value?.translation ?? []).filter((each) => each.text !== undefined && each.text.trim() !== "");
  const chosen =
    LANGUAGES.map((language) => translations.find((each) => each.language?.toLowerCase() === language)).find((each) => each !== undefined) ??
    translations.find((each) => each.language === undefined || each.language === "") ??
    translations[0];
  return chosen?.text?.trim();
}

/** This function gives the languages of the texts of an alert, with no language twice. */
function languagesOf(alert: Alert): readonly string[] {
  const all = [alert.headerText, alert.descriptionText].flatMap((value) => value?.translation ?? []).map((each) => each.language ?? "");
  return [...new Set(all.filter((language) => language !== ""))];
}

/** This function gives the values of a list with no value twice, in their order, and no more than `MAX_PARAMETER_VALUES` values. */
function distinct(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.trim() !== ""))].slice(0, MAX_PARAMETER_VALUES);
}

/** This function gives the value of a table at a number, or `undefined` when the table has no value at it. A text is not a number. */
function nameAt<T>(table: Readonly<Record<number, T>>, value: unknown): T | undefined {
  return typeof value === "number" && Object.hasOwn(table, value) ? table[value] : undefined;
}

/** This function gives the severity of an alert: from its severity level, or else `moderate` for no service and `minor` for each other effect. */
export function severityOf(alert: Alert): Severity {
  const level = nameAt(SEVERITY_LEVELS, alert.severityLevel);
  if (level !== undefined) return level;
  return alert.effect === NO_SERVICE ? "moderate" : "minor";
}

/**
 * This function gives the areas of the stops and the routes that an alert names, from the places of the feed. A known stop
 * gives a circle at the stop. Else a known route gives the box of the route. A selector with no known stop or route gives
 * no area. The function does not give the box of the feed, so an alert of an agency or of a whole network has no area.
 */
export function areasOf(feed: Pick<GtfsFeed, "places">, selectors: readonly EntitySelector[]): readonly Area[] {
  const stops = feed.places?.stops ?? {};
  const routes = feed.places?.routes ?? {};
  const areas = new Map<string, Area>();
  for (const selector of selectors) {
    const stop = selector.stopId;
    const route = selector.routeId ?? selector.trip?.routeId;
    if (stop !== undefined && Object.hasOwn(stops, stop)) areas.set(`stop:${stop}`, { type: "circle", center: stops[stop]!, radiusKm: STOP_RADIUS_KM });
    else if (route !== undefined && Object.hasOwn(routes, route)) areas.set(`route:${route}`, boxArea(routes[route]!));
  }
  return [...areas.values()].slice(0, MAX_PARAMETER_VALUES);
}

/** This function gives the routes that the selectors of an alert name: the route of a selector, or else the route of its trip. */
function routesOf(selectors: readonly EntitySelector[]): readonly string[] {
  return distinct(selectors.map((selector) => selector.routeId ?? selector.trip?.routeId));
}

/** This function gives the stops that the selectors of an alert name. */
function stopsOf(selectors: readonly EntitySelector[]): readonly string[] {
  return distinct(selectors.map((selector) => selector.stopId));
}

/**
 * This function gives the subjects of an alert: the feed, then each route and each stop that the alert names. The id of a
 * route or a stop starts with the id of the feed, because two feeds can use one id. A person can watch a line by its
 * subject. Each report has a subject, so a report with no area is valid. A subject reaches no watched place.
 */
export function subjectsOf(feed: Pick<GtfsFeed, "id" | "title">, selectors: readonly EntitySelector[]): readonly Subject[] {
  return [
    { system: FEED_SUBJECT, id: feed.id, label: feed.title },
    ...routesOf(selectors).map((route) => ({ system: ROUTE_SUBJECT, id: `${feed.id}/${route}` })),
    ...stopsOf(selectors).map((stop) => ({ system: STOP_SUBJECT, id: `${feed.id}/${stop}` })),
  ];
}

/** This function maps one observation of a feed. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(feed: GtfsFeed, observation: Observation): MapResult {
  try {
    return mapOrThrow(feed, observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(feed: GtfsFeed, observation: Observation): MapResult {
  let body: unknown;
  try {
    body = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  if (isRecord(body) && body["type"] === "census") return mapCensus(feed, observation, body);
  if (isRecord(body) && body["type"] === "alert") return mapAlert(feed, observation, body);
  return { reports: [], problems: [{ path: "", message: "the observation is not a census or an alert of a GTFS Realtime feed: the format changed", fatal: true }] };
}

/** This function gives the two readings of a census. */
function mapCensus(feed: GtfsFeed, observation: Observation, body: Fields): MapResult {
  const at = timeOf(body, "at");
  const active = body["active"];
  const noService = body["noService"];
  const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (at === undefined || !isCount(active) || !isCount(noService)) {
    return { reports: [], problems: [{ path: "", message: "the census has no time or no counts", fatal: true }], readings: [] };
  }
  const area: Reading["area"] = boxArea(feed.box);
  const reading = (measure: string, value: number): Reading => ({
    source: sourceIdOf(feed),
    measure,
    series: feed.id,
    at,
    value,
    area,
    cadence: intervalOf(feed),
    observation: observation.id,
  });
  return { reports: [], problems: [], readings: [reading(ACTIVE_ALERTS, active), reading(NO_SERVICE_ALERTS, noService)] };
}

/** This function gives the report of one alert. */
function mapAlert(feed: GtfsFeed, observation: Observation, body: Fields): MapResult {
  const problems = new Problems();
  const key = typeof body["entity"] === "string" && body["entity"].trim() !== "" ? body["entity"].trim() : undefined;
  if (key === undefined) problems.add("entity", "the entity of the alert has no id: the map makes no report", "fatal");
  const alert = isRecord(body["alert"]) ? (body["alert"] as Alert) : undefined;
  if (alert === undefined) problems.add("alert", "the observation has no alert: the map makes no report", "fatal");
  const header = textIn(alert?.headerText);
  const description = textIn(alert?.descriptionText);
  if (alert !== undefined && header === undefined && description === undefined) problems.add("alert.headerText", "the alert has no text: the map makes no report", "fatal");
  if (problems.fatal > 0 || key === undefined || alert === undefined) return { reports: [], problems: problems.list };
  if (header === undefined) problems.add("alert.headerText", "the alert has no header text: the headline names the effect", "lossy");
  return { reports: [reportOf(feed, observation, key, alert, header, description)], problems: problems.list };
}

/** This function gives the report of one valid alert. */
function reportOf(feed: GtfsFeed, observation: Observation, key: string, alert: Alert, header: string | undefined, description: string | undefined): Report {
  const sent = observation.fetched;
  const now = inEffect(alert, sent);
  const onset = startAt(alert, sent);
  const expires = lastEnd(alert);
  const effect = nameAt(EFFECTS, alert.effect);
  const cause = nameAt(CAUSES, alert.cause);
  const link = textIn(alert.url);
  const selectors = alert.informedEntity ?? [];
  const areas = areasOf(feed, selectors);
  const headline = header ?? (effect ?? "SERVICE_ALERT").toLowerCase().replaceAll("_", " ");
  return {
    id: reportId({ source: sourceIdOf(feed), key, version: observation.id }),
    source: sourceIdOf(feed),
    origin: feed.origin,
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: GTFS_KIND, label: kindLabel(GTFS_KIND) },
    categories: [categoryOf(GTFS_KIND)],
    severity: severityOf(alert),
    urgency: now ? "immediate" : "future",
    certainty: now ? "observed" : "likely",
    response: ["monitor"],
    sent,
    received: observation.fetched,
    effective: sent,
    ...(onset === undefined ? {} : { onset }),
    ...(expires === undefined ? {} : { expires }),
    areas,
    about: subjectsOf(feed, selectors),
    sender: feed.title,
    headline: `${feed.title}: ${headline}`,
    ...(description === undefined || description === header ? {} : { description }),
    ...(link !== undefined && /^https?:\/\//.test(link) ? { web: link } : {}),
    observation: observation.id,
    parameters: withValues({
      effect: distinct([effect]),
      cause: distinct([cause]),
      route: routesOf(selectors),
      stop: stopsOf(selectors),
      agency: distinct(selectors.map((selector) => selector.agencyId)),
      language: languagesOf(alert),
    }),
  };
}

/** This function removes each parameter with no value. */
function withValues(parameters: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(parameters).filter(([, values]) => values.length > 0));
}
