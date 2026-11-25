/**
 * The header of a SAME message (47 CFR 11.31). NOAA Weather Radio and the Emergency Alert System send
 * it as tones before the voice of an alert. A receiver decodes the tones to a text of this form:
 *
 * `ZCZC-ORG-EEE-PSSCCC-PSSCCC+TTTT-JJJHHMM-LLLLLLLL-`
 *
 * - `ORG` is the originator: `EAS`, `CIV`, `WXR` or `PEP`.
 * - `EEE` is the event code, for example `TOR`.
 * - Each `PSSCCC` is a location code. A header has 1 to 31 location codes.
 * - `TTTT` is the time of validity, in hours and minutes.
 * - `JJJHHMM` is the time of the issue in UTC: the day of the year, the hour and the minute.
 * - `LLLLLLLL` is the station that sent the message, for example `KEAX/NWS`.
 *
 * The text `NNNN` is the end of a message. Each header comes three times, so a receiver takes the
 * text that two of the three copies agree on (`voteSameHeader`).
 */

import { isSameCode } from "./codes.ts";

/** The originators of a SAME header, with their names in 47 CFR 11.31. */
export const SAME_ORIGINATORS: Readonly<Record<string, string>> = {
  EAS: "Broadcast station or cable system",
  CIV: "Civil authorities",
  WXR: "National Weather Service",
  PEP: "Primary Entry Point System",
};

/** The text that starts each SAME header. */
export const SAME_START = "ZCZC";

/** The text of the end of a SAME message. */
export const SAME_END = "NNNN";

/** The largest number of location codes in one SAME header. */
export const SAME_MAX_LOCATIONS = 31;

/** The parts of one SAME header. */
export interface SameHeader {
  /** The originator, for example `WXR`. */
  readonly originator: string;
  /** The event code, for example `TOR`. */
  readonly event: string;
  /** The location codes, in the order of the header. */
  readonly locations: readonly string[];
  /** The time of validity from the issue, in milliseconds. */
  readonly validMs: number;
  /** The day of the year of the issue, from 1 to 366. */
  readonly day: number;
  /** The hour of the issue in UTC. */
  readonly hour: number;
  /** The minute of the issue. */
  readonly minute: number;
  /** The station that sent the message, eight characters. */
  readonly sender: string;
}

const HEADER = /^ZCZC-([A-Z]{3})-([A-Z0-9]{3})-((?:\d{6}-){1,31})?(\d{6})\+(\d{2})(\d{2})-(\d{3})(\d{2})(\d{2})-([^-]{8})-$/;

/**
 * This function reads the text of one SAME header. It removes the spaces at the ends. A text with a different form
 * gives `undefined`. A bad time and an unknown originator also give `undefined`.
 */
export function parseSameHeader(text: string): SameHeader | undefined {
  const match = HEADER.exec(text.trim());
  if (match === null) return undefined;
  const [, originator = "", event = "", more = "", last = "", validHours = "", validMinutes = "", day = "", hour = "", minute = "", sender = ""] = match;
  if (!(originator in SAME_ORIGINATORS)) return undefined;
  const locations = [...more.split("-").filter((code) => code !== ""), last];
  if (locations.length > SAME_MAX_LOCATIONS || !locations.every(isSameCode)) return undefined;
  const numbers = { validHours: Number(validHours), validMinutes: Number(validMinutes), day: Number(day), hour: Number(hour), minute: Number(minute) };
  if (numbers.validMinutes > 59 || numbers.day < 1 || numbers.day > 366 || numbers.hour > 23 || numbers.minute > 59) return undefined;
  return {
    originator,
    event,
    locations,
    validMs: (numbers.validHours * 60 + numbers.validMinutes) * 60_000,
    day: numbers.day,
    hour: numbers.hour,
    minute: numbers.minute,
    sender,
  };
}

/**
 * This function gives the time of the issue of a header, in milliseconds since 1970. A header has no year. Thus the
 * function takes the year that puts the issue nearest to `now`. A day 366 in a year with 365 days gives `undefined`.
 */
export function sameIssuedAt(header: Pick<SameHeader, "day" | "hour" | "minute">, now: number): number | undefined {
  const year = new Date(now).getUTCFullYear();
  const times = [year - 1, year, year + 1]
    .filter((each) => header.day <= (isLeapYear(each) ? 366 : 365))
    .map((each) => Date.UTC(each, 0, header.day, header.hour, header.minute));
  return times.reduce<number | undefined>((best, time) => (best === undefined || Math.abs(time - now) < Math.abs(best - now) ? time : best), undefined);
}

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * This function gives the text that two or more copies of a header agree on, one character at a time. The copies
 * come from one message, and each copy can have errors of the radio path. A position with no majority gives
 * `undefined`. With two copies, the two copies must be equal. With one copy, the function gives `undefined`.
 */
export function voteSameHeader(copies: readonly string[]): string | undefined {
  if (copies.length < 2) return undefined;
  const length = Math.max(...copies.map((copy) => copy.length));
  const need = Math.floor(copies.length / 2) + 1;
  let text = "";
  for (let at = 0; at < length; at += 1) {
    const counts = new Map<string, number>();
    for (const copy of copies) {
      const char = copy[at];
      if (char !== undefined) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    const winner = [...counts].find(([, count]) => count >= need);
    if (winner === undefined) {
      // When a majority of the copies end before this position, the text ends here.
      return copies.filter((copy) => copy.length <= at).length >= need ? text : undefined;
    }
    text += winner[0];
  }
  return text;
}
