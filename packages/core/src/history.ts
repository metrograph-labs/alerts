/**
 * This module gives the history of the incidents for a time scrubber. The history of an incident has the parts of the
 * incident that this copy knew after each time of entry of its reports. The history is a pure calculation over the merge
 * state. The runtime gives it on its route `GET /history`, and a page replays how each incident grew.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, classOf, DEFAULT_ASSESS_POLICY, foreignIncidents, higherLevel, matchPlaces, reachedAssessment } from "./assess.ts";
import { isPrivate } from "./audience.ts";
import type { AssessedLevel, AssessPolicy, EndMark, Incident, Instant, Kind, MergeState, PersonWatch, PlaceId, RegionCode, Report, ReportId, Severity, Status } from "./contracts.ts";
import { compareRegionCodes, regionCodeKey, SEVERITY_ORDER, type MapPlaceInput, type MapShape, type ShapeLookup } from "./map.ts";
import { incidents, type IncidentOptions, type LinkRule } from "./merge.ts";
import { areasWithoutBlocks, distinctShapes } from "./shapes.ts";

/** The name of the format of the history payload. A change that breaks a reader gets a new name. */
export const HISTORY_FORMAT = "alerts-history/1";

/** One watched place in the areas of a change. */
export interface HistoryPlace {
  readonly id: PlaceId;
  /**
   * The highest level of the assessments with this place, over each part and each person. A matched place with no
   * assessment has the level `none`. The map uses the same rule.
   */
  readonly level: AssessedLevel;
}

/**
 * One change of an incident: the parts of the incident that this copy knew at one time. A change comes at each time of
 * entry of a report of the incident. An end mark of a known report of the incident also gives a change. A time edge
 * gives a change when the view of the incident changes at that time with no new fact. The time edges are the expiry of a
 * report, the end of the window `pastWithin` of a table and the end of a mute. Thus the view at a time is the last change
 * at or before it.
 *
 * A change has the live parts of the incident. With no live part, it has each part.
 */
export interface HistoryChange {
  /** The time of the change on this copy. */
  readonly at: Instant;
  /** The reports of the incident that came in at this time, from the smallest. A change of an end mark or of a time edge has no report. */
  readonly reports: readonly ReportId[];
  /** The highest level over each person at the time of the change, after the policy and the mutes. */
  readonly level: AssessedLevel;
  /** The highest severity of the parts at the time of the change. */
  readonly severity: Severity;
  /** False when each part ended at the time of the change. */
  readonly live: boolean;
  /** The earliest onset of the parts. */
  readonly onset?: Instant;
  /** The latest expiry of the parts. A part with no expiry gives no expiry. */
  readonly expires?: Instant;
  /** The region codes of the areas with a shape, in the order of the system and the code. The field `regions` of the payload has their shapes. */
  readonly codes: readonly RegionCode[];
  /** The polygons and the circles of the areas. Each shape comes one time. */
  readonly shapes: readonly MapShape[];
  /** The region codes of the areas with no shape in the store, in the order of the system and the code. */
  readonly unshaped: readonly RegionCode[];
  /** The watched places in the areas, in the order of the input places, each with its level. */
  readonly places: readonly HistoryPlace[];
}

/** The history of one incident of the merge state. */
export interface HistoryIncident {
  /** The anchor of the incident at the time of the payload. */
  readonly anchor: ReportId;
  /** The report ids of the incident at the time of the payload, from the smallest. */
  readonly reports: readonly ReportId[];
  readonly status: Status;
  readonly kind: Kind;
  /** The changes, from the oldest. */
  readonly changes: readonly HistoryChange[];
}

/** The shapes of one region code of the history, from the store of shapes. */
export interface HistoryRegion {
  readonly code: RegionCode;
  readonly shapes: readonly MapShape[];
}

/**
 * The answer of the history route of the runtime. The route is on the loopback address only, because the levels come
 * from the choices of the people. A reader replaces the history of each incident of the payload. It also drops each
 * history whose anchor is a report of an incident of the payload, because these incidents merged.
 */
export interface HistoryPayload {
  /** The format of the payload. A page of another format tells the reader to start the runtime of its own version. */
  readonly format: typeof HISTORY_FORMAT;
  /** The time of the history: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The payload has each incident with a change at this time or later. The value `null` gives each incident. */
  readonly since: Instant | null;
  /**
   * The newest time of a change or of a time edge of the merge state, or `null` with no change. A reader gives it as
   * `since` of its next read. A value below the `since` of the read tells that a step of the clock moved the times back.
   * Then the reader reads each incident again with no `since`.
   */
  readonly next: Instant | null;
  /** The incidents with a change at `since` or later, in the order of their anchors. Each incident has each of its changes. */
  readonly incidents: readonly HistoryIncident[];
  /** The shapes of each code of the changes of the payload, one time each, in the order of the system and the code. */
  readonly regions: readonly HistoryRegion[];
}

/**
 * The times of entry on this copy. A report or an end mark of another copy comes later than its own time. Also, the
 * clock of the other copy is not the clock of this copy. Thus the history replays what this copy knew at each time.
 */
export interface EntryTimes {
  /** This function gives the time of entry of a report on this copy. */
  report(report: Report): Instant;
  /** This function gives the time of entry of an end mark on this copy. */
  mark(mark: EndMark): Instant;
}

/** The times of entry with no import: the time of receipt of each report, and the time of each end mark. */
export const OWN_ENTRY_TIMES: EntryTimes = { report: (report) => report.received, mark: (mark) => mark.at };

/** These are the inputs of the history payload. */
export interface HistoryInput {
  /** The time of the history: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The payload gives only the incidents with a change at this time or later. The default `null` gives each incident. */
  readonly since?: Instant | null;
  /** The merge state of the copy. The history has the incidents of this state. */
  readonly merge: MergeState;
  /** The times of entry on this copy. The default `OWN_ENTRY_TIMES` reads the times of the copy that wrote each part. */
  readonly entered?: EntryTimes;
  /** The watches of the people. The level of each change is the highest level over these people. */
  readonly people: readonly PersonWatch[];
  readonly places: readonly MapPlaceInput[];
  /** The policy of the assessment: the policy of the delivery. The default is the policy of the core. */
  readonly policy?: AssessPolicy;
  /** The ids of the sources of this copy, as `RouteInput.sources` tells (AL-76). Thus the level of each change is the level of the route. */
  readonly sources?: ReadonlySet<string> | undefined;
  readonly shape: ShapeLookup;
  /** The link rule of the delivery step and the view. */
  readonly link?: LinkRule;
}

/**
 * This function gives the payload of the history route. At each time of a change, it makes the incidents of the known
 * reports of each incident, at that time. Two parts of an incident before their merge give one change: the highest
 * level and severity, and each area of the live parts. The work for an incident with no change and no time edge at
 * `since` or later is only the read of its times.
 */
export function historyPayload(input: HistoryInput): HistoryPayload {
  const since = input.since ?? null;
  const policy = input.policy ?? DEFAULT_ASSESS_POLICY;
  const mutes = input.people.flatMap((person) => (person.interests?.mutes ?? []).flatMap((mute) => (mute.until === undefined ? [] : [mute.until])));
  const entered = input.entered ?? OWN_ENTRY_TIMES;
  const options: IncidentOptions = input.link === undefined ? {} : { link: input.link };
  // Each viewer of the page sees the history, so it reads no private report and no end mark of one (AL-92, `audience.ts`).
  // A private report never joins a public one, thus the other incidents do not change.
  const reports = input.merge.reports.filter((report) => !isPrivate(report));
  const publicIds = new Set(reports.map((report) => report.id));
  const state: MergeState = { ...input.merge, reports, ends: input.merge.ends.filter((mark) => publicIds.has(mark.report)) };
  const byId = new Map(state.reports.map((report) => [report.id, report]));
  const foreign = foreignIncidents(state.reports, input.sources);
  const entries = new Map(state.reports.map((report) => [report.id, entered.report(report)]));
  // Each end mark has its time of entry. Thus the parts at a time have only the marks that this copy knew at that time.
  const marks = new Map<ReportId, EndMark[]>();
  for (const mark of state.ends) marks.set(mark.report, [...(marks.get(mark.report) ?? []), { ...mark, at: entered.mark(mark) }]);
  // The time edges count up to the horizon: the time of the payload, or the newest time of entry when it is later. A take
  // of the exchange after the last pass gives a later time of entry. Thus a later read finds each new edge after its since.
  let horizon = input.at ?? Number.NEGATIVE_INFINITY;
  for (const time of entries.values()) if (time > horizon) horizon = time;
  for (const list of marks.values()) for (const mark of list) if (mark.at > horizon) horizon = mark.at;
  const lookups = new Map<string, readonly MapShape[] | undefined>();
  const lookup = (code: RegionCode): readonly MapShape[] | undefined => {
    const key = regionCodeKey(code);
    if (!lookups.has(key)) lookups.set(key, input.shape(code));
    return lookups.get(key);
  };

  let next: Instant | null = null;
  const shown: HistoryIncident[] = [];
  // The groups of the reports do not read the time. Thus the time of the current incidents changes nothing.
  for (const incident of incidents(state, input.at ?? 0, options)) {
    const own = incident.reports.flatMap((id) => byId.get(id) ?? []);
    const ownMarks = incident.reports.flatMap((id) => marks.get(id) ?? []);
    const entryTimes = [...own.map((report) => entries.get(report.id)!), ...ownMarks.map((mark) => mark.at)];
    if (entryTimes.length === 0) continue;
    const first = Math.min(...entryTimes);
    // The time edges count after the first entry, up to the horizon. A later edge comes in a later read.
    const edges = new Set(timeEdges(own, policy, mutes).filter((time) => time > first && time <= horizon));
    const times = [...new Set([...entryTimes, ...edges])].sort((a, b) => a - b);
    const last = times.at(-1)!;
    if (next === null || last > next) next = last;
    if (since !== null && last < since) continue;
    const changes: HistoryChange[] = [];
    for (const at of times) {
      const known = own.filter((report) => entries.get(report.id)! <= at);
      if (known.length === 0) continue;
      const came = known.filter((report) => entries.get(report.id) === at).map((report) => report.id);
      const marked = new Set(ownMarks.filter((mark) => mark.at === at).map((mark) => mark.report));
      const fact = came.length > 0 || known.some((report) => marked.has(report.id));
      if (!fact && !edges.has(at)) continue;
      const parts = incidents({ ...state, reports: known, ends: ownMarks }, at, options);
      const change = changeOf(at, parts, came.sort(compareCodeUnits), input, lookup, foreign);
      const previous = changes.at(-1);
      // A time edge with no new fact gives a change only when the view changes.
      if (!fact && previous !== undefined && sameView(previous, change)) continue;
      changes.push(change);
    }
    shown.push({ anchor: incident.anchor, reports: incident.reports, status: incident.status, kind: incident.kind, changes });
  }

  const regions = new Map<string, HistoryRegion>();
  for (const change of shown.flatMap((incident) => incident.changes)) {
    for (const code of change.codes) {
      const key = regionCodeKey(code);
      if (!regions.has(key)) regions.set(key, { code, shapes: distinctShapes(lookup(code) ?? []) });
    }
  }
  return { format: HISTORY_FORMAT, at: input.at, since, next, incidents: shown, regions: [...regions.values()].sort((a, b) => compareRegionCodes(a.code, b.code)) };
}

/**
 * The time edges of the reports: the times at which the view can change with no new fact. They are the expiry of each
 * report, the end of the window `pastWithin` of its table and the end of each mute. When each report has an expiry, no
 * part is live after the last expiry. Thus no later edge counts.
 */
function timeEdges(reports: readonly Report[], policy: AssessPolicy, mutes: readonly Instant[]): Instant[] {
  const expiries = reports.flatMap((report) => (report.expires === undefined ? [] : [report.expires]));
  const end = expiries.length === reports.length && expiries.length > 0 ? Math.max(...expiries) : Number.POSITIVE_INFINITY;
  const pasts = reports.flatMap((report) => {
    const span = (classOf(policy, report.kind.code) ?? policy.otherwise).pastWithin;
    // The window holds while the age is `span` or less. Thus the level changes one millisecond after its end.
    return report.urgency === "past" && span !== undefined && report.onset !== undefined ? [report.onset + span + 1] : [];
  });
  return [...expiries, ...pasts, ...mutes].filter((time) => time <= end);
}

// Two changes give the same view when each field other than the time and the reports is the same.
function sameView(a: HistoryChange, b: HistoryChange): boolean {
  return JSON.stringify({ ...a, at: 0, reports: [] }) === JSON.stringify({ ...b, at: 0, reports: [] });
}

// The change of the parts of one incident at a time. The map shows only live incidents, thus the change has only the live
// parts. With no live part, the change has each part, and the reader does not show it.
function changeOf(
  at: Instant,
  all: readonly Incident[],
  reports: readonly ReportId[],
  input: HistoryInput,
  lookup: ShapeLookup,
  foreign: (part: Incident) => boolean,
): HistoryChange {
  const live = all.filter((part) => part.live);
  const parts = live.length > 0 ? live : all;
  let level: AssessedLevel = "none";
  const placeLevels = new Map<PlaceId, AssessedLevel>();
  for (const part of parts) {
    for (const match of matchPlaces(part, input.places)) if (!placeLevels.has(match.place)) placeLevels.set(match.place, "none");
    for (const person of input.people) {
      const assessment = reachedAssessment(assess(part, person, input.places, input.policy, at, foreign(part)));
      level = higherLevel(level, assessment.level);
      for (const id of assessment.places) placeLevels.set(id, higherLevel(placeLevels.get(id) ?? "none", assessment.level));
    }
  }
  const severity = parts.map((part) => part.severity).reduce((a, b) => (SEVERITY_ORDER.indexOf(b) < SEVERITY_ORDER.indexOf(a) ? b : a));
  const onsets = parts.flatMap((part) => (part.onset === undefined ? [] : [part.onset]));
  const expiries = parts.map((part) => part.expires);
  const codes = new Map<string, RegionCode>();
  const unshaped = new Map<string, RegionCode>();
  const shapes: MapShape[] = [];
  for (const area of areasWithoutBlocks(parts.flatMap((part) => part.areas))) {
    if (area.type === "polygon" || area.type === "circle") shapes.push(area);
    else if (area.type === "code") {
      const code = { system: area.system, code: area.code };
      const found = lookup(code);
      (found === undefined || found.length === 0 ? unshaped : codes).set(regionCodeKey(code), code);
    }
  }
  return {
    at,
    reports,
    level,
    severity,
    live: live.length > 0,
    ...(onsets.length === 0 ? {} : { onset: Math.min(...onsets) }),
    ...(expiries.some((expires) => expires === undefined) ? {} : { expires: Math.max(...expiries.map((expires) => expires!)) }),
    codes: [...codes.values()].sort(compareRegionCodes),
    shapes: distinctShapes(shapes),
    unshaped: [...unshaped.values()].sort(compareRegionCodes),
    places: input.places.flatMap((place) => {
      const found = placeLevels.get(place.id);
      return found === undefined ? [] : [{ id: place.id, level: found }];
    }),
  };
}
