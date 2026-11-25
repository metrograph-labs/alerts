/**
 * The programs of the status of the FAA: each ground stop and each ground delay program at an airport. The status gives no
 * id, no start time and no end message for a program. Thus the fetch keeps each program that it saw in the cursor. The cursor
 * keeps the time of the first status with the program, and the texts of that status. A program in each later status gives the same body
 * again, so the same observation id. A program that leaves the status leaves the cursor, and the runtime ends its report:
 * the source is a snapshot source.
 *
 * The body keeps the texts of the first status on purpose. A later text, for example a new average delay, gives no new
 * body. A new body gives a new observation id. Then the runtime ends the report and starts a new report.
 */

import type { Cursor } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { compareCodeUnits } from "@mark1russell7/text/order";

import type { Status } from "./status.ts";

/** The kind of a program. */
export type ProgramType = "ground-stop" | "ground-delay";

/** The type of the program of each list of the status. */
export const PROGRAM_LISTS: ReadonlyMap<string, ProgramType> = new Map([
  ["Ground_Stop_List", "ground-stop"],
  ["Ground_Delay_List", "ground-delay"],
]);

/** The body of the observation of one program. */
export interface ProgramBody {
  readonly program: ProgramType;
  /** The FAA location id of the airport. */
  readonly airport: string;
  /** The time of the update of the first status with the program, as an ISO 8601 text in UTC. */
  readonly since: string;
  /** The text of `Reason` in the first status, for example `WX:Thunderstorms`. */
  readonly reason?: string;
  /** The text of `Avg` of a ground delay program in the first status: the average delay of the held flights. */
  readonly averageDelay?: string;
  /** The text of `Max` of a ground delay program in the first status: the maximum delay. */
  readonly maximumDelay?: string;
  /** The text of `End_Time` of a ground stop in the first status: the planned end, as a local time. */
  readonly endTime?: string;
}

/** The fields of an entry of the status that go into a body, by the name of the field of the body. */
const ENTRY_FIELDS: readonly (readonly [keyof ProgramBody, string])[] = [
  ["reason", "Reason"],
  ["averageDelay", "Avg"],
  ["maximumDelay", "Max"],
  ["endTime", "End_Time"],
];

/** The key of a program in the cursor. */
export const programKey = (program: ProgramType, airport: string): string => `${program}:${airport}`;

/** This function reads one value of the cursor. A value that is not the body of the program `key` gives `undefined`. */
export function readProgram(key: string, value: string | undefined): ProgramBody | undefined {
  if (value === undefined) return undefined;
  let fields: unknown;
  try {
    fields = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(fields)) return undefined;
  const { program, airport, since } = fields;
  if ((program !== "ground-stop" && program !== "ground-delay") || typeof airport !== "string" || typeof since !== "string") return undefined;
  if (programKey(program, airport) !== key || !Number.isFinite(Date.parse(since))) return undefined;
  const texts = ENTRY_FIELDS.flatMap(([name]) => (typeof fields[name] === "string" ? [[name, fields[name]] as const] : []));
  return { program, airport, since, ...Object.fromEntries(texts) };
}

/** The programs of one status, in the order of their keys, and the cursor of the next fetch. */
export interface Programs {
  readonly bodies: readonly ProgramBody[];
  readonly cursor: Cursor;
}

/**
 * This function gives the programs of a status with a valid time. A program of the cursor keeps its body. A new program
 * gets the time of the status and the texts of its entry. One airport has at most one program of each type.
 */
export function programsOf(status: Status & { readonly updated: number }, cursor: Cursor | undefined): Programs {
  const since = new Date(status.updated).toISOString().replace(".000Z", "Z");
  const bodies = new Map<string, ProgramBody>();
  for (const list of status.lists) {
    const program = PROGRAM_LISTS.get(list.list);
    if (program === undefined) continue;
    for (const entry of list.entries) {
      const key = programKey(program, entry.airport);
      if (bodies.has(key)) continue;
      const texts = ENTRY_FIELDS.flatMap(([name, field]) => (entry.fields[field] === undefined || entry.fields[field] === "" ? [] : [[name, entry.fields[field]] as const]));
      bodies.set(key, readProgram(key, cursor?.[key]) ?? { program, airport: entry.airport, since, ...Object.fromEntries(texts) });
    }
  }
  const keys = [...bodies.keys()].sort(compareCodeUnits);
  return {
    bodies: keys.map((key) => bodies.get(key)!),
    cursor: Object.fromEntries(keys.map((key) => [key, JSON.stringify(bodies.get(key))])),
  };
}
