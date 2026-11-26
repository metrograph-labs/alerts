/**
 * The harm under an active alert: the join of the NCEI events with deaths or injuries and the alerts of
 * IEM (`watchwarn.ts`). The measure gives two counts for each alert kind, significance and year:
 *
 * - the alerts of the kind and the significance
 * - the deaths and injuries of the NCEI events of the kind in the county or zone of an active alert
 *
 * The second count over the first is the harm of one alert. The harm of one NCEI event is too high for
 * some kinds. NCEI enters many events of these kinds because a person was hurt.
 *
 * The functions are pure. The join reads the rows of each window one time, and it keeps no row.
 */

import { STATE_POSTAL } from "@mark1russell7/alerts";
import { PHENOMENA } from "@mark1russell7/alerts-format-nws";

import { NCEI_KINDS, nceiKind, type HarmRow, type NceiLocalTime, type YearHarm } from "./ncei.ts";
import { ALERT_SIGNIFICANCES, MARINE_PHENOMENA, MARINE_REASON, NATIONAL_NUMBERS, WATCHWARN_PARAMS, WATCHWARN_URL, type AlertCounts, type AlertSignificance, type CodeCounts, type NumberingCheck } from "./watchwarn.ts";
import { eachYear, type Years } from "./years.ts";

/**
 * The margin before the begin of an event: one hour. An alert that ends less than one hour before the begin still
 * counts. NCEI gives each time in local standard time, and an office estimates the begin from reports. In summer, a
 * local clock is one hour ahead of standard time, so one hour holds that error.
 */
export const UNDER_MARGIN_MS = 3_600_000;

/** The hours from UTC of the names of the time zones of NCEI with no number. A name with a number, for example `CST-6`, gives its number. */
export const NCEI_ZONE_HOURS: Readonly<Record<string, number>> = {
  AST: -4,
  EST: -5,
  CST: -6,
  MST: -7,
  PST: -8,
  AKST: -9,
  HST: -10,
  SST: -11,
  GST: 10,
  CHST: 10,
};

/** This function gives the hours from UTC of a time zone of NCEI, for example -6 for `CST-6`. It gives undefined for a zone that it does not know. */
export function zoneHours(text: string): number | undefined {
  const value = text.trim().toUpperCase();
  const match = /^([A-Z]+)([+-]?\d{1,2})$/.exec(value);
  if (match !== null) {
    const hours = Number(match[2]);
    return Math.abs(hours) <= 14 ? hours : undefined;
  }
  return Object.hasOwn(NCEI_ZONE_HOURS, value) ? NCEI_ZONE_HOURS[value] : undefined;
}

/** This function gives a local time of NCEI in milliseconds since the epoch, with the hours of its zone. It gives undefined for a bad time. */
export function nceiTime(time: NceiLocalTime, hours: number): number | undefined {
  if (!/^\d{6}$/.test(time.yearMonth) || !/^\d{1,2}$/.test(time.day) || !/^\d{1,4}$/.test(time.time)) return undefined;
  const year = Number(time.yearMonth.slice(0, 4));
  const month = Number(time.yearMonth.slice(4));
  const day = Number(time.day);
  const clock = time.time.padStart(4, "0");
  const hour = Number(clock.slice(0, 2));
  const minute = Number(clock.slice(2));
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return undefined;
  const local = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(local).getUTCDate() !== day) return undefined;
  return local - hours * 3_600_000;
}

/**
 * The state codes of NCEI for the territories, with their postal codes. These codes are not FIPS codes. The names come
 * from the column `STATE` of the files of 2021 and 2024.
 */
export const NCEI_TERRITORIES: Readonly<Record<string, string>> = {
  "96": "VI", // VIRGIN ISLANDS
  "97": "AS", // AMERICAN SAMOA
  "98": "GU", // GUAM
  "99": "PR", // PUERTO RICO
};

/**
 * The state codes of NCEI for the waters, with the first two letters of the UGC codes of their marine zones. The names
 * come from the column `STATE` of the files of 2021 and 2024. The area number of a water row is the number of its
 * marine zone, for example 335 in `GMZ335`.
 */
export const NCEI_WATERS: Readonly<Record<string, string>> = {
  "81": "LC", // LAKE ST CLAIR
  "83": "PM", // GUAM WATERS
  "84": "PH", // HAWAII WATERS
  "85": "GM", // GULF OF MEXICO
  "86": "PZ", // E PACIFIC
  "87": "AM", // ATLANTIC SOUTH
  "88": "AN", // ATLANTIC NORTH
  "89": "PK", // GULF OF ALASKA
  "90": "LH", // LAKE HURON
  "91": "LM", // LAKE MICHIGAN
  "92": "LS", // LAKE SUPERIOR
  "93": "SL", // ST LAWRENCE R
  "94": "LO", // LAKE ONTARIO
  "95": "LE", // LAKE ERIE
};

/** The reasons that the join cannot place a row with harm. */
export type UnplacedReason = "marine" | "area" | "time zone" | "time";

/** One NCEI event with harm, placed for the join: its UGC code and its times in milliseconds since the epoch. */
export interface HarmEvent {
  readonly id: string;
  /** The year of the file of the event. */
  readonly year: number;
  readonly type: string;
  readonly ugc: string;
  readonly begin: number;
  readonly end: number;
  readonly deaths: number;
  readonly injuries: number;
}

/** One NCEI event with harm that the join cannot place, with the reason. */
export interface UnplacedHarm {
  readonly id: string;
  readonly year: number;
  readonly type: string;
  readonly reason: UnplacedReason;
  readonly deaths: number;
  readonly injuries: number;
}

/**
 * This function places one row with harm: the UGC code of its county or zone, and its begin and end in UTC. A UGC
 * code is the postal code of the state, C or Z, and the three digits of the county or zone.
 *
 * - A row of a territory (`NCEI_TERRITORIES`) has the UGC code of the territory, for example `PRZ008`.
 * - A row of the waters (`NCEI_WATERS`) with the type Z or M has the UGC code of its marine zone.
 * - Another marine row (M) has no UGC code. Its reason is `marine`.
 * - A row with another type of area, a state code that the tables do not have or a bad number has the reason `area`.
 * - A row with a time zone that `zoneHours` does not know has the reason `time zone`.
 * - A row with a bad time, or an end before its begin, has the reason `time`.
 */
export function placeHarm(row: HarmRow, year: number): HarmEvent | UnplacedHarm {
  const base = { id: row.id, year, type: row.type, deaths: row.deaths, injuries: row.injuries };
  const code = /^\d{1,2}$/.test(row.stateFips) ? row.stateFips.padStart(2, "0") : "";
  const water = NCEI_WATERS[code];
  if (row.czType === "M" && water === undefined) return { ...base, reason: "marine" };
  const state = water ?? STATE_POSTAL[code] ?? NCEI_TERRITORIES[code];
  const type = water === undefined ? row.czType : row.czType === "Z" || row.czType === "M" ? "Z" : "";
  if ((type !== "C" && type !== "Z") || state === undefined || !/^\d{1,3}$/.test(row.czFips)) return { ...base, reason: "area" };
  const hours = zoneHours(row.timeZone);
  if (hours === undefined) return { ...base, reason: "time zone" };
  const begin = nceiTime(row.begin, hours);
  const end = nceiTime(row.end, hours);
  if (begin === undefined || end === undefined || end < begin) return { ...base, reason: "time" };
  return { ...base, ugc: `${state}${type}${row.czFips.padStart(3, "0")}`, begin, end };
}

/** This function tells if a placed or unplaced event has no reason, so the join can use it. */
export const isPlaced = (event: HarmEvent | UnplacedHarm): event is HarmEvent => !("reason" in event);

/** This function places each row with harm of the years. It throws an error when a year has no file. */
export function placeAll(harms: readonly YearHarm[], years: Years): { readonly events: HarmEvent[]; readonly unplaced: UnplacedHarm[] } {
  const events: HarmEvent[] = [];
  const unplaced: UnplacedHarm[] = [];
  for (const year of eachYear(years)) {
    const harm = harms.find((item) => item.year === year);
    if (harm === undefined) throw new Error(`The NCEI measure has no file of ${String(year)} for the join with the alerts.`);
    for (const row of harm.harmed) {
      const placed = placeHarm(row, year);
      if (isPlaced(placed)) events.push(placed);
      else unplaced.push(placed);
    }
  }
  return { events, unplaced };
}

/** The NCEI kinds: the kinds of the taxonomy that one or more event types of `NCEI_KINDS` have. */
const NCEI_KIND_SET: ReadonlySet<string> = new Set(Object.values(NCEI_KINDS).filter((kind): kind is string => kind !== null));

/**
 * This function gives the NCEI kind of an alert kind: the longest prefix of the kind that is an NCEI kind, or null. A
 * prefix ends at a dot. The shadow score takes the deaths of a kind with the same rule. For example, the kind
 * `met.flood.river` of a river flood warning gives `met.flood`, the kind of the NCEI type `Flood`.
 */
export function nceiKindOf(kind: string): string | null {
  for (let prefix = kind; ; ) {
    if (NCEI_KIND_SET.has(prefix)) return prefix;
    const dot = prefix.lastIndexOf(".");
    if (dot < 0) return null;
    prefix = prefix.slice(0, dot);
  }
}

/** This function gives the NCEI types of an NCEI kind, in order. */
export function nceiTypesOf(kind: string | null): string[] {
  return kind === null ? [] : Object.keys(NCEI_KINDS).filter((type) => NCEI_KINDS[type] === kind).sort();
}

/** One row of an alert for the join: its UGC code, its active time, its phenomenon and its significance. */
export interface ActiveRow {
  readonly ugc: string;
  readonly issue: number;
  readonly expire: number;
  readonly phenomenon: string;
  readonly significance: string;
}

/** One event of the join, with the pairs of an alert kind and a significance (`met.tornado|W`) that were active, in order. */
export interface JoinMatch {
  readonly event: HarmEvent;
  readonly under: readonly string[];
}

/**
 * A join finds the alerts that were active at each event with harm. An alert row is active at an event when two
 * conditions are true:
 *
 * - The row has the UGC code of the event.
 * - The time of the row, from `issue` to `expire`, meets the time of the event. The time of the event starts at its
 *   begin minus the margin, and it stops at its end.
 *
 * The join keeps no row: it keeps only the pairs of each event.
 */
export class HarmJoin {
  readonly #events: readonly HarmEvent[];
  readonly #byUgc = new Map<string, number[]>();
  readonly #under: Set<string>[];

  constructor(events: readonly HarmEvent[]) {
    this.#events = events;
    this.#under = events.map(() => new Set<string>());
    events.forEach((event, index) => {
      const list = this.#byUgc.get(event.ugc);
      if (list === undefined) this.#byUgc.set(event.ugc, [index]);
      else list.push(index);
    });
  }

  /** The UGC codes of the events. A row of another UGC cannot meet an event. */
  get ugcs(): ReadonlySet<string> {
    return new Set(this.#byUgc.keys());
  }

  /** This function adds one alert row. A row of a phenomenon that the NWS tables do not have throws an error. */
  add(row: ActiveRow): void {
    const indexes = this.#byUgc.get(row.ugc);
    if (indexes === undefined) return;
    const hazard = PHENOMENA[row.phenomenon];
    if (hazard === undefined) throw new Error(`The NWS tables have no phenomenon ${row.phenomenon}.`);
    for (const index of indexes) {
      const event = this.#events[index] as HarmEvent;
      if (row.issue <= event.end && row.expire >= event.begin - UNDER_MARGIN_MS) this.#under[index]?.add(`${hazard.code}|${row.significance}`);
    }
  }

  /** This function gives each event with its pairs, in the order of the events. */
  matches(): JoinMatch[] {
    return this.#events.map((event, index) => ({ event, under: [...(this.#under[index] as Set<string>)].sort() }));
  }
}

/** A count of harm: the events, and their deaths and injuries (direct plus indirect). */
export interface HarmCount {
  readonly events: number;
  readonly deaths: number;
  readonly injuries: number;
}

/** The kinds of area of an alert row: counties (`C`) and zones (`Z`). */
export type AreaType = "counties" | "zones";

/**
 * The measure of one kind of area of one alert kind and one significance. An area is one alert in one county or zone.
 * The harm is the harm of the NCEI kind under an active alert in an area of this kind. The join meets a county event
 * only with a county row. Thus the harm in counties over the areas in counties is the harm of one area.
 */
export interface AreaRate {
  /** The areas of each year. */
  readonly areas: Readonly<Record<string, number>>;
  /** The events of the NCEI kind under an active alert in an area of this kind, with their deaths and injuries, in each year. */
  readonly harm: Readonly<Record<string, HarmCount>>;
}

/** The measure of one alert kind and one significance. */
export interface UnderRate {
  /** The alerts of each year. */
  readonly alerts: Readonly<Record<string, number>>;
  /** The alerts of each phenomenon of the kind, over the years. */
  readonly phenomena: Readonly<Record<string, number>>;
  /** The events of the NCEI kind of the alert kind under an active alert, with their deaths and injuries, in each year. */
  readonly harm: Readonly<Record<string, HarmCount>>;
  /** The sums of `alerts` and `harm` over the years. */
  readonly total: { readonly alerts: number; readonly harm: HarmCount };
  /** The events of each NCEI type under an active alert, over the years. This count has each type, also of other kinds. */
  readonly byType: Readonly<Record<string, HarmCount>>;
  /** The measure of the areas in counties and in zones. The sum of their harm is `harm`. */
  readonly byArea: Readonly<Record<AreaType, AreaRate>>;
}

/** The measure of one alert kind. */
export interface UnderKind {
  /** The NCEI kind of the harm (`nceiKindOf`), or null when no NCEI type has a prefix of the kind. */
  readonly nceiKind: string | null;
  readonly nceiTypes: readonly string[];
  /** Each event with harm of the NCEI kind in each year, also each event that the join cannot place. */
  readonly ncei: Readonly<Record<string, HarmCount>>;
  /**
   * The placed events with harm of the NCEI kind in counties and in zones, over the years. NCEI enters most events of a
   * kind in one kind of area. The prior of an alert takes the measure of that kind of area.
   */
  readonly placed: Readonly<Record<AreaType, number>>;
  /** The measure of each significance with one or more alerts. */
  readonly significances: Readonly<Partial<Record<AlertSignificance, UnderRate>>>;
}

/** The section of the file of the base rates with the harm under an active alert. */
export interface UnderSection {
  readonly url: string;
  readonly years: Years;
  /** The fixed part of each query, after `url` and the times. */
  readonly params: string;
  /** The window of each request, in the form `start/end`. */
  readonly windows: readonly string[];
  readonly marginMs: number;
  readonly significances: readonly AlertSignificance[];
  readonly marine: { readonly phenomena: readonly string[]; readonly reason: string };
  /** The alerts with a national event number, and the reason (`NATIONAL_NUMBERS`). */
  readonly national: Readonly<Record<string, string>>;
  /** The check of the numbers of each pair of a phenomenon and a significance. */
  readonly numbering: Readonly<Record<string, NumberingCheck>>;
  /** The count of rows of the requests. */
  readonly rows: number;
  /** The rows with each fault. */
  readonly faults: Readonly<Record<string, number>>;
  /**
   * The distinct UGC codes of the rows of each year, in counties and in zones (`AlertCounts.codes`). A file of format 4
   * or earlier does not have them.
   */
  readonly codes?: Readonly<Record<string, CodeCounts>>;
  /** The events with harm of the years that the join cannot place, by reason. */
  readonly unplaced: Readonly<Record<string, HarmCount>>;
  /** The measure of each alert kind with one or more alerts, in the order of the codes. */
  readonly kinds: Readonly<Record<string, UnderKind>>;
}

/** The inputs of `underSection`. */
export interface UnderInput {
  readonly years: Years;
  readonly windows: readonly { readonly start: number; readonly end: number }[];
  readonly counts: AlertCounts;
  readonly matches: readonly JoinMatch[];
  readonly unplaced: readonly UnplacedHarm[];
}

type MutableCount = { events: number; deaths: number; injuries: number };
/** This function gives the kind of area of a UGC code. Its third letter is `C` for a county and `Z` for a zone. */
export const areaType = (ugc: string): AreaType => (ugc[2] === "C" ? "counties" : "zones");
const AREA_TYPES: readonly AreaType[] = ["counties", "zones"];
const zero = (): MutableCount => ({ events: 0, deaths: 0, injuries: 0 });
const addTo = (count: MutableCount, event: { readonly deaths: number; readonly injuries: number }): void => {
  count.events += 1;
  count.deaths += event.deaths;
  count.injuries += event.injuries;
};
const sorted = <T>(map: ReadonlyMap<string, T>): Record<string, T> => Object.fromEntries([...map.keys()].sort().map((key) => [key, map.get(key) as T]));
const minute = (time: number): string => new Date(time).toISOString().replace(/:00\.000Z$/, "Z");

/**
 * This function makes the section of the harm under an active alert. A pair of a phenomenon and a significance goes to
 * the kind of the phenomenon (`PHENOMENA`). Thus two phenomena of one kind add their alerts, for example `EH` and `XH`.
 * It throws an error for a pair of a phenomenon that the NWS tables do not have.
 */
export function underSection(input: UnderInput): UnderSection {
  const years = eachYear(input.years).map(String);
  const kindPairs = new Map<string, Map<AlertSignificance, string[]>>();
  for (const pair of Object.keys(input.counts.alerts)) {
    const [phenomenon = "", significance = ""] = pair.split(".");
    const hazard = PHENOMENA[phenomenon];
    if (hazard === undefined) throw new Error(`The NWS tables have no phenomenon ${phenomenon}.`);
    let bySignificance = kindPairs.get(hazard.code);
    if (bySignificance === undefined) kindPairs.set(hazard.code, (bySignificance = new Map()));
    const list = bySignificance.get(significance as AlertSignificance) ?? [];
    bySignificance.set(significance as AlertSignificance, [...list, phenomenon]);
  }

  const kinds = new Map<string, UnderKind>();
  for (const kind of [...kindPairs.keys()].sort()) {
    const ncei = nceiKindOf(kind);
    const nceiTypes = nceiTypesOf(ncei);
    const all = new Map(years.map((year) => [year, zero()]));
    const placed: Record<AreaType, number> = { counties: 0, zones: 0 };
    if (ncei !== null) {
      for (const { event } of input.matches) {
        if (nceiKind(event.type) !== ncei) continue;
        addTo(all.get(String(event.year)) as MutableCount, event);
        placed[areaType(event.ugc)] += 1;
      }
      for (const event of input.unplaced) if (nceiKind(event.type) === ncei) addTo(all.get(String(event.year)) as MutableCount, event);
    }
    const significances: Partial<Record<AlertSignificance, UnderRate>> = {};
    for (const significance of ALERT_SIGNIFICANCES) {
      const phenomena = (kindPairs.get(kind) as Map<AlertSignificance, string[]>).get(significance);
      if (phenomena === undefined) continue;
      const alerts = Object.fromEntries(years.map((year) => [year, phenomena.reduce((sum, phenomenon) => sum + (input.counts.alerts[`${phenomenon}.${significance}`]?.[year] ?? 0), 0)]));
      const totalAlerts = Object.values(alerts).reduce((sum, count) => sum + count, 0);
      if (totalAlerts === 0) continue;
      const harm = new Map(years.map((year) => [year, zero()]));
      const areaHarm = Object.fromEntries(AREA_TYPES.map((type) => [type, new Map(years.map((year) => [year, zero()]))])) as Record<AreaType, Map<string, MutableCount>>;
      const byType = new Map<string, MutableCount>();
      const total = zero();
      const key = `${kind}|${significance}`;
      for (const { event, under } of input.matches) {
        if (!under.includes(key)) continue;
        let typeCount = byType.get(event.type);
        if (typeCount === undefined) byType.set(event.type, (typeCount = zero()));
        addTo(typeCount, event);
        if (ncei !== null && nceiKind(event.type) === ncei) {
          addTo(harm.get(String(event.year)) as MutableCount, event);
          addTo(areaHarm[areaType(event.ugc)].get(String(event.year)) as MutableCount, event);
          addTo(total, event);
        }
      }
      const areaCount = (type: AreaType, year: string): number => phenomena.reduce((sum, phenomenon) => sum + (input.counts.areas[`${phenomenon}.${significance}`]?.[type][year] ?? 0), 0);
      const byArea = Object.fromEntries(
        AREA_TYPES.map((type) => [type, { areas: Object.fromEntries(years.map((year) => [year, areaCount(type, year)])), harm: Object.fromEntries(areaHarm[type]) }]),
      ) as Record<AreaType, AreaRate>;
      significances[significance] = {
        alerts,
        phenomena: Object.fromEntries([...phenomena].sort().map((phenomenon) => [phenomenon, Object.values(input.counts.alerts[`${phenomenon}.${significance}`] ?? {}).reduce((sum, count) => sum + count, 0)])),
        harm: Object.fromEntries(harm),
        total: { alerts: totalAlerts, harm: total },
        byType: sorted(byType),
        byArea,
      };
    }
    if (Object.keys(significances).length > 0) kinds.set(kind, { nceiKind: ncei, nceiTypes, ncei: Object.fromEntries(all), placed, significances });
  }

  const unplaced = new Map<string, MutableCount>();
  for (const event of input.unplaced) {
    let count = unplaced.get(event.reason);
    if (count === undefined) unplaced.set(event.reason, (count = zero()));
    addTo(count, event);
  }

  return {
    url: WATCHWARN_URL,
    years: input.years,
    params: WATCHWARN_PARAMS,
    windows: input.windows.map((window) => `${minute(window.start)}/${minute(window.end)}`),
    marginMs: UNDER_MARGIN_MS,
    significances: ALERT_SIGNIFICANCES,
    marine: { phenomena: MARINE_PHENOMENA, reason: MARINE_REASON },
    national: NATIONAL_NUMBERS,
    numbering: input.counts.numbering,
    rows: input.counts.rows,
    faults: input.counts.faults,
    codes: input.counts.codes,
    unplaced: sorted(unplaced),
    kinds: sorted(kinds),
  };
}
