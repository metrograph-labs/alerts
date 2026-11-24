/**
 * The reader of the airport status of the FAA (`nasstatus.faa.gov/api/airport-status-information`). The answer is one XML
 * document with the time of the update and one block for each kind of program. The kinds are ground stops, ground delay
 * programs, delays of arrivals and departures, closures and others. The reader takes the FAA location id of each airport in each
 * list, by the element `ARPT`. Thus a new field of an entry does not stop it.
 */

import type { Instant } from "@mark1russell7/alerts";

/** The root element of the answer. */
export const STATUS_ROOT = "AIRPORT_STATUS_INFORMATION";

/** The lists that hold flights at an airport: a ground stop or a ground delay program. */
export const HELD_LISTS: readonly string[] = ["Ground_Stop_List", "Ground_Delay_List"];

/** The lists that delay flights at an airport. They are the lists that hold flights and the delays of arrivals and departures. */
export const DELAY_LISTS: readonly string[] = [...HELD_LISTS, "Arrival_Departure_Delay_List"];

/**
 * The lists that the census does not count. A closure in the status is a notice to airmen that can run for months, for
 * example a closure to some private aircraft. An airspace flow program holds flights through an area of airspace, not at
 * one airport.
 */
export const IGNORED_LISTS: readonly string[] = ["Airport_Closure_List", "Airspace_Flow_List"];

/**
 * One entry of a list: the airport and the text of each other child element, for example `Reason`, `Avg`, `Max` and
 * `End_Time`. The texts are free: the FAA gives times as local texts, for example `7:30 pm EST`.
 */
export interface StatusEntry {
  readonly airport: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** One block of the status: the element name of its list, its title and the airports of its entries. */
export interface StatusList {
  readonly list: string;
  readonly name: string;
  readonly airports: readonly string[];
  /** The entries with an airport, in the order of the list. */
  readonly entries: readonly StatusEntry[];
}

/** The status of one answer. */
export interface Status {
  /** The time of the update, or `undefined` when the field `Update_Time` is not a valid time. */
  readonly updated: Instant | undefined;
  readonly lists: readonly StatusList[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** This function gives the time of a text of the field `Update_Time`, for example `Tue Nov 24 17:13:45 2026 GMT`. Each other text gives `undefined`. */
export function updateTime(text: string): Instant | undefined {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/.exec(text.trim());
  if (match === null) return undefined;
  const [, month, day, hour, minute, second, year] = match;
  const index = MONTHS.indexOf(month ?? "");
  if (index < 0) return undefined;
  const time = Date.UTC(Number(year), index, Number(day), Number(hour), Number(minute), Number(second));
  // A day that is not in the month, for example 31 November, moves to the next month: it is not valid.
  return new Date(time).getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 ? time : undefined;
}

/** This function gives the text of the first element `name` in `xml`, or `undefined`. */
function textOf(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

/**
 * This function gives the entries of the inner text of one block. An entry is an element whose children are only text
 * elements and include `ARPT`. A nested element, for example the airspace of a flow program, gives no entry.
 */
function entriesOf(inner: string): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const match of inner.matchAll(/<([A-Za-z_]+)>((?:\s*<[A-Za-z_]+>[^<]*<\/[A-Za-z_]+>)+)\s*<\/\1>/g)) {
    const fields: Record<string, string> = {};
    for (const child of (match[2] ?? "").matchAll(/<([A-Za-z_]+)>([^<]*)<\/\1>/g)) fields[child[1] ?? ""] = (child[2] ?? "").trim();
    const airport = fields["ARPT"]?.toUpperCase();
    if (airport === undefined || airport === "") continue;
    delete fields["ARPT"];
    entries.push({ airport, fields });
  }
  return entries;
}

/**
 * This function reads one answer. It gives `undefined` when the text is not a whole document of the status: no root, or
 * no end of the root. A cut answer gives `undefined`.
 */
export function readStatus(xml: string): Status | undefined {
  const start = xml.indexOf(`<${STATUS_ROOT}>`);
  const end = xml.lastIndexOf(`</${STATUS_ROOT}>`);
  if (start < 0 || end < start) return undefined;
  const body = xml.slice(start, end);
  const update = textOf(body, "Update_Time");
  const lists: StatusList[] = [];
  for (const block of body.matchAll(/<Delay_type>([\s\S]*?)<\/Delay_type>/g)) {
    const inner = block[1] ?? "";
    const list = /<([A-Za-z_]+_List)>/.exec(inner)?.[1] ?? "";
    const airports = [...inner.matchAll(/<ARPT>([^<]*)<\/ARPT>/g)].map((match) => (match[1] ?? "").trim().toUpperCase());
    lists.push({ list, name: (textOf(inner, "Name") ?? "").trim(), airports, entries: entriesOf(inner) });
  }
  return { updated: update === undefined ? undefined : updateTime(update), lists };
}
