/**
 * The change list of an ecosystem of the OSV.dev exports: the file `<ecosystem>/modified_id.csv`. Each line is the time of
 * the last change of a record and its id, the newest first, for example `2026-11-25T16:30:05.76169863Z,MAL-2026-20607`.
 *
 * A position is a time and an id. The fetch keeps the position of the last change that it read, and reads only the
 * later changes. The order of two changes is the order of their times, then of their ids. The times have up to nine
 * digits of a second, so the order compares the full fraction, not the milliseconds of a JavaScript time.
 */

/** One line of a change list. */
export interface Change {
  /** The time of the line, as the list gives it. */
  readonly time: string;
  readonly id: string;
  /** The key of the order of the time: the date, the time to the second and the fraction of nine digits. */
  readonly order: string;
}

/** A position in a change list: the order key of a time and an id. An empty id is before each id of the same time. */
export interface Position {
  readonly order: string;
  readonly id: string;
}

/** The lines of a change list. */
export interface ChangeList {
  /** The valid lines, the newest first, as the list gives them. */
  readonly changes: readonly Change[];
  /** The count of the lines that are not a time and an id. */
  readonly invalid: number;
}

/** The changes that a fetch reads from one change list. */
export interface Selection {
  /** The changes after the position, the oldest first. */
  readonly fresh: readonly Change[];
  /** False when the read part of the list ends before the position: the list has more changes than the fetch read. */
  readonly reached: boolean;
}

/** The pattern of a time of a change list: RFC 3339 in UTC, with a fraction of a second or no fraction. */
const TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

/** The pattern of an id of a record. */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$/;

/** This function gives the order key of a time, or `undefined` for a text that is no time of a change list. */
export function orderOf(time: string): string | undefined {
  const match = TIME_PATTERN.exec(time);
  if (match === null) return undefined;
  return `${match[1]!}.${(match[2] ?? "").padEnd(9, "0")}`;
}

/** This function gives the order key of a JavaScript time. */
export function orderOfInstant(time: number): string {
  return orderOf(new Date(time).toISOString())!;
}

/** This function compares two positions. */
export function comparePositions(a: Position, b: Position): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

/**
 * This function reads the text of a change list. A cut text is the first part of the list. Its last line can be a part
 * of a line. Thus the function drops the text after the last line break.
 */
export function readChanges(text: string, cut: boolean): ChangeList {
  const end = cut ? text.lastIndexOf("\n") : text.length;
  const changes: Change[] = [];
  let invalid = 0;
  for (const line of text.slice(0, Math.max(end, 0)).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const comma = trimmed.indexOf(",");
    const time = comma < 0 ? "" : trimmed.slice(0, comma);
    const id = comma < 0 ? "" : trimmed.slice(comma + 1);
    const order = orderOf(time);
    if (order === undefined || !ID_PATTERN.test(id)) invalid += 1;
    else changes.push({ time, id, order });
  }
  return { changes, invalid };
}

/**
 * This function selects the changes of a list after a position, with an id that starts with one of the prefixes. The
 * changes come the oldest first. The list is whole, or it is cut and its oldest line is at or before the position: then
 * the selection reaches the position.
 */
export function selectChanges(list: ChangeList, after: Position, prefixes: readonly string[], cut: boolean): Selection {
  const fresh: Change[] = [];
  let reached = !cut;
  for (const change of list.changes) {
    if (comparePositions(change, after) <= 0) {
      reached = true;
      continue;
    }
    if (prefixes.some((prefix) => change.id.startsWith(prefix))) fresh.push(change);
  }
  fresh.sort(comparePositions);
  return { fresh, reached };
}

/** This function gives the text of a position in a cursor: the time key and the id, with a space between them. */
export function positionText(position: Position): string {
  return `${position.order} ${position.id}`;
}

/** This function reads the text of a position in a cursor. A text that is no position gives `undefined`. */
export function readPosition(text: string | undefined): Position | undefined {
  if (text === undefined) return undefined;
  const space = text.indexOf(" ");
  if (space < 0) return undefined;
  const order = text.slice(0, space);
  const id = text.slice(space + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}$/.test(order) || (id !== "" && !ID_PATTERN.test(id))) return undefined;
  return { order, id };
}
