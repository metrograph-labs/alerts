/**
 * This module holds the events of the log of the runtime. The state of the runtime is a fold of these
 * events and the configuration, and of nothing else. Thus a restart reads the log and gets the same
 * state as a run with no restart.
 */
import type {
  Acknowledgment,
  ChannelFailureKind,
  ChannelId,
  Cursor,
  Delivery,
  Duration,
  EscalationEnd,
  EscalationHold,
  EscalationStart,
  FetchRecord,
  Instant,
  MapProblem,
  Observation,
  Report,
  ReportId,
  ShadowScore,
  SourceId,
  Suppression,
} from "@mark1russell7/alerts";

// The kind of a failed call of a channel has its home in the core. The runtime gives it again, as before.
export type { ChannelFailureKind };

/** The kinds of a send that the channel refused. After such a send, the channel has no message. */
export type RefusalKind = Exclude<ChannelFailureKind, "network" | "timeout" | "server">;

/**
 * The record has each kind of `RefusalKind`, thus no list of the kinds can lose a kind. True: the kind is a fault of
 * the channel, and it stops each delivery to the person until the owner acts. The heartbeat then pings `/fail`.
 *
 * - `reserved`: the channel still sends a `life-safety` message.
 * - `consent`: the choice of one person, a STOP reply. The deliveries to the other people go on.
 * - `quiet`: a quiet message on a channel with no silent mode. The step goes at the first try after the quiet window.
 * - `expired`: a message that expired before the send. The channel is not the cause.
 */
export const REFUSAL_FAULTS: Readonly<Record<RefusalKind, boolean>> = {
  auth: true,
  refused: true,
  "rate-limited": true,
  reserved: false,
  consent: false,
  quiet: false,
  expired: false,
};

/** The fields of each event. The log of `@mark1russell7/sqlite` reads `id`, `at` and `type`. */
interface Envelope<T extends string> {
  /** The id of the event. The log keeps one event for each id, thus an append that repeats changes nothing. */
  readonly id: string;
  /** The time of the event as an ISO 8601 text, for a person who reads the file. */
  readonly at: string;
  readonly type: T;
  /** The time of the event in milliseconds since the epoch. The fold reads this value, not `at`. */
  readonly time: Instant;
}

/** A run of the runtime starts. The first start is the start of the health of each source. */
export interface StartedEvent extends Envelope<"started"> {
  readonly run: string;
}

/** A new observation of a source. Its id is the id of the observation, thus a repeat is not new. */
export interface ObservationEvent extends Envelope<"observation"> {
  readonly observation: Observation;
}

/** The end of one fetch: the record for the health, the next cursor, and the reports of the new observations. */
export interface FetchEvent extends Envelope<"fetch"> {
  readonly record: FetchRecord;
  readonly cursor?: Cursor;
  readonly reports: readonly Report[];
  /** The problems of the map of the new observations. */
  readonly problems: readonly MapProblem[];
}

/** Reports of a snapshot source left its complete lists. The merge reads them as ended from the time of the event. */
export interface EndedEvent extends Envelope<"ended"> {
  readonly source: SourceId;
  readonly reports: readonly ReportId[];
  /** The time of the data of the list that ended the reports (`asOf` of the fetch), if the list has a time. */
  readonly asOf?: Instant;
}

/** Reports of a snapshot source that ended are in a complete list of the source again. The merge reads them as live. */
export interface BackEvent extends Envelope<"back"> {
  readonly source: SourceId;
  readonly reports: readonly ReportId[];
}

/** One step of the system reports, with the observation of each report. */
export interface SystemEvent extends Envelope<"system"> {
  readonly reports: readonly Report[];
  readonly observations: readonly Observation[];
}

/** One accepted send. */
export interface DeliveryEvent extends Envelope<"delivery"> {
  readonly delivery: Delivery;
  /** The copy id of the accepted send, on a channel that repeats. The copy then needs no stop by its copy id. */
  readonly copy?: string;
}

/**
 * A send on a channel that repeats starts. The log keeps its copy id before the send. Thus after a
 * restart, the step stops each copy that has no delivery and no `settled` event.
 */
export interface AttemptEvent extends Envelope<"attempt"> {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
  readonly copy: string;
}

/** A copy needs no stop. The channel refused its send after its time limit, or a stop of the copy ended after the end of its send. */
export interface SettledEvent extends Envelope<"settled"> {
  readonly copy: string;
}

/**
 * The channel refused a send in its time limit. The log keeps the refusal, thus a restart keeps the wait
 * of the retry and the fail of the heartbeat.
 */
export interface RefusedEvent extends Envelope<"refused"> {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
  readonly kind: RefusalKind;
  /** The step sends the key again at this time or later. */
  readonly retryAt: Instant;
  /** The copy id of the send, on a channel that repeats. The refusal ends the copy. */
  readonly copy?: string;
}

/** One acknowledgment of a person. */
export interface AcknowledgmentEvent extends Envelope<"acknowledgment"> {
  readonly acknowledgment: Acknowledgment;
}

/** The repeats of a delivery stopped. The escalation does not cancel it again. */
export interface CancelledEvent extends Envelope<"cancelled"> {
  /** The key of the delivery. */
  readonly delivery: string;
}

/** An escalation started. Its start stays the same after a restart, thus each step comes at its time. */
export interface EscalationEvent extends Envelope<"escalation"> {
  readonly start: EscalationStart;
  /**
   * The shadow score of the incident at the start, when the runtime has the priors. The table decided the level, and
   * the score does not change it. Thus the log keeps the score next to each decision of the table.
   */
  readonly shadow?: ShadowScore;
}

/**
 * The escalations of a person in a live incident ended: the incident no longer reaches the person. A later match of
 * the person starts a new episode.
 */
export interface EscalationEndEvent extends Envelope<"escalation-end"> {
  readonly end: EscalationEnd;
}

/**
 * The send limit of the person held an escalation (`limitRoutes` of the core, AL-72). The escalation sends nothing in
 * its episode, and the next digest tells its incident. This event is not shared: each copy keeps its own holds.
 */
export interface HoldEvent extends Envelope<"hold"> {
  readonly hold: EscalationHold;
}

/**
 * The throttle of the person and the channel stopped a send (`throttleRoutes` of the core, AL-72 part 4). The send does
 * not go, and the next digest tells its incident. This event is not shared: each copy keeps its own suppressions.
 */
export interface SuppressedEvent extends Envelope<"suppressed"> {
  readonly suppression: Suppression;
}

/**
 * The wall clock stepped against the monotonic clock, back or forward. The fold moves each own instant of the state by
 * `size`. Thus each timer keeps its distance on the monotonic clock, and a rebuild gives the same state.
 */
export interface ClockEvent extends Envelope<"clock"> {
  /** The size of the step: below 0 for a step back, above 0 for a step forward. */
  readonly size: Duration;
}

/**
 * At the boot, the log file was broken. The runtime moved it into a quarantine folder, and it started a new file with
 * each event that the salvage read. This event comes after the salvaged events. Its fold gives a system report.
 */
export interface RecoveredEvent extends Envelope<"recovered"> {
  /** The name of the quarantine folder, in the folder of the log. The id of the event has it. */
  readonly quarantine: string;
  /**
   * The kind of the fault of the broken file, from `sqliteFault` of `@mark1russell7/sqlite`. An example is `corrupt`.
   * `orphan-journal` is a WAL, SHM or journal file with no database file. `no-read` is a quarantine folder with no record.
   */
  readonly fault: string;
  /** The count of the events that the salvage read and parsed with no conflict. A conflict counts as lost. */
  readonly read: number;
  /** The count of the read events that the new file got. */
  readonly added: number;
  /** The count of the positions of the broken file that the salvage could not read or parse. */
  readonly lost: number;
  /** This value tells if the salvage read each part of the broken file with no problem. */
  readonly whole: boolean;
  /** The first problems of the check and of the salvage, in this order. */
  readonly problems: readonly string[];
}

/**
 * Old incidents leave the state of the runtime (AL-47). Each report of the event gets a tombstone until `until`. The fold
 * removes the parts of the reports, the starts and ends of their escalations, and their cancelled keys. The log keeps
 * each event of the reports. The event stays in its copy: each copy finds its retirements from the shared parts.
 */
export interface RetiredEvent extends Envelope<"retired"> {
  /** The reports of the retired incidents, in the order of their ids. */
  readonly reports: readonly ReportId[];
  /** The end of the tombstones. A tombstone keeps a late copy of a report out of the state until this time. */
  readonly until: Instant;
  /**
   * The keys of `cancelled` of the deliveries of the retired incidents, and each old key with no delivery in the merge,
   * sorted. A delivery key does not name its incident.
   */
  readonly cancelled: readonly string[];
}

/**
 * This copy starts a run of a drill (AL-43). The time of the event is the start of the run. The fold keeps the last start
 * of each drill. The event stays in its copy: each copy starts its own drills, and each has its own lines.
 */
export interface DrillEvent extends Envelope<"drill"> {
  /** The id of the drill. */
  readonly drill: string;
  /** The id of the copy that starts the run. */
  readonly copy: string;
}

/**
 * A source enters a mode (AL-73). A new source starts in the mode `observe`: its incidents start no escalation and no
 * digest entry below `life-safety`. It enters the mode `live` when its verdict passes. The id of the event is
 * `mode:<source>:<mode>`. Thus the log keeps one time for each mode, and a later event of the same mode changes nothing.
 * The event stays in its copy: each copy judges its own sources.
 */
export interface ModeEvent extends Envelope<"mode"> {
  readonly source: SourceId;
  readonly mode: SourceMode;
  /** The reason of the mode: `seed` for the modes of the first start with modes, or the reason of the verdict. */
  readonly reason: string;
}

/** The mode of a source: `observe` holds its incidents below `life-safety`, and `live` sends them. */
export type SourceMode = "observe" | "live";

/** The reports of one fetch of another copy. It has no fetch record and no cursor: each copy has its own health and cursors. */
export interface SharedFetchEvent extends Envelope<"fetch"> {
  readonly reports: readonly Report[];
}

/** One accepted send of another copy. It has no copy id: only the copy of the send stops the copies of its channel. */
export type SharedDeliveryEvent = Omit<DeliveryEvent, "copy">;

/**
 * An event that a copy of the system gives to the other copies (AL-16): a part of the merge state or of the ledger.
 * Each other event stays in its copy, because each copy has its own sources, health and channels.
 */
export type SharedEvent = SharedFetchEvent | EndedEvent | BackEvent | SharedDeliveryEvent | AcknowledgmentEvent | CancelledEvent | EscalationEndEvent;

/**
 * A shared event of another copy in the log of this copy. The fold changes only the shared state. The instants of the
 * event come from the clock of the other copy. Thus a step of the clock of this copy does not move them. The envelope
 * has the time of the inner event, thus two reads of one event give the same import.
 */
export interface ImportEvent extends Envelope<"import"> {
  /** The id of the copy that wrote the inner event. */
  readonly from: string;
  readonly event: SharedEvent;
}

/**
 * The read position in the log of another copy. The runtime writes it with the imports of a read. Thus after a restart,
 * the next read starts at this position, not at the start of the log.
 */
export interface ExchangeEvent extends Envelope<"exchange"> {
  /** The id of the other copy. */
  readonly peer: string;
  /** The id of the first event of the log of the other copy. A new log of the copy has a new id. */
  readonly log: string;
  /** The position of the last entry that the read examined. */
  readonly next: number;
}

/** One event of the log of the runtime. */
export type RuntimeEvent =
  | StartedEvent
  | ObservationEvent
  | FetchEvent
  | EndedEvent
  | BackEvent
  | SystemEvent
  | EscalationEvent
  | EscalationEndEvent
  | HoldEvent
  | SuppressedEvent
  | DeliveryEvent
  | AcknowledgmentEvent
  | CancelledEvent
  | AttemptEvent
  | SettledEvent
  | RefusedEvent
  | ClockEvent
  | RecoveredEvent
  | ImportEvent
  | ExchangeEvent
  | RetiredEvent
  | DrillEvent
  | ModeEvent;

/** The types of the events. */
export const EVENT_TYPES: readonly RuntimeEvent["type"][] = [
  "started",
  "observation",
  "fetch",
  "ended",
  "back",
  "system",
  "escalation",
  "escalation-end",
  "hold",
  "suppressed",
  "delivery",
  "acknowledgment",
  "cancelled",
  "attempt",
  "settled",
  "refused",
  "clock",
  "recovered",
  "import",
  "exchange",
  "retired",
  "drill",
  "mode",
];

/**
 * The types of the events that the fold of the state reads (AL-102). The fold changes nothing for an observation, because
 * the fetch event of the observation follows it with the same time. Thus the start reads no observation, and it parses
 * none. Observations are the largest part of a log.
 */
export const FOLD_TYPES: readonly RuntimeEvent["type"][] = EVENT_TYPES.filter((type) => type !== "observation");

/** This function gives the count of the events of the types that this build does not know, from the counts of each type. */
export function unknownEvents(counts: ReadonlyMap<string, number>): number {
  const known = new Set<string>(EVENT_TYPES);
  let unknown = 0;
  for (const [type, count] of counts) if (!known.has(type)) unknown += count;
  return unknown;
}

/**
 * This function gives the frame tag of an id with a time of the runtime. The tag is empty before the first step of
 * the wall clock, and `~<count of steps>` after it. Thus a time that comes again after a step back gives a new id.
 */
export function frameTag(steps: number): string {
  return steps === 0 ? "" : `~${steps}`;
}

/** This function gives the fields of the envelope of an event at a time. */
export function envelope<T extends RuntimeEvent["type"]>(type: T, id: string, time: Instant): Envelope<T> {
  return { id, at: new Date(time).toISOString(), type, time };
}

/**
 * This function changes a stored JSON value into an event, and throws for a value that is not one.
 * It examines only the envelope and the type. The log holds only the events of the runtime, and
 * SQLite examines the integrity of the file.
 */
export function parseEvent(value: unknown): RuntimeEvent {
  const event = value as Partial<Envelope<string>> | null;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.id !== "string" ||
    typeof event.at !== "string" ||
    typeof event.time !== "number" ||
    !Number.isFinite(event.time) ||
    !(EVENT_TYPES as readonly unknown[]).includes(event.type)
  ) {
    throw new TypeError(`The log has a value that is not an event of the runtime: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return value as RuntimeEvent;
}
