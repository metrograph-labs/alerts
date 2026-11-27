/**
 * This module holds the log of the runtime: an append-only event log in one SQLite file, on
 * `@mark1russell7/sqlite`. The file is in WAL mode, with `synchronous` at `FULL`, thus an event that
 * the log accepted stays after a power cut.
 */
import { basename } from "node:path";
import type { Instant } from "@mark1russell7/alerts";
import { listRecoveries, openCheckedEventLog, openEventLog, type EventLogFile, type RecoveryEntry } from "@mark1russell7/sqlite";
import { envelope, EVENT_TYPES, parseEvent, type RecoveredEvent, type RuntimeEvent } from "./events.ts";
import { blockingCheckDue, logCheckPath, readLogCheckFile } from "./log-check.ts";

/** One event of the log with its position. The position of a later event is larger. */
export interface RuntimeLogEntry {
  readonly seq: number;
  readonly event: RuntimeEvent;
}

/** The options of a read of entries. */
export interface EntriesOptions {
  /** The read gives only the entries after this position. */
  readonly after: number;
  /** The read gives only the events of these types. */
  readonly types: readonly RuntimeEvent["type"][];
  /** The highest count of entries that the read gives. */
  readonly limit: number;
}

/** The log of the runtime. */
export interface RuntimeLog {
  /**
   * This function gives the events of the log, in their order. It gives only the types of `EVENT_TYPES`, or the types
   * `types` when the call gives them. A later build can add a type, and this build then skips its events. Thus a rollback
   * to this build starts on the log of a later build. With `after`, it gives only the events after that position.
   */
  read(types?: readonly RuntimeEvent["type"][], after?: number): Iterable<RuntimeEvent>;
  /** This function gives the count of the events of the log. */
  count(): number;
  /** This function gives the count of the events of each type, also of the types that this build does not know. It parses no event. */
  counts(): ReadonlyMap<string, number>;
  /** This function gives the entries of the log after a position, in their order. */
  entries(options: EntriesOptions): Iterable<RuntimeLogEntry>;
  /** This function gives the position of the last event, or 0 for an empty log. */
  head(): number;
  /** This function tells if the log has an event with an id. */
  has(id: string): boolean;
  /** This function gives the event with an id and its position, or undefined when the log has no event with the id. */
  get(id: string): RuntimeLogEntry | undefined;
  /**
   * This function appends events in one transaction. `accept` gets each new event before the write,
   * in order. An event with an id that the log has changes nothing, and `accept` does not get it.
   * The function gives the ids of the events that are different from the event of the log with the same
   * id. The log keeps its own event, and it writes the other events of the call. When a write fails, the
   * function throws, and nothing changed.
   */
  appendAll(events: readonly RuntimeEvent[], accept: (event: RuntimeEvent) => void): readonly string[];
  close(): void;
}

/** The options of the file. */
export interface RuntimeLogOptions {
  /** The milliseconds that a write waits for a lock of another connection. The default is 5000. */
  readonly busyTimeoutMs?: number;
}

/** The count of the problems of the check and of the salvage that a `recovered` event keeps. */
export const RECOVERY_PROBLEMS = 10;

/** This function opens the log in a file, and makes the file and its folder when they are not there. */
export function openRuntimeLog(path: string, options: RuntimeLogOptions = {}): RuntimeLog {
  return runtimeLog(openEventLog(path, parseEvent, fileOptions(options)));
}

/** The options of `openCheckedRuntimeLog`. */
export interface CheckedLogOptions extends RuntimeLogOptions {
  /** This clock gives the time of the `recovered` event and of the name of the quarantine folder. */
  readonly now: () => Instant;
}

/** The result of `openCheckedRuntimeLog`. */
export interface CheckedLog {
  readonly log: RuntimeLog;
  /** This value is the event of the recovery, or `undefined` when the file passed its check. */
  readonly recovered: RecoveredEvent | undefined;
  /**
   * This value tells if the open did the integrity check, or made a new file (AL-223). When it is `false`, the open did
   * no check, because the state file of the check tells that the last check passed.
   */
  readonly checked: boolean;
}

/**
 * This function opens the log at the boot of the runtime, with `openCheckedEventLog` of `@mark1russell7/sqlite`. It
 * checks the file with `PRAGMA quick_check` first. A broken file goes into a quarantine folder `<name>.broken-<time>`
 * next to it. Then a new file gets each event that the salvage reads.
 *
 * The check reads the whole file, thus it is slow on a large log (AL-223). The open does no check when the state file
 * `<name>.check.json` tells that the last check passed. Then the check comes after the start (`log-check.ts`). A state
 * file with `running` or `failed`, a bad state file and no state file give the check before the open. With no check, a
 * file that is not a database still goes into quarantine, and so does a WAL file with no database file.
 *
 * Each quarantine folder of the log gives one `recovered` event, with the folder name in its id. The fold of that
 * event gives a system report that names the quarantine. The function appends the event of each folder at each open,
 * thus a crash before the append loses no event. An event that the log has changes nothing.
 *
 * A fault that is not a broken file, for example a lock, goes to the caller. The broken file does not change.
 *
 * @param path - The path of the log file.
 * @param options - The clock of the recovery and the options of the file.
 */
export function openCheckedRuntimeLog(path: string, options: CheckedLogOptions): CheckedLog {
  const memory = path === ":memory:" || path === "";
  const open = { ...fileOptions(options), quarantine: { now: new Date(options.now()) } };
  const opened = memory || blockingCheckDue(readLogCheckFile(logCheckPath(path))) ? openCheckedEventLog(path, parseEvent, open) : openCheckedEventLog(path, parseEvent, { ...open, check: false });
  const checked = opened.kind !== "unchecked";
  const log = runtimeLog(opened.log);
  let events: readonly RecoveredEvent[];
  try {
    events = memory ? [] : listRecoveries(path).map((entry) => recoveredEvent(entry, options.now));
    log.appendAll(events, () => undefined);
  } catch (error) {
    log.close();
    throw error;
  }
  if (opened.kind !== "recovered" && opened.kind !== "orphan-journal") return { log, recovered: undefined, checked };
  const id = `recovered:${basename(opened.quarantined.folder)}`;
  return { log, recovered: events.find((event) => event.id === id), checked };
}

// The problem of a quarantine of a WAL, SHM or journal file with no database file.
const ORPHAN_PROBLEM = "The folder of the log had a WAL, SHM or journal file, but no database file.";

// The recovered event of one quarantine folder. A record with no time gives the time of the clock.
function recoveredEvent(entry: RecoveryEntry, now: () => Instant): RecoveredEvent {
  const id = `recovered:${entry.id}`;
  const time = entry.kind === "no-read" || !Number.isFinite(Date.parse(entry.at)) ? now() : Date.parse(entry.at);
  if (entry.kind === "recovered") {
    const { cause, salvage } = entry;
    return {
      ...envelope("recovered", id, time),
      quarantine: entry.id,
      fault: cause.kind === "fault" ? cause.fault.kind : "corrupt",
      read: salvage.kept,
      added: salvage.kept,
      lost: salvage.lost,
      whole: salvage.problems.length === 0 && salvage.lost === 0,
      problems: [...(cause.kind === "integrity" ? cause.integrity.problems : [cause.fault.message]), ...salvage.problems].slice(0, RECOVERY_PROBLEMS),
    };
  }
  const empty = { quarantine: entry.id, read: 0, added: 0, lost: 0, whole: false };
  if (entry.kind === "orphan-journal") return { ...envelope("recovered", id, time), ...empty, fault: "orphan-journal", problems: [ORPHAN_PROBLEM] };
  return { ...envelope("recovered", id, time), ...empty, fault: "no-read", problems: [entry.problem] };
}

// The options of the file of the log: a new folder when it is not there, and a wait for the lock of another connection.
function fileOptions(options: RuntimeLogOptions): { readonly makeFolder: true; readonly busyTimeoutMs: number } {
  return { makeFolder: true, busyTimeoutMs: options.busyTimeoutMs ?? 5000 };
}

// The log of the runtime on an event log file.
function runtimeLog(log: EventLogFile<RuntimeEvent>): RuntimeLog {
  return {
    // The filter is on the type of the row, thus the parse does not get a type that this build does not know.
    read: (types = EVENT_TYPES, after) => log.read({ types, after }),
    count: () => log.count(),
    counts: () => log.counts(),
    entries: (options) => log.entries(options),
    head: () => log.head(),
    has: (id) => log.get(id) !== undefined,
    get: (id) => log.get(id),
    appendAll(events, accept) {
      let results;
      try {
        results = log.appendAll(events, (event) => {
          accept(event);
          return undefined;
        });
      } catch (error) {
        // The transaction rolled back. The log is usable again after `recover`, and the caller keeps its old state.
        log.recover();
        throw error;
      }
      return results.flatMap((result, at) => (result.kind === "conflict" ? [events[at]!.id] : []));
    },
    close: () => log.close(),
  };
}
