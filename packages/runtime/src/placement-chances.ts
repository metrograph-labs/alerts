/**
 * The measured chances of the placement of the copies (AL-143). This module reads the incident history of the status
 * page of each provider of the offers. It gives the down share of each provider and of each region over a window, with
 * an interval. These values are chance inputs of the kind `measured` for `placementLayer` (`placement.ts`).
 *
 * The method:
 *
 * - A history is the documented list of the latest incidents of a page of Atlassian Statuspage (`readHistory` of
 *   `@mark1russell7/alerts-source-statuspage`). The list of components of the page tells which regions the page tracks.
 * - A history is also the incident file of the dashboard of Google Cloud (`readIncidentHistory` of
 *   `@mark1russell7/alerts-source-gcp`). Only an incident of a product of a plain virtual machine counts
 *   (`VM_PRODUCTS`). An incident is a down time when its impact is `SERVICE_OUTAGE` or its severity is `high`.
 * - The location `global` of a dashboard of Google is the provider, and each other location is a region. The file has
 *   no documented limit, thus the window starts at the oldest incident of the file at the earliest.
 * - The window ends at the read. It starts `DEFAULT_WINDOW_DAYS` days before, or at the oldest last change of a full list.
 *   A full list does not show an incident with an older last change, and each incident after that time changed after it.
 *   An open incident with no change after that time can be missing. This case is rare. A window of less than `MIN_WINDOW_DAYS` days gives no value.
 * - An incident is a down time when its impact is `major` or `critical` (`DOWN_IMPACTS`). An impact of `none`, `minor`
 *   or `maintenance` is not a down time, and a scheduled maintenance is not a down time at any impact.
 * - A down time lasts from the start of the incident to its resolve, or to the end of the window when it is not resolved.
 *   The time where two incidents overlap counts one time.
 * - An incident counts for a region when it names the component of that region. It counts for the provider when it
 *   names a component of no region, or no component. A component of one product in a region (a name with more words
 *   after the place) does not count: a copy operates on a plain host, not on that product.
 * - The down share is the count of hours with down time over the count of hours of the window. A part of an hour counts
 *   as a whole hour. The interval is the 95% Wilson interval (`wilson` of `@mark1russell7/rigor-statistics`). Each
 *   hour is one trial. Outages come in runs, so the hours are not independent, and the true interval is wider.
 * - The chance input is the low end of the interval of the chance that the part works. It is 1 minus the high end of
 *   the down share. Thus a short window with no outage does not give a chance of 1.
 *
 * A provider with no usable feed keeps the assumed inputs. `HISTORY_GAPS` names each such provider and the reason.
 *
 * A chance of a base can name the status page of a shared need, for example a push service (`StatusRef` of
 * `placement.ts`). `measureBase` reads the history of that page with the same method and the same pace. A page that
 * stops crawlers under `/api/` gives the JSON of its public history page (`read: "history"`). That file names no
 * component of an incident, thus a chance that names components keeps its input with that file.
 */

import { GCP_BASE, GLOBAL_LOCATION, INCIDENTS_PATH, readIncidentHistory, VM_PRODUCTS, type PastIncident } from "@mark1russell7/alerts-source-gcp";
import {
  COMPONENTS_PATH,
  HISTORY_FILE_PATH,
  HISTORY_LIMIT,
  HISTORY_PATH,
  readComponentNames,
  readHistory,
  readHistoryFile,
  type HistoryIncident,
  type HistoryRead,
} from "@mark1russell7/alerts-source-statuspage";
import { isRecord } from "@mark1russell7/optional/read";
import { wilson, Z95 } from "@mark1russell7/rigor-statistics";
import { openDatabase } from "@mark1russell7/sqlite";
import { countOf, errorMessage } from "@mark1russell7/text";
import { send, statusLine, type Pace, type Transport } from "polite-crawler/api";
import { providerFragment, regionFragment, siteFragment, type ChanceOverride, type PartChance, type PlacementBase, type PlacementChances, type StatusRef } from "./placement.ts";

/** The impacts of an incident that count as a down time: the outages of a part or of all of a service. */
export const DOWN_IMPACTS: readonly string[] = ["major", "critical"];

/** The milliseconds of one hour: one trial of the down share. */
export const HOUR_MS = 3_600_000;

/** The milliseconds of one day. */
export const DAY_MS: number = 24 * HOUR_MS;

/** The length of the window of the history when the caller gives none, in days. */
export const DEFAULT_WINDOW_DAYS = 365;

/** The shortest window that gives a measured value, in days. A shorter window gives a gap. */
export const MIN_WINDOW_DAYS = 30;

/** The User-Agent of each request for a history. It names no person and no project. */
export const MEASURE_USER_AGENT = "alerts-measure";

/** The shortest time between two requests to the host of a page, in milliseconds. */
export const HISTORY_INTERVAL_MS = 2000;

/** The kind of one component of a page: the component of a region, of one product in a region, or of no region. */
export type ComponentPlace = { readonly kind: "region"; readonly region: string } | { readonly kind: "product" } | { readonly kind: "global" };

/** The status page of one provider with a usable history, and the reader of the region of each of its components. */
export interface HistorySource {
  /** The provider of the offers, as `location.provider` of an offer. */
  readonly provider: string;
  /** The host of the status page. */
  readonly host: string;
  /**
   * The kind of the page. A page of Atlassian Statuspage (`statuspage`) tracks only the regions of its components. A
   * dashboard of Google (`google`) lists each incident of each region, thus each region of the offers gets a measure.
   */
  readonly kind: "statuspage" | "google";
  /** This function gives the kind of one component of the page from its name. */
  readonly placeOf: (component: string) => ComponentPlace;
}

/** A provider of the offers with no usable history, and the reason. */
export interface HistoryGap {
  /** The provider of the offers. */
  readonly provider: string;
  /** The reason that the provider keeps the assumed inputs. */
  readonly reason: string;
}

const CODE_PATTERN = /^([A-Za-z]{2}-[A-Za-z]+(?:-\d+)?) \(([^()]+)\)(.*)$/u;

/**
 * This function gives the kind of a component from its name. A name with the code of a region and a place, for example
 * `XX-East (Town A)`, is the region `xx-east`. The same name with more words after the place is a product of the region.
 * A name with no code is a component of no region.
 */
export function codePlace(component: string): ComponentPlace {
  const match = CODE_PATTERN.exec(component.trim());
  if (match === null) return { kind: "global" };
  return match[3]!.trim() === "" ? { kind: "region", region: match[1]!.toLowerCase() } : { kind: "product" };
}

/** This function gives the kind of a location of a dashboard of Google. The id `global` is all of the cloud, and each other id is a region. */
export function locationPlace(location: string): ComponentPlace {
  return location === GLOBAL_LOCATION ? { kind: "global" } : { kind: "region", region: location };
}

/**
 * The status page of each provider of the offers with a usable history. The Linode page of Akamai Cloud is a page of
 * Atlassian Statuspage. The first word of each of its region components is the code of a region of the plan list. The
 * dashboard of Google Cloud gives the history of the provider `gcp`. Its location ids are the region ids of the plan list.
 */
export const HISTORY_SOURCES: readonly HistorySource[] = [
  { provider: "linode", host: "status.linode.com", kind: "statuspage", placeOf: codePlace },
  { provider: "gcp", host: new URL(GCP_BASE).host, kind: "google", placeOf: locationPlace },
];

/** The providers of the offers with no usable history. They keep the assumed inputs. */
export const HISTORY_GAPS: readonly HistoryGap[] = [
  {
    provider: "vultr",
    reason: "The status page status.vultr.com gave a bot challenge (HTTP 403) to an automated read on 2026-11-24, and it documents no incident feed.",
  },
];

/** A window of time, from `from` to `to`, in milliseconds since the epoch. */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * This function gives the window of a history. The window ends at `now` and starts `days` days before. With `since`,
 * the window starts at `since` if that is later. Else, when the list is full (`HISTORY_LIMIT` items or more), the
 * window starts at the oldest last change of the list, if that is later.
 */
export function historyWindow(read: HistoryRead, now: number, days: number, since?: number): TimeWindow {
  const from = now - days * DAY_MS;
  if (since !== undefined) return { from: Math.min(Math.max(from, since), now), to: now };
  if (read.listed < HISTORY_LIMIT || read.incidents.length === 0) return { from, to: now };
  const oldest = Math.min(...read.incidents.map((incident) => incident.updated));
  return { from: Math.min(Math.max(from, oldest), now), to: now };
}

/** The longest time between two fetch events of a live copy that is up: 5 minutes. A longer gap is a down time. */
export const FETCH_GAP_MS = 300_000;

/** The shortest log that gives a measured chance of a site: 24 hours. The Wilson interval holds the doubt of a short log. */
export const MIN_LOG_HOURS = 24;

/**
 * This function gives the down time of a live copy from the times of its fetch events, in milliseconds. Each gap
 * longer than `limit` between two fetches is down, from the first fetch to the next. A gap from the last fetch to
 * `now` counts too. The copy fetches each due source in each pass, thus a long gap tells that the copy did not work.
 */
export function fetchGapTime(times: readonly number[], now: number, limit: number = FETCH_GAP_MS): number {
  let total = 0;
  const ends = [...times, now];
  for (let index = 1; index < ends.length; index += 1) {
    const gap = (ends[index] ?? 0) - (ends[index - 1] ?? 0);
    if (gap > limit) total += gap;
  }
  return total;
}

/**
 * The window of the log of a site (AL-215). Each end is optional. With no start, the window starts at the first fetch.
 * With no end, it ends at the read time. A fault before its fix and the time after the copy of a log are not in it.
 */
export interface LogWindow {
  /** The start of the window. A gap from the start to the first fetch in the window is a down time. */
  readonly from?: number | undefined;
  /** The end of the window. For a copy of a log, this is the time of the copy. */
  readonly to?: number | undefined;
}

/**
 * This function gives the measured chance input of a site from the fetch times of the log of its live copy. The window
 * starts at the first fetch and ends at `now`, or it is `window`. Only the fetches in the window count. It gives a
 * reason and no input for a window shorter than `MIN_LOG_HOURS`.
 */
export function measureSite(site: string, times: readonly number[], now: number, limit: number = FETCH_GAP_MS, window: LogWindow = {}): { readonly ok: true; readonly measure: ChanceMeasure } | { readonly ok: false; readonly reason: string } {
  const to = window.to ?? now;
  const inside = times.filter((time) => (window.from === undefined || time >= window.from) && time <= to);
  const from = window.from ?? inside[0];
  if (from === undefined || inside.length === 0 || to - from < MIN_LOG_HOURS * HOUR_MS) return { ok: false, reason: `The log of the site ${site} has less than ${String(MIN_LOG_HOURS)} hours of fetch events in its window.` };
  const span: TimeWindow = { from, to };
  const down = downShare(fetchGapTime(window.from === undefined ? inside : [from, ...inside], to, limit), span);
  const low = 1 - down.interval.high;
  const source =
    `the fetch events of the log of the site ${site} from ${dayOf(span.from)} to ${dayOf(span.to)}: ` +
    `${String(down.downHours)} of ${String(down.hours)} hours down (no fetch for more than ${String(limit / 60_000)} minutes), ` +
    `works ${(1 - down.share).toFixed(6)}, 95% Wilson interval ${low.toFixed(6)} to ${(1 - down.interval.low).toFixed(6)}, the input is the low end`;
  return { ok: true, measure: { input: { id: siteFragment(site), works: low, kind: "measured", source }, down, window: span } };
}

/**
 * This function gives the time of the last event of any type in a runtime log file, or `undefined` for a log with no
 * event. A live copy writes events all the time. Thus a last event long before the end of a window tells that the file
 * is a copy. Then the end of the window is not the time of the copy (AL-215).
 */
export function readLogEnd(path: string): number | undefined {
  const db = openDatabase(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT max(at) AS last FROM events").get();
    const last = row === undefined || row["last"] === null ? Number.NaN : Date.parse(String(row["last"]));
    return Number.isFinite(last) ? last : undefined;
  } finally {
    db.close();
  }
}

/** This function tells if a time is in a log window. A window with no end has no limit at that end. */
export function inLogWindow(time: number, window: LogWindow): boolean {
  return (window.from === undefined || time >= window.from) && (window.to === undefined || time <= window.to);
}

/** This function reads the times of the fetch events of a runtime log file, in their order. It opens the file to read only. */
export function readFetchTimes(path: string): readonly number[] {
  const db = openDatabase(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT at FROM events WHERE type = 'fetch' ORDER BY seq")
      .all()
      .map((row) => Date.parse(String(row["at"])))
      .filter((time) => Number.isFinite(time));
  } finally {
    db.close();
  }
}

/** The kinds of a failed call after which the service of a channel can be down: no answer came, or its server failed. */
export const DOWN_CALL_KINDS: readonly string[] = ["network", "timeout", "server"];

/** One call of a channel from the log of a live copy (AL-147). */
export interface CallRead {
  /** The time at which the call ended. */
  readonly time: number;
  /** True when the service answered: the call passed, or the service refused it. A refusal tells that the service works. */
  readonly answered: boolean;
  /** True when the copy had a passed fetch less than `FETCH_GAP_MS` from the call. Then the network of the copy worked. */
  readonly network: boolean;
}

/** This function reads the calls of one channel from the body of one `calls` event. A body that does not parse gives no call. */
function callReads(body: string, channel: string, limit: number): CallRead[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value["calls"])) return [];
  const network = value["network"];
  return (value["calls"] as readonly unknown[]).flatMap((call) => {
    if (!isRecord(call) || call["channel"] !== channel) return [];
    const time = call["time"];
    if (typeof time !== "number" || !Number.isFinite(time)) return [];
    const kind = call["kind"];
    const answered = typeof kind !== "string" || !DOWN_CALL_KINDS.includes(kind);
    return [{ time, answered, network: typeof network === "number" && Math.abs(time - network) <= limit }];
  });
}

/** This function reads the calls of one channel from a runtime log file, in their order. It opens the file to read only. */
export function readChannelCalls(path: string, channel: string, limit: number = FETCH_GAP_MS): readonly CallRead[] {
  const db = openDatabase(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT body FROM events WHERE type = 'calls' ORDER BY seq")
      .all()
      .flatMap((row) => callReads(String(row["body"]), channel, limit));
  } finally {
    db.close();
  }
}

/**
 * This function gives the measured chance of a channel that all copies share, from its calls in the logs of the live
 * copies (AL-147). Each hour with a counted call is one trial. A call counts when the service answered, or when it
 * failed with a kind of `DOWN_CALL_KINDS` while the network of its copy worked. An hour is down when it has a counted
 * failure and no answered call of any copy. Thus a fault of the path of one copy is not a down time of the service.
 */
export function measureChannel(chance: PartChance, calls: readonly CallRead[], now: number): PartMeasure {
  const channel = chance.channel;
  if (channel === undefined) return { ok: false, reason: "The chance names no channel." };
  const hours = new Map<number, { answered: boolean; failed: boolean }>();
  for (const call of calls) {
    if (!call.answered && !call.network) continue;
    const hour = Math.floor(call.time / HOUR_MS);
    const entry = hours.get(hour) ?? { answered: false, failed: false };
    if (call.answered) entry.answered = true;
    else entry.failed = true;
    hours.set(hour, entry);
  }
  const trials = hours.size;
  if (trials < MIN_LOG_HOURS) return { ok: false, reason: `The logs have ${countOf(trials, "hour")} with calls of the channel ${channel}, less than ${String(MIN_LOG_HOURS)}.` };
  const downHours = [...hours.values()].filter((entry) => entry.failed && !entry.answered).length;
  const keys = [...hours.keys()];
  const window: TimeWindow = { from: Math.min(...keys) * HOUR_MS, to: Math.min(now, (Math.max(...keys) + 1) * HOUR_MS) };
  const down: DownShare = { hours: trials, downHours, share: downHours / trials, interval: wilson(downHours, trials, Z95) };
  const low = 1 - down.interval.high;
  const source =
    `the calls of the channel ${channel} in the logs of the live copies from ${dayOf(window.from)} to ${dayOf(window.to)}: ` +
    `${String(downHours)} of ${String(trials)} hours with calls down (a call failed by network, time-out or server error, and no call had an answer), ` +
    `works ${(1 - down.share).toFixed(6)}, 95% Wilson interval ${low.toFixed(6)} to ${(1 - down.interval.low).toFixed(6)}, the input is the low end`;
  return { ok: true, chance: { ...chance, works: low, kind: "measured", source }, measure: { input: { id: chance.part, works: low, kind: "measured", source }, down, window } };
}

/**
 * This function measures each chance of a base that names a channel, from the calls of that channel (AL-147). `calls`
 * gives the calls of a channel from all logs. A chance with a short record keeps its input.
 */
export function measureBaseCalls(base: PlacementBase, calls: (channel: string) => readonly CallRead[], now: number): BaseMeasure {
  const chances: PartChance[] = [];
  const lines: string[] = [];
  const measures: ChanceMeasure[] = [];
  for (const chance of base.chances ?? []) {
    if (chance.channel === undefined) {
      chances.push(chance);
      continue;
    }
    const measured = measureChannel(chance, calls(chance.channel), now);
    if (measured.ok) {
      chances.push(measured.chance);
      measures.push(measured.measure);
      lines.push(`The base input ${chance.part} is measured: ${measured.chance.source}.`);
    } else {
      chances.push(chance);
      lines.push(`The base input ${chance.part} keeps its ${chance.kind} input: ${measured.reason}`);
    }
  }
  return { base: { ...base, chances }, lines, measures };
}

/** This function tells if an incident is a down time: its impact is in `DOWN_IMPACTS`, and it is not a scheduled maintenance. */
export function isDown(incident: HistoryIncident): boolean {
  return !incident.scheduled && DOWN_IMPACTS.includes(incident.impact);
}

/**
 * This function gives the down time of the incidents in a window, in milliseconds. An incident that is not resolved
 * lasts to the end of the window. The time where two incidents overlap counts one time.
 */
export function downTime(incidents: readonly HistoryIncident[], window: TimeWindow): number {
  const spans = incidents
    .map((incident) => [Math.max(incident.start, window.from), Math.min(incident.end ?? window.to, window.to)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let open: number | undefined;
  let close = 0;
  for (const [start, end] of spans) {
    if (open === undefined || start > close) {
      if (open !== undefined) total += close - open;
      open = start;
      close = end;
    } else close = Math.max(close, end);
  }
  return open === undefined ? total : total + close - open;
}

/** The down share of one part over a window. */
export interface DownShare {
  /** The count of whole hours of the window: the trials. */
  readonly hours: number;
  /** The count of hours with down time. A part of an hour counts as a whole hour. */
  readonly downHours: number;
  /** The down share: `downHours / hours`. */
  readonly share: number;
  /** The 95% Wilson interval of the down share. */
  readonly interval: { readonly low: number; readonly high: number };
}

/**
 * This function gives the down share of a down time in a window, with its 95% Wilson interval.
 *
 * @throws RangeError when the window has no whole hour.
 */
export function downShare(down: number, window: TimeWindow): DownShare {
  const hours = Math.floor((window.to - window.from) / HOUR_MS);
  if (hours < 1) throw new RangeError("The window has no whole hour.");
  const downHours = Math.min(hours, Math.ceil(down / HOUR_MS));
  return { hours, downHours, share: downHours / hours, interval: wilson(downHours, hours, Z95) };
}

/** One measured chance input of a fragment, with its down share and its window. */
export interface ChanceMeasure {
  /** The chance input of the fragment, of the kind `measured`. */
  readonly input: ChanceOverride;
  /** The down share of the fragment. */
  readonly down: DownShare;
  /** The window of the history. */
  readonly window: TimeWindow;
}

/** The history of one page: its incidents and the names of its components. */
export interface PageHistory {
  /** The incidents of the list. */
  readonly read: HistoryRead;
  /** The names of the components of the page. */
  readonly components: readonly string[];
  /** The time from which the list holds each incident, when the page tells it. */
  readonly since?: number | undefined;
}

/** The measured inputs of one provider, or the reason that it has none. */
export type ProviderMeasure = { readonly ok: true; readonly measures: readonly ChanceMeasure[] } | { readonly ok: false; readonly reason: string };

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The rule of a down time of each kind of page, for the text of a measure. */
const DOWN_RULE: Readonly<Record<HistorySource["kind"], string>> = {
  statuspage: "impact major or critical",
  google: "impact SERVICE_OUTAGE or severity high, of a product of a virtual machine",
};

/** This function gives the feed of a page: its host and the path of its list of incidents. */
export function feedOf(source: HistorySource): string {
  return `${source.host}${source.kind === "google" ? INCIDENTS_PATH : HISTORY_PATH}`;
}

/** The feed of a history and the rule of its down time, for the text of a measure. */
interface FeedRule {
  /** The host and the path of the feed. */
  readonly feed: string;
  /** The rule of a down time. */
  readonly rule: string;
}

function sourceText(feed: FeedRule, window: TimeWindow, down: DownShare): string {
  const days = Math.round((window.to - window.from) / DAY_MS);
  const low = 1 - down.interval.high;
  const high = 1 - down.interval.low;
  return (
    `${feed.feed} from ${dayOf(window.from)} to ${dayOf(window.to)} (${String(days)} days): ` +
    `${String(down.downHours)} of ${String(down.hours)} hours down (${feed.rule}), ` +
    `works ${(1 - down.share).toFixed(6)}, 95% Wilson interval ${low.toFixed(6)} to ${high.toFixed(6)}, the input is the low end`
  );
}

function measureOf(id: string, feed: FeedRule, incidents: readonly HistoryIncident[], window: TimeWindow): ChanceMeasure {
  const down = downShare(downTime(incidents, window), window);
  return { input: { id, works: 1 - down.interval.high, kind: "measured", source: sourceText(feed, window, down) }, down, window };
}

/**
 * This function gives the window of a history, or a reason when the window is shorter than `MIN_WINDOW_DAYS` days.
 * `host` names the page in the reason.
 */
export function usableWindow(history: PageHistory, host: string, now: number, days: number): { readonly ok: true; readonly window: TimeWindow } | { readonly ok: false; readonly reason: string } {
  const window = historyWindow(history.read, now, days, history.since);
  const span = (window.to - window.from) / DAY_MS;
  if (span < MIN_WINDOW_DAYS) return { ok: false, reason: `The list of ${host} covers only ${span.toFixed(1)} days, less than ${String(MIN_WINDOW_DAYS)}.` };
  return { ok: true, window };
}

/**
 * This function gives the measured inputs of one provider from the history of its page. The provider fragment gets one
 * input, and each region fragment that the page tracks gets one input. A dashboard of Google also gives one input to each
 * region of `regions`. It gives a reason and no input when the window is shorter than `MIN_WINDOW_DAYS` days.
 */
export function measureProvider(
  source: HistorySource,
  history: PageHistory,
  now: number,
  days: number = DEFAULT_WINDOW_DAYS,
  regions: readonly string[] = [],
): ProviderMeasure {
  const usable = usableWindow(history, source.host, now, days);
  if (!usable.ok) return usable;
  const { window } = usable;
  const feed: FeedRule = { feed: feedOf(source), rule: DOWN_RULE[source.kind] };
  const down = history.read.incidents.filter(isDown);
  const places = (incident: HistoryIncident): readonly ComponentPlace[] => incident.components.map(source.placeOf);
  const providerDown = down.filter((incident) => incident.components.length === 0 || places(incident).some((place) => place.kind === "global"));
  const measures = [measureOf(providerFragment(source.provider), feed, providerDown, window)];
  const tracked = history.components.flatMap((name) => {
    const place = source.placeOf(name);
    return place.kind === "region" ? [place.region] : [];
  });
  const all = source.kind === "google" ? [...tracked, ...regions] : tracked;
  for (const region of [...new Set(all)].sort()) {
    const regionDown = down.filter((incident) => places(incident).some((place) => place.kind === "region" && place.region === region));
    measures.push(measureOf(regionFragment(source.provider, region), feed, regionDown, window));
  }
  return { ok: true, measures };
}

/**
 * This function gives the chance inputs of a placement with the measured inputs. A measured input replaces the input of
 * its fragment. Each other fragment keeps the assumed input of its kind. A measured input does not replace an override of
 * the assumed inputs.
 */
export function withMeasures(chances: PlacementChances, measures: readonly ChanceMeasure[]): PlacementChances {
  const given = new Set((chances.overrides ?? []).map((item) => item.id));
  const added = measures.map((measure) => measure.input).filter((input) => !given.has(input.id));
  return { ...chances, overrides: [...(chances.overrides ?? []), ...added] };
}

/** The history of one page, or the problem of its read. */
export type HistoryOutcome = { readonly ok: true; readonly history: PageHistory } | { readonly ok: false; readonly problem: string };

async function getJson(host: string, path: string, what: string, pace: Pace, transport: Transport, signal?: AbortSignal): Promise<{ readonly body: string } | { readonly problem: string }> {
  try {
    const answer = await send(
      pace,
      transport,
      {
        source: `the status page ${host}`,
        host,
        minIntervalMs: HISTORY_INTERVAL_MS,
        what,
        exchange: { method: "GET", url: `https://${host}${path}`, headers: { accept: "application/json" }, body: null },
      },
      signal,
    );
    if (answer.reply.status !== 200) return { problem: `${what} gave ${statusLine(answer.reply)}.` };
    return { body: answer.reply.body };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { problem: `${what} failed: ${errorMessage(error)}` };
  }
}

/**
 * This function gives the history of a dashboard of Google as the history of a page. Only an incident of a product of
 * `VM_PRODUCTS` stays. Its impact is `major` when its impact is `SERVICE_OUTAGE` or its severity is `high`, else
 * `minor`. Its components are its locations. The components of the page are the locations of the kept incidents.
 */
export function googleHistory(incidents: readonly PastIncident[], since: number | undefined): PageHistory {
  const products = new Set(VM_PRODUCTS.map((product) => product.id));
  const kept: HistoryIncident[] = incidents
    .filter((incident) => incident.products.some((id) => products.has(id)))
    .map((incident) => ({
      id: incident.id,
      impact: incident.impact === "SERVICE_OUTAGE" || incident.severity === "high" ? "major" : "minor",
      start: incident.start,
      end: incident.end,
      updated: incident.start,
      scheduled: false,
      components: incident.locations,
    }));
  const components = [...new Set(kept.flatMap((incident) => incident.components))].sort();
  return { read: { listed: kept.length, incidents: kept, skipped: 0 }, components, since };
}

/**
 * This function reads the history of the page of one provider through polite-crawler. A page of Statuspage gives the
 * list of incidents, then the list of components. It sends two documented requests, with no query and no personal data.
 * The page stops crawlers under `/api/` in its `robots.txt` file. This read is not a crawl: it asks for two documented
 * files one time in a run. A dashboard of Google gives its one incident file, as the source adapter reads it.
 *
 * It does not throw for a failure of the page: it gives the problem. It throws only when the signal aborts.
 */
export async function readPageHistory(source: HistorySource, pace: Pace, transport: Transport, signal?: AbortSignal): Promise<HistoryOutcome> {
  if (source.kind === "google") {
    const file = await getJson(source.host, INCIDENTS_PATH, "the incident file", pace, transport, signal);
    if ("problem" in file) return { ok: false, problem: file.problem };
    const history = readIncidentHistory(file.body);
    if (history === undefined) return { ok: false, problem: "The incident file is not a list of incidents." };
    return { ok: true, history: googleHistory(history.incidents, history.since) };
  }
  const incidents = await getJson(source.host, HISTORY_PATH, "the list of incidents", pace, transport, signal);
  if ("problem" in incidents) return { ok: false, problem: incidents.problem };
  const read = readHistory(incidents.body);
  if (read === undefined) return { ok: false, problem: "The list of incidents is not a list of Statuspage." };
  const components = await getJson(source.host, COMPONENTS_PATH, "the list of components", pace, transport, signal);
  if ("problem" in components) return { ok: false, problem: components.problem };
  const names = readComponentNames(components.body);
  if (names === undefined) return { ok: false, problem: "The list of components is not a list of Statuspage." };
  return { ok: true, history: { read, components: names } };
}

/** The path of the feed of each kind of read of a status page of a base. */
export const STATUS_PATHS: Readonly<Record<NonNullable<StatusRef["read"]>, string>> = { api: HISTORY_PATH, history: HISTORY_FILE_PATH };

/** This function gives the feed of the status page of a base: its host and the path of its kind of read. */
export function statusFeed(status: StatusRef): string {
  return `${status.host}${STATUS_PATHS[status.read ?? "api"]}`;
}

/**
 * This function reads the history of the status page of a part of a base through polite-crawler. It sends one request:
 * the documented list of incidents (`api`), or the JSON of the public history page (`history`). The list of incidents
 * names the components of each incident, thus it needs no list of components.
 *
 * It does not throw for a failure of the page: it gives the problem. It throws only when the signal aborts.
 */
export async function readStatusHistory(status: StatusRef, pace: Pace, transport: Transport, signal?: AbortSignal): Promise<HistoryOutcome> {
  if (status.read === "history") {
    const file = await getJson(status.host, HISTORY_FILE_PATH, "the history file", pace, transport, signal);
    if ("problem" in file) return { ok: false, problem: file.problem };
    const read = readHistoryFile(file.body);
    if (read === undefined) return { ok: false, problem: "The history file is not a history file of Statuspage." };
    return { ok: true, history: { read, components: [], since: read.since } };
  }
  const incidents = await getJson(status.host, HISTORY_PATH, "the list of incidents", pace, transport, signal);
  if ("problem" in incidents) return { ok: false, problem: incidents.problem };
  const read = readHistory(incidents.body);
  if (read === undefined) return { ok: false, problem: "The list of incidents is not a list of Statuspage." };
  return { ok: true, history: { read, components: [] } };
}

/** The measured chance of one part of a base, or the reason that it keeps its input. */
export type PartMeasure = { readonly ok: true; readonly chance: PartChance; readonly measure: ChanceMeasure } | { readonly ok: false; readonly reason: string };

/**
 * This function gives the measured chance of a part of a base from the history of its status page. A down time is an
 * incident of the impact `major` or `critical` that is not a scheduled maintenance. With components, only an incident
 * that names one of them counts. The history file names no component, thus a chance with components keeps its input.
 */
export function measurePart(chance: PartChance, history: PageHistory, now: number, days: number = DEFAULT_WINDOW_DAYS): PartMeasure {
  const status = chance.status;
  if (status === undefined) return { ok: false, reason: "The chance names no status page." };
  const components = status.components ?? [];
  if (status.read === "history" && components.length > 0) {
    return { ok: false, reason: `The history file of ${status.host} names no component of an incident, thus it cannot give the down time of ${components.join(", ")}.` };
  }
  const usable = usableWindow(history, status.host, now, days);
  if (!usable.ok) return usable;
  const named = new Set(components);
  const down = history.read.incidents.filter((incident) => isDown(incident) && (named.size === 0 || incident.components.some((name) => named.has(name))));
  const rule = named.size === 0 ? DOWN_RULE.statuspage : `${DOWN_RULE.statuspage}, of the components ${components.join(", ")}`;
  const measure = measureOf(chance.part, { feed: statusFeed(status), rule }, down, usable.window);
  return { ok: true, chance: { ...chance, works: measure.input.works, kind: "measured", source: measure.input.source }, measure };
}

/** The base with its measured chances, one line for each chance of the base, and the measures. */
export interface BaseMeasure {
  /** The base. Each measured chance replaces the chance of its part. */
  readonly base: PlacementBase;
  /** One line for each chance of the base: measured or kept, and the reason. */
  readonly lines: readonly string[];
  /** The measure of each measured part, by the id of the part. */
  readonly measures: readonly ChanceMeasure[];
}

/**
 * This function measures each chance of a base that names a status page. It reads each feed one time, with the pace
 * of the caller. A chance with no status page, or with a failed read or a short window, keeps its input. It throws
 * only when the signal aborts.
 */
export async function measureBase(base: PlacementBase, pace: Pace, transport: Transport, now: number, days: number = DEFAULT_WINDOW_DAYS, signal?: AbortSignal): Promise<BaseMeasure> {
  const reads = new Map<string, HistoryOutcome>();
  const chances: PartChance[] = [];
  const lines: string[] = [];
  const measures: ChanceMeasure[] = [];
  for (const chance of base.chances ?? []) {
    const status = chance.status;
    if (status === undefined) {
      chances.push(chance);
      lines.push(`The base input ${chance.part} keeps its ${chance.kind} input: it names no status page.`);
      continue;
    }
    const feed = statusFeed(status);
    const outcome = reads.get(feed) ?? (await readStatusHistory(status, pace, transport, signal));
    reads.set(feed, outcome);
    const measured: PartMeasure = outcome.ok ? measurePart(chance, outcome.history, now, days) : { ok: false, reason: outcome.problem };
    if (measured.ok) {
      chances.push(measured.chance);
      measures.push(measured.measure);
      lines.push(`The base input ${chance.part} is measured: ${measured.chance.source}.`);
    } else {
      chances.push(chance);
      lines.push(`The base input ${chance.part} keeps its ${chance.kind} input: ${measured.reason}`);
    }
  }
  return { base: { ...base, chances }, lines, measures };
}
