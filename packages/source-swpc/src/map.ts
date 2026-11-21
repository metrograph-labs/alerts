/**
 * The map function of the SWPC source. One observation is one entry of the product list `alerts.json`. An entry has the code of
 * the list (`product_id`), the issue time (`issue_datetime`) and the text of one message (`message`). The map reads the
 * text with `parseMessage` and gives the reports of the message.
 *
 * - An alert, a warning or a summary gives one report. Its key is the code and the serial number, for example
 *   `ALTK05/2062`. An extension, a continuation or a cancel references the key of the serial number that it names.
 * - The SWPC uses a serial number again. In the archive of 2015 to 2025, 343 of the 10398 keys have two or more sent
 *   times. 338 of their gaps are above 8 days. The runtime drops an incident 7 days after its last change, so it
 *   keeps such uses apart. A replay of many years must give a new key to a key that comes back.
 * - A watch gives one report for each day that it names. A later watch states each of its days again, because the
 *   SWPC writes that it supersedes each earlier watch. The rule of the copies of the merge does this (`watchDayReport`).
 * - A geomagnetic message gives two circles: the polar caps of the geomagnetic latitude that the message names.
 * - A radio blackout, a radiation storm, an electron flux and a radio emission give no area. The sunlit side of the
 *   Earth needs the point under the Sun, and no home package has that function yet.
 */

import { categoryOf, kindLabel, Problems, reportId, type Area, type Certainty, type CorrelationKey, type Instant, type MapResult, type Observation, type Report, type Significance, type SourceId, type Urgency } from "@mark1russell7/alerts";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";
import {
  GEOMAGNETIC_STORM_KIND,
  POLEWARD_BY_LEVEL,
  polarCaps,
  RADIO_BLACKOUT_KIND,
  SEVERITY_BY_LEVEL,
  SOLAR_RADIATION_STORM_KIND,
  SPACE_WEATHER_KIND,
  type ScaleLevel,
} from "@mark1russell7/alerts-space-weather";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

import { messageTime, parseMessage, periodEnd, polewardOf, statedScale, watchDays, type Head, type MessageText, type WatchDay } from "./text.ts";

/** The id of this source. */
export const SOURCE_ID = "swpc" as SourceId;

/** The kind codes of this source. The codes and the facts of the NOAA scales are in `@mark1russell7/alerts-space-weather`. */
export const SWPC_KINDS: readonly string[] = [SPACE_WEATHER_KIND, GEOMAGNETIC_STORM_KIND, RADIO_BLACKOUT_KIND, SOLAR_RADIATION_STORM_KIND];

/** The page of the alerts, watches and warnings of the SWPC for a person. */
export const SWPC_PAGE = "https://www.spaceweather.gov/products/alerts-watches-and-warnings";

/** The sender of each report. */
export const SWPC_SENDER = "NOAA Space Weather Prediction Center";

/** The fields of an entry of the product list, in this order. */
export const ENTRY_FIELDS = ["product_id", "issue_datetime", "message"] as const;

/** The system of the correlation key that joins the days of one watch. The id is the key of the watch. */
export const WATCH_SYSTEM = "swpc-watch";

/**
 * The system of the correlation key and of the region code of one day of the geomagnetic watches. The id and the code
 * are the UTC date, for example `2026-11-17`. No place has a code of this system, so the code matches no place.
 */
export const WATCH_DAY_SYSTEM = "swpc-watch-day";

/** The groups of the products. Each group has its own kind and its own rules of time and area. */
export type Family = "geomagnetic" | "sudden-impulse" | "radio-blackout" | "radiation" | "electron" | "radio-emission";

/** The facts of one code of a product. */
export interface Product {
  readonly family: Family;
  /** The level of a NOAA scale that the code tells. A watch has the highest level of its days. */
  readonly scale?: ScaleLevel;
}

const G = (level: ScaleLevel["level"]): ScaleLevel => ({ scale: "G", level });
const S = (level: ScaleLevel["level"]): ScaleLevel => ({ scale: "S", level });
const R = (level: ScaleLevel["level"]): ScaleLevel => ({ scale: "R", level });

/**
 * The codes of the products of the SWPC, from its table of the products (`https://www.spaceweather.gov/content/subscription-services`).
 * A code with no entry gives a report of the kind `geo.space-weather` with the severity `unknown`, and a problem.
 */
export const PRODUCTS: Readonly<Record<string, Product>> = {
  ALTK04: { family: "geomagnetic" },
  WARK04: { family: "geomagnetic" },
  ALTK05: { family: "geomagnetic", scale: G(1) },
  WARK05: { family: "geomagnetic", scale: G(1) },
  ALTK06: { family: "geomagnetic", scale: G(2) },
  WARK06: { family: "geomagnetic", scale: G(2) },
  ALTK07: { family: "geomagnetic", scale: G(3) },
  WARK07: { family: "geomagnetic", scale: G(3) },
  ALTK08: { family: "geomagnetic", scale: G(4) },
  ALTK09: { family: "geomagnetic", scale: G(5) },
  WATA20: { family: "geomagnetic", scale: G(1) },
  WATA30: { family: "geomagnetic", scale: G(2) },
  WATA50: { family: "geomagnetic", scale: G(3) },
  WATA99: { family: "geomagnetic", scale: G(4) },
  SUMSUD: { family: "sudden-impulse" },
  WARSUD: { family: "sudden-impulse" },
  ALTXMF: { family: "radio-blackout", scale: R(2) },
  SUMXM5: { family: "radio-blackout", scale: R(2) },
  SUMX01: { family: "radio-blackout", scale: R(3) },
  SUMX10: { family: "radio-blackout", scale: R(4) },
  SUMX20: { family: "radio-blackout", scale: R(5) },
  ALTTP2: { family: "radio-emission" },
  ALTTP4: { family: "radio-emission" },
  SUM10R: { family: "radio-emission" },
  ALTEF3: { family: "electron" },
  ALTPX1: { family: "radiation", scale: S(1) },
  ALTPX2: { family: "radiation", scale: S(2) },
  ALTPX3: { family: "radiation", scale: S(3) },
  ALTPX4: { family: "radiation", scale: S(4) },
  ALTPX5: { family: "radiation", scale: S(5) },
  SUMPX1: { family: "radiation", scale: S(1) },
  SUMPX2: { family: "radiation", scale: S(2) },
  SUMPX3: { family: "radiation", scale: S(3) },
  SUMPX4: { family: "radiation", scale: S(4) },
  SUMPX5: { family: "radiation", scale: S(5) },
  WARPX1: { family: "radiation", scale: S(1) },
  ALTPC0: { family: "radiation" },
  SUMPC0: { family: "radiation" },
  WARPC0: { family: "radiation" },
};

/** The time in milliseconds that an alert of a flare or of a radio emission stays in effect. The R scale tells of blackouts of tens of minutes at R2. */
export const SHORT_ALERT_LIFE_MS = 3_600_000;

/**
 * The time in milliseconds that a different alert with no end stays in effect: 30 hours. The SWPC sends a continued
 * alert each day while the condition stays. The 6 hours after one day hold a late continued alert.
 */
export const ALERT_LIFE_MS: number = 30 * 3_600_000;

const DAY_MS = 86_400_000;

/** The stage of each head word. An alert tells that a value reached its threshold, so it is an observation. A cancel has the stage of the message that it ends. */
export const SIGNIFICANCE: Readonly<Record<Head, Significance>> = {
  ALERT: "observation",
  "CONTINUED ALERT": "observation",
  "CANCEL ALERT": "observation",
  WARNING: "warning",
  "EXTENDED WARNING": "warning",
  "CANCEL WARNING": "warning",
  WATCH: "watch",
  "CANCEL WATCH": "watch",
  SUMMARY: "statement",
  "CANCEL SUMMARY": "statement",
};

/** The kind code of a message from its family and its level. A geomagnetic message below G1 is not a storm. */
export function kindOf(family: Family | undefined, level: number): string {
  if (family === "geomagnetic") return level >= 1 ? GEOMAGNETIC_STORM_KIND : SPACE_WEATHER_KIND;
  if (family === "radio-blackout") return RADIO_BLACKOUT_KIND;
  if (family === "radiation") return SOLAR_RADIATION_STORM_KIND;
  return SPACE_WEATHER_KIND;
}

const ENTRY_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * This function gives the instant of the field `issue_datetime` of an entry, for example `2026-11-16 06:28:16.430`. The
 * time is UTC with no zone. Each other value gives `undefined`, and so does a time that is not in the calendar.
 */
export function entryTime(value: unknown): Instant | undefined {
  if (typeof value !== "string") return undefined;
  const match = ENTRY_TIME.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const fraction = Math.floor(Number(`0.${match[7] ?? "0"}`) * 1000);
  const time = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const date = new Date(time);
  const same = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return same ? time : undefined;
}

/** The values that each report of one message shares. */
interface Common {
  readonly message: MessageText;
  readonly observation: Observation;
  readonly productId: string;
  readonly sent: Instant;
  readonly product: Product | undefined;
}

/** The fields of a report that one rule of time gives. */
interface Timing {
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onset?: Instant;
  readonly expires: Instant;
}

/** This function reads a time field of a message. A field that is present but not a time is a lossy problem. */
function timeField(message: MessageText, name: string, problems: Problems): Instant | undefined {
  const text = message.fields.get(name);
  if (text === undefined) return undefined;
  const time = messageTime(text);
  if (time === undefined) problems.add(`message.${name}`, `the value ${JSON.stringify(text)} is not a time of the message`);
  return time;
}

/** This function reads the serial number that a field names, as the key of that message of the same code. */
function referenceOf(message: MessageText, name: string, problems: Problems): string[] {
  const text = message.fields.get(name);
  if (text !== undefined && /^\d{1,7}$/.test(text)) return [`${message.code}/${Number(text)}`];
  problems.add(`message.${name}`, `the value ${JSON.stringify(text)} is not a serial number: the report references no message`);
  return [];
}

/** This function gives the end of an alert. A K-index alert ends with its synoptic period. */
function alertEnd(common: Common, onset: Instant, problems: Problems): Instant {
  const { message, product, sent } = common;
  if (/^ALTK0\d$/.test(message.code)) {
    const text = message.fields.get("synoptic period");
    // The period holds the time of the threshold. The list can give a later issue time.
    const end = text === undefined ? undefined : periodEnd(text, onset);
    if (end !== undefined) return end;
    problems.add("message.synoptic period", `the value ${JSON.stringify(text)} is not a synoptic period: the alert ends after three hours`);
    return sent + 3 * 3_600_000;
  }
  if (product?.family === "radio-blackout" || product?.family === "radio-emission") return Math.max(onset, sent) + SHORT_ALERT_LIFE_MS;
  return sent + ALERT_LIFE_MS;
}

/** This function gives the times, the urgency and the certainty of a message that is not a watch. */
function timingOf(common: Common, problems: Problems): Timing {
  const { message, sent } = common;
  const time = (name: string): Instant | undefined => timeField(message, name, problems);
  switch (message.head) {
    case "WARNING":
    case "EXTENDED WARNING": {
      const onset = time("valid from") ?? sent;
      let expires = time("valid to") ?? time("now valid until");
      if (expires === undefined) {
        problems.add("message", "the warning has no end time: it ends after 30 hours");
        expires = sent + ALERT_LIFE_MS;
      }
      return { urgency: onset > sent ? "future" : "expected", certainty: "likely", onset, expires };
    }
    case "ALERT":
    case "CONTINUED ALERT": {
      const onset = time("threshold reached") ?? time("begin time") ?? sent;
      return { urgency: "immediate", certainty: "observed", onset, expires: alertEnd(common, onset, problems) };
    }
    case "SUMMARY": {
      const onset = time("begin time") ?? time("observed") ?? sent;
      return { urgency: "past", certainty: "observed", onset, expires: time("end time") ?? time("observed") ?? sent };
    }
    default:
      // A cancel ends at once. It is never a live head of an incident.
      return { urgency: "past", certainty: "observed", expires: sent };
  }
}

/** This function gives the level of the scale of the family of a product, or 0. */
function levelOf(product: Product | undefined, scale: ScaleLevel | undefined): number {
  if (scale === undefined || product === undefined) return 0;
  const letter = product.family === "geomagnetic" ? "G" : product.family === "radiation" ? "S" : product.family === "radio-blackout" ? "R" : undefined;
  return scale.scale === letter ? scale.level : 0;
}

/** This function gives one report. The callers give the parts that differ. */
function reportOf(
  common: Common,
  parts: { readonly key: string; readonly op: Report["op"]; readonly references: readonly string[]; readonly correlation: readonly CorrelationKey[]; readonly level: number; readonly scale: ScaleLevel | undefined; readonly timing: Timing; readonly areas: readonly Area[]; readonly latitude?: number; readonly day?: string },
): Report {
  const { message, observation, productId, sent, product } = common;
  const { scale } = parts;
  const kind = kindOf(product?.family, parts.level);
  const at = message.text.search(/^(?:ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING|CONTINUED ALERT|CANCEL [A-Z]+):/m);
  return {
    id: reportId({ source: SOURCE_ID, key: parts.key, sent }),
    source: SOURCE_ID,
    origin: NWS_ORIGIN,
    key: parts.key,
    references: parts.references,
    correlation: parts.correlation,
    status: "actual",
    op: parts.op,
    kind: { code: kind, significance: SIGNIFICANCE[message.head], label: kindLabel(kind) },
    categories: [categoryOf(kind)],
    severity: product === undefined ? "unknown" : SEVERITY_BY_LEVEL[parts.level]!,
    urgency: parts.timing.urgency,
    certainty: parts.timing.certainty,
    response: [],
    sent,
    received: observation.fetched,
    ...(parts.timing.onset === undefined ? {} : { onset: parts.timing.onset }),
    expires: parts.timing.expires,
    areas: parts.areas,
    ...(parts.latitude === undefined ? {} : { areaText: `Poleward of ${parts.latitude} degrees geomagnetic latitude` }),
    about: [],
    sender: SWPC_SENDER,
    headline: `${message.head}: ${message.title}`.trim(),
    ...(at < 0 ? {} : { description: message.text.slice(at).trim() }),
    web: SWPC_PAGE,
    observation: observation.id,
    parameters: {
      code: [message.code],
      serial: [String(message.serial)],
      product: [productId],
      ...(scale === undefined ? {} : { scale: [`${scale.scale}${scale.level}`] }),
      ...(parts.day === undefined ? {} : { day: [parts.day] }),
      ...(parts.latitude === undefined ? {} : { polewardOf: [String(parts.latitude)] }),
    },
  };
}

/**
 * This function gives the report of one day of a watch. The key is the key of the watch and the date. Two correlation
 * keys join the report to the other days of its watch, and to the reports of the same day from the other watches.
 *
 * The caps and the code of the day are in one block. The caps decide the match of a place. The code tells the merge
 * that a later watch states the day again. By the rule of the copies, the later report replaces the earlier one. A
 * day with no storm (`None (Below G1)`) gives a cancel, so it ends the forecast of an earlier watch for that day.
 * The parameter `scale` of a day is the level of that day, not the level of the code of the watch.
 */
function watchDayReport(common: Common, day: WatchDay): Report {
  const { message, sent } = common;
  const key = `${message.code}/${message.serial}/${day.date}`;
  const correlation = [
    { system: WATCH_SYSTEM, id: `${message.code}/${message.serial}` },
    { system: WATCH_DAY_SYSTEM, id: day.date },
  ];
  const code: Area = { type: "code", system: WATCH_DAY_SYSTEM, code: day.date, block: "caps" };
  const timing: Timing = { urgency: day.start > sent ? "future" : "expected", certainty: "likely", onset: day.start, expires: day.start + DAY_MS };
  if (day.level === undefined) return reportOf(common, { key, op: "cancel", references: [], correlation, level: 0, scale: undefined, timing, areas: [code], day: day.date });
  const latitude = POLEWARD_BY_LEVEL[day.level.level]!;
  return reportOf(common, { key, op: "alert", references: [], correlation, level: day.level.level, scale: day.level, timing, areas: [...polarCaps(latitude, "caps"), code], latitude, day: day.date });
}

/** This function maps one message to its reports, and can throw. `mapObservation` catches each error. */
function mapMessage(message: MessageText, productId: string, sentText: unknown, observation: Observation, problems: Problems): Report[] {
  let sent = entryTime(sentText);
  if (sent === undefined) {
    problems.add("issue_datetime", `the value ${JSON.stringify(sentText)} is not a time of the list: the sent time is the issue time of the text`);
    sent = message.issued;
  }
  // `Object.hasOwn`, so a code such as `constructor` is a plain unknown code.
  const product = Object.hasOwn(PRODUCTS, message.code) ? PRODUCTS[message.code] : undefined;
  if (product === undefined) problems.add("message", `the code ${message.code} is not known: the kind is space weather, and the severity is unknown`);
  const scale = statedScale(message) ?? product?.scale;
  const common: Common = { message, observation, productId, sent, product };

  if (message.head === "WATCH") {
    const days = watchDays(message);
    if (days === undefined) {
      problems.add("message", "the watch has no line of its days: the map makes no report", "fatal");
      return [];
    }
    return days.map((day) => watchDayReport(common, day));
  }

  const key = `${message.code}/${message.serial}`;
  const head = message.head;
  const op: Report["op"] = head.startsWith("CANCEL") ? "cancel" : head === "EXTENDED WARNING" || head === "CONTINUED ALERT" ? "update" : "alert";
  const field = head === "EXTENDED WARNING" ? "extension to serial number" : head === "CONTINUED ALERT" ? "continuation of serial number" : "cancel serial number";
  const references = op === "alert" ? [] : referenceOf(message, field, problems);
  const level = levelOf(product, scale);
  const geomagnetic = product?.family === "geomagnetic";
  const latitude = geomagnetic ? (polewardOf(message) ?? POLEWARD_BY_LEVEL[level]!) : undefined;
  const areas = latitude === undefined ? [] : polarCaps(latitude);
  return [reportOf(common, { key, op, references, correlation: [], level, scale, timing: timingOf(common, problems), areas, ...(latitude === undefined ? {} : { latitude }) })];
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let entry: unknown;
  try {
    entry = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The fetch gives the whole answer as one observation when the answer is not a list of entries.
  if (!isRecord(entry) || typeof entry["message"] !== "string") {
    return { reports: [], problems: [{ path: "", message: "the observation is not an entry of the product list: the format changed", fatal: true }] };
  }
  const parsed = parseMessage(entry["message"]);
  if (!parsed.ok) return { reports: [], problems: [{ path: "message", message: `${parsed.reason}: the map makes no report`, fatal: true }] };
  const problems = new Problems();
  const productId = typeof entry["product_id"] === "string" ? entry["product_id"] : "";
  const reports = mapMessage(parsed.message, productId, entry["issue_datetime"], observation, problems);
  return { reports, problems: problems.list };
}

/**
 * This function maps one observation of the SWPC source to the reports of its message. The body is one entry of the
 * product list. The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
