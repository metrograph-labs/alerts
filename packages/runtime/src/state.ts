/**
 * This module holds the state of the runtime and the fold of the events of its log. The fold is the
 * only change of the state. The runtime writes an event to the log and folds it in one step, thus the
 * state after a restart is the state before it.
 */
import {
  add,
  addSystemReports,
  DEFAULT_LINK_POLICY,
  EMPTY_STATE,
  join,
  linkRule,
  NO_SYSTEM_LINES,
  normalize,
  observeFetch,
  pruneTombstones,
  retire,
  shiftDelivery,
  shiftEndMark,
  shiftEscalationEnd,
  shiftEscalationStart,
  shiftHealth,
  shiftMerge,
  shiftReport,
  startHealth,
  type Acknowledgment,
  type ChannelId,
  type ClockStep,
  type LogRecovery,
  type Cursor,
  type Delivery,
  type Duration,
  type EndMark,
  type EscalationEnd,
  type EscalationHold,
  type EscalationStart,
  type Expectation,
  type Suppression,
  type HealthOptions,
  type HealthTrack,
  type Instant,
  type LinkPolicy,
  type MergeParts,
  type MergeState,
  type Report,
  type ReportId,
  type SourceDescriptor,
  type SystemLines,
  type Tombstone,
} from "@mark1russell7/alerts";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { ImportEvent, RefusalKind, RetiredEvent, RuntimeEvent, SharedEvent } from "./events.ts";
import { retention, retiredEvent, RETIRE_EVERY, type RetentionOptions } from "./retention.ts";

/** What the fold reads from the configuration: the descriptors of the sources, the options of the health and the retention. */
export interface FoldContext {
  readonly sources: readonly SourceDescriptor[];
  readonly health?: HealthOptions;
  /**
   * The retention of old incidents (AL-109). With it, the fold retires on a cadence of the event time, with no event in
   * the log. Without it, only a `retired` event retires.
   */
  readonly retention?: RetentionOptions;
  /** The policy of the link rule of the merge. The retirement removes only whole incidents of this rule. The default is `DEFAULT_LINK_POLICY`. */
  readonly link?: LinkPolicy;
  /** The expectations of the view. A report that starts the check of an expectation keeps its incident (`quietKeeps`). */
  readonly expectations?: readonly Expectation[];
}

/** This function gets the report ids of the merge state after each retirement of a fold or a rebuild, in the order of the log. */
export type RetireHook = (merge: Pick<MergeState, "reports">) => void;

/** The shared state of one side: this copy, or the other copies of the system. */
export interface SharedState {
  /** The reports, the deliveries, the acknowledgments and the end marks. */
  readonly merge: MergeState;
  /** The ends of the escalations, in the order of the log. */
  readonly escalationEnds: readonly EscalationEnd[];
}

/** The read position in the log of another copy. */
export interface ExchangeCursor {
  /** The id of the first event of the log of the copy. */
  readonly log: string;
  /** The position of the last entry that the read examined. */
  readonly next: number;
}

/** The shared state with no part. */
export const NO_SHARED: SharedState = { merge: EMPTY_STATE, escalationEnds: [] };

/** The state of the runtime: a fold of the log. */
export interface RuntimeState {
  /** The time of the first start. Each health track starts at it. */
  readonly start?: Instant;
  /** The time of the latest event. */
  readonly time: Instant;
  /** The reports, the deliveries and the acknowledgments of each copy: the join of `own` and `imported`. */
  readonly merge: MergeState;
  /** The shared state that this copy wrote. A step of the wall clock moves it. Without imports, its merge is `merge`. */
  readonly own: SharedState;
  /**
   * The shared state that the other copies wrote (AL-16). It has the times of their clocks, thus a step of the wall clock
   * of this copy does not move it.
   */
  readonly imported: SharedState;
  /** The read position in the log of each other copy, by the id of the copy. */
  readonly exchanges: Readonly<Record<string, ExchangeCursor>>;
  /** The health track of each source, by its id. Only a fetch record moves it. A view at a later time advances a copy. */
  readonly health: Readonly<Record<string, HealthTrack>>;
  /** The start of the last fetch of each source, by its id. */
  readonly fetched: Readonly<Record<string, Instant>>;
  /** The cursor of each source for its next fetch, by its id. */
  readonly cursors: Readonly<Record<string, Cursor>>;
  /** The open lines of the system reports. */
  readonly lines: SystemLines;
  /** The keys of the deliveries with no more repeats, sorted. */
  readonly cancelled: readonly string[];
  /**
   * The own time of entry of each key of `cancelled`: the time of the state at the fold of its cancel. A retirement drops
   * a key with no delivery in the merge only at the horizon after this time. A key with no time of entry stays.
   */
  readonly cancelledSince: Readonly<Record<string, Instant>>;
  /**
   * The tombstones of the cancelled keys of the retired incidents, in the order of their keys. A cancel of a key with a
   * tombstone stays out of `cancelled`. Thus a new read of the log of another copy does not bring back old keys.
   */
  readonly cancelTombstones: readonly CancelTombstone[];
  /** The start of each escalation, in the order of the log. */
  readonly starts: readonly EscalationStart[];
  /**
   * The end of the escalations of a person in a live incident that no longer reaches the person. It holds the ends of
   * `own`, then the ends of `imported`.
   */
  readonly escalationEnds: readonly EscalationEnd[];
  /** The holds of the send limit of this copy (AL-72), in the order of the log. Each copy keeps its own holds. */
  readonly holds: readonly EscalationHold[];
  /** The suppressions of the throttle of this copy (AL-72 part 4), in the order of the log. Each copy keeps its own. */
  readonly suppressions: readonly Suppression[];
  /**
   * The open copies, by copy id: each send on a channel that repeats with no delivery of its copy and no
   * `settled` event. The channel can repeat them. After a restart, the delivery step stops them.
   */
  readonly copies: Readonly<Record<string, OpenCopy>>;
  /**
   * The last refusal of each delivery key with no later delivery of the key, by the key. A start of a run and
   * a refusal drop each refusal whose retry is at or before their time. Thus the record keeps only the waits.
   */
  readonly refusals: Readonly<Record<string, Refusal>>;
  /** The count of the deliveries of each channel in the log, by the channel id. */
  readonly delivered: Readonly<Record<string, number>>;
  /**
   * The steps of the wall clock, in the order of the log. A later step moves the time of each earlier step, as it
   * moves each own instant of the state.
   */
  readonly steps: readonly ClockStep[];
  /** The recoveries of the log from a broken file, in the order of the log. A later step of the wall clock moves their times. */
  readonly recoveries: readonly LogRecovery[];
  /** The last start of each drill of this copy, by the id of the drill (AL-43). A later step of the wall clock moves them. */
  readonly drills: Readonly<Record<string, Instant>>;
  /**
   * The mode of each source with a mode event (AL-73): the start of its observe mode, and the time that it went live. A
   * source with no entry has no mode yet. The mode `live` stays: a later event `observe` does not change it.
   */
  readonly modes: Readonly<Record<string, SourceModeTrack>>;
  /**
   * The time of the last step of the retirement (AL-109): the time of its event. The next step comes before the first event
   * at the interval `every` or more after it. A state with no retention in its context has none.
   */
  readonly retiredAt?: Instant;
}

/** The mode of one source (`ModeEvent`). */
export interface SourceModeTrack {
  /** The start of the observe mode. A source that went live with no observe mode has none. */
  readonly since?: Instant;
  /** The time that the source went live. */
  readonly live?: Instant;
}

/**
 * The tombstone of a cancelled key of a retired incident. A delivery key does not name its incident, thus the key has a
 * tombstone of its own. It has the end of the tombstones of its retirement, and the next retirement after that end drops it.
 */
export interface CancelTombstone {
  readonly key: string;
  readonly until: Instant;
}

/** The last refusal of a delivery key. */
export interface Refusal {
  readonly channel: ChannelId;
  readonly kind: RefusalKind;
  /** The time of the refusal. */
  readonly at: Instant;
  readonly retryAt: Instant;
  /**
   * The count of the deliveries of the channel in the log before the refusal. When `delivered` of the
   * channel is larger, a delivery on the channel came after the refusal in the log.
   */
  readonly deliveries: number;
  /** The count of the refusals of the key in a row, with this refusal (`refusalStreak`). */
  readonly streak: number;
}

/**
 * The default longest wait between two tries of a refused send: 10 minutes. On 2026-11-18 a refused send went again
 * each 10 seconds through a burst (AL-72). A refusal tells that the channel has no message, thus a quick retry helps little.
 */
export const REFUSAL_LIMIT: Duration = 600_000;

/**
 * This function tells if the log keeps a refusal at the time `at`. The log keeps the last refusal of a key until its
 * retry time plus `REFUSAL_LIMIT`, or plus its wait when the wait is longer. A delivery of the key ends it.
 *
 * - A retry comes at its retry time or later. A burst or a restart can put it later, thus the refusal stays past it.
 * - A refusal that the log keeps does not hold a send after its retry time. Each reader of a wait examines the retry time.
 */
export function refusalKept(refusal: Pick<Refusal, "at" | "retryAt">, at: Instant): boolean {
  return at < refusal.retryAt + Math.max(REFUSAL_LIMIT, refusal.retryAt - refusal.at);
}

/**
 * This function gives the wait of the next try of a refused send. `streak` is the count of the refusals of the key in a
 * row before this refusal (`refusalStreak`). The wait is `retry` after the first refusal, and it doubles for each
 * refusal in a row, up to `limit`.
 */
export function refusalWait(streak: number, retry: Duration, limit: Duration = REFUSAL_LIMIT): Duration {
  return streak === 0 ? retry : Math.max(retry, Math.min(limit, retry * 2 ** streak));
}

/**
 * This function gives the count of the refusals of a key in a row at the time `at`. A key with no refusal that the log
 * keeps (`refusalKept`) has the count 0. The wait of the next try of a refused send doubles for each refusal in a row.
 */
export function refusalStreak(refusals: Readonly<Record<string, Refusal>>, key: string, at: Instant): number {
  const refusal = refusals[key];
  return refusal !== undefined && refusalKept(refusal, at) ? refusal.streak : 0;
}

/** The send of an open copy. */
export interface OpenCopy {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
}

/** The state before the first event. */
export const EMPTY_RUNTIME: RuntimeState = {
  time: Number.NEGATIVE_INFINITY,
  merge: EMPTY_STATE,
  own: NO_SHARED,
  imported: NO_SHARED,
  exchanges: {},
  health: {},
  fetched: {},
  cursors: {},
  lines: NO_SYSTEM_LINES,
  cancelled: [],
  cancelledSince: {},
  cancelTombstones: [],
  starts: [],
  escalationEnds: [],
  holds: [],
  suppressions: [],
  copies: {},
  refusals: {},
  delivered: {},
  steps: [],
  recoveries: [],
  drills: {},
  modes: {},
};

/**
 * This function adds one event to the state. With a retention in the context, a step of the retirement can come before
 * the event (AL-109). `retired` gets the merge state after the step, and after the fold of a `retired` event.
 */
export function fold(state: RuntimeState, event: RuntimeEvent, context: FoldContext, retired?: RetireHook): RuntimeState {
  const next = foldEvent(retireStep(state, event, context, retired), event, context);
  if (event.type === "retired") retired?.(next.merge);
  return next;
}

// The fold of one event, with no step of the retirement.
function foldEvent(state: RuntimeState, event: RuntimeEvent, context: FoldContext): RuntimeState {
  const rest = foldRest(state, event, context);
  // A tombstone of this copy keeps the parts of a retired report out of each side. The own merge state applies its own tombstones.
  const parts = event.type === "import" ? withoutRetired(partsOf(event.event), rest.own.merge.retired) : partsOf(event);
  if (parts === undefined) return rest;
  // The merge is a join of a semilattice, thus the view of each copy gets the parts of each side in any order.
  if (event.type === "import") return { ...rest, merge: add(rest.merge, parts), imported: { ...rest.imported, merge: add(rest.imported.merge, parts) } };
  const own = add(rest.own.merge, parts);
  return { ...rest, merge: hasImports(rest) ? add(rest.merge, parts) : own, own: { ...rest.own, merge: own } };
}

/**
 * This function gives the state of the events of a log, in their order. It equals a fold of each event, and `retired`
 * gets the same calls. The merge is a join of a semilattice, thus the function joins the parts only at a step of the
 * retirement and at the end.
 */
export function rebuild(events: Iterable<RuntimeEvent>, context: FoldContext, retired?: RetireHook): RuntimeState {
  let state = EMPTY_RUNTIME;
  const own = collector();
  const imported = collector();
  const removed = (): void => retired?.({ reports: [...own.parts.reports, ...imported.parts.reports] });
  for (const event of events) {
    const at = stepTime(state, event, context);
    if (at !== undefined) {
      // The step reads the merge state before the event, as the fold does. The compaction also keeps the collectors small.
      const kept = state.own.merge.retired;
      const view = withSides(state, own.compact(kept), imported.compact([]));
      const step = retirementAt(view, at, context);
      if (step !== undefined) {
        state = foldRetired(state, step);
        own.compact([...kept, ...state.own.merge.retired]);
        imported.drop(step.reports);
        removed();
      }
      state = { ...state, retiredAt: at };
    }
    // The tombstones before the event. A retirement drops some of them, but they still remove the own parts before it.
    const before = state.own.merge.retired;
    // The fold moves its own merge state in normal form. A step can change which copy of a report the normal form keeps.
    // Thus the own parts get the normal form before the step moves them.
    if (event.type === "clock") own.compact(before);
    state = foldRest(state, event, context);
    // A step moves the own parts before it, as the fold moves its own merge state. The parts after it are in the new frame.
    if (event.type === "clock") own.shift(event.size);
    if (event.type === "retired") {
      // The fold drops the expired tombstones only at a retirement. Thus each tombstone of before removed each own part up to this event.
      own.compact([...before, ...state.own.merge.retired]);
      imported.drop(event.reports);
      removed();
    } else if (event.type === "import") imported.push(withoutRetired(partsOf(event.event), state.own.merge.retired));
    else own.push(partsOf(event));
  }
  // The live tombstones are in the state, because the collectors keep no tombstone.
  return withSides(state, normalize({ ...own.parts, retired: state.own.merge.retired }), normalize(imported.parts));
}

// The state with the merge state of each side, and their join.
function withSides(state: RuntimeState, own: MergeState, imported: MergeState): RuntimeState {
  const sides = { own: { ...state.own, merge: own }, imported: { ...state.imported, merge: imported } };
  return { ...state, ...sides, ...joined(sides.own, sides.imported) };
}

// The time of the step of the retirement before an event, or undefined. The step has the time of the event. These events have no step:
// - A step of the clock, because its time is in the new frame.
// - An import, because it has the time of another clock.
// - An observation, because the start does not read it (`FOLD_TYPES`). The fetch event of the observation follows it with the same time.
function stepTime(state: RuntimeState, event: RuntimeEvent, context: FoldContext): Instant | undefined {
  if (context.retention === undefined || event.type === "clock" || event.type === "import" || event.type === "observation") return undefined;
  const every = context.retention.every ?? RETIRE_EVERY;
  return state.retiredAt === undefined || event.time >= state.retiredAt + every ? event.time : undefined;
}

// The retirement of a step at the time `at`, or undefined when nothing retires.
function retirementAt(state: RuntimeState, at: Instant, context: FoldContext): RetiredEvent | undefined {
  return retiredEvent(state, at, linkRule(context.link ?? DEFAULT_LINK_POLICY), retention(context.retention), context.expectations ?? []);
}

// The state after the step of the retirement before an event, or the same state with no step.
function retireStep(state: RuntimeState, event: RuntimeEvent, context: FoldContext, retired: RetireHook | undefined): RuntimeState {
  const at = stepTime(state, event, context);
  if (at === undefined) return state;
  const step = retirementAt(state, at, context);
  if (step === undefined) return { ...state, retiredAt: at };
  const next = foldRetired(state, step);
  retired?.(next.merge);
  return { ...next, retiredAt: at };
}

// The parts of one side of a rebuild, in the order of the log.
function collector(): {
  readonly parts: Required<Omit<MergeParts, "retired">>;
  push(parts: MergeParts | undefined): void;
  shift(size: Duration): void;
  compact(tombstones: readonly Tombstone[]): MergeState;
  drop(gone: readonly ReportId[]): void;
} {
  const reports: Report[] = [];
  const deliveries: Delivery[] = [];
  const acks: Acknowledgment[] = [];
  const ends: EndMark[] = [];
  const replace = (merge: Omit<MergeState, "retired">): void => {
    reports.splice(0, reports.length, ...merge.reports);
    deliveries.splice(0, deliveries.length, ...merge.deliveries);
    acks.splice(0, acks.length, ...merge.acks);
    ends.splice(0, ends.length, ...merge.ends);
  };
  return {
    parts: { reports, deliveries, acks, ends },
    // The parts with no part of a report with a tombstone, in normal form. The collector keeps no tombstone, but the merge state that it gives has them.
    compact(tombstones) {
      const merge = normalize({ reports, deliveries, acks, ends, retired: tombstones });
      replace(merge);
      return merge;
    },
    drop(gone) {
      replace(withoutReports({ reports, deliveries, acks, ends }, new Set(gone)));
    },
    push(parts) {
      reports.push(...(parts?.reports ?? []));
      deliveries.push(...(parts?.deliveries ?? []));
      acks.push(...(parts?.acks ?? []));
      ends.push(...(parts?.ends ?? []));
    },
    shift(size) {
      for (let index = 0; index < reports.length; index += 1) reports[index] = shiftReport(reports[index]!, size);
      for (let index = 0; index < deliveries.length; index += 1) deliveries[index] = shiftDelivery(deliveries[index]!, size);
      for (let index = 0; index < ends.length; index += 1) ends[index] = shiftEndMark(ends[index]!, size);
    },
  };
}

// The merge state has no part.
function emptyMerge(merge: MergeState): boolean {
  return merge.reports.length + merge.deliveries.length + merge.acks.length + merge.ends.length + merge.retired.length === 0;
}

// The state has a part of another copy.
function hasImports(state: RuntimeState): boolean {
  return !emptyMerge(state.imported.merge) || state.imported.escalationEnds.length > 0;
}

// The views of each copy: the join of the two sides. Without imports, the views are the own side.
function joined(own: SharedState, imported: SharedState): Pick<RuntimeState, "merge" | "escalationEnds"> {
  return {
    merge: emptyMerge(imported.merge) ? own.merge : join(own.merge, imported.merge),
    escalationEnds: joinedEnds(own, imported),
  };
}

// The ends of the escalations of each copy: the own ends, then the imported ends. It does not join the merge states.
function joinedEnds(own: SharedState, imported: SharedState): readonly EscalationEnd[] {
  return imported.escalationEnds.length === 0 ? own.escalationEnds : [...own.escalationEnds, ...imported.escalationEnds];
}

// The parts of the merge in an event.
function partsOf(event: RuntimeEvent | SharedEvent): MergeParts | undefined {
  switch (event.type) {
    case "fetch":
    case "system":
      return event.reports.length === 0 ? undefined : { reports: event.reports };
    case "delivery":
      return { deliveries: [event.delivery] };
    case "acknowledgment":
      return { acks: [event.acknowledgment] };
    case "ended":
    case "back":
      return {
        ends: event.reports.map((report) => ({
          report,
          at: event.time,
          ended: event.type === "ended",
          ...(event.type === "ended" && event.asOf !== undefined ? { asOf: event.asOf } : {}),
        })),
      };
    default:
      return undefined;
  }
}

// Each change of an event other than the merge.
function foldRest(state: RuntimeState, event: RuntimeEvent, context: FoldContext): RuntimeState {
  const base: RuntimeState = { ...state, time: Math.max(state.time, event.time) };
  const start = state.start ?? event.time;
  switch (event.type) {
    case "started": {
      const health = { ...state.health };
      for (const source of context.sources) health[source.id] ??= startHealth(source.id, start);
      return { ...base, start, health, refusals: waiting(state.refusals, event.time) };
    }
    case "fetch": {
      const { record } = event;
      const descriptor = context.sources.find((source) => source.id === record.source);
      const cursors = event.cursor === undefined ? state.cursors : { ...state.cursors, [record.source]: event.cursor };
      const next: RuntimeState = { ...base, start, cursors, fetched: { ...state.fetched, [record.source]: Math.max(state.fetched[record.source] ?? record.at, record.at) } };
      // A source that is not in the configuration keeps its reports, and it has no health.
      if (descriptor === undefined) return next;
      const track = state.health[record.source] ?? startHealth(record.source, start);
      return { ...next, health: { ...state.health, [record.source]: observeFetch(track, record, descriptor, context.health).track } };
    }
    case "system":
      return { ...base, lines: addSystemReports(state.lines, event.reports, event.observations) };
    case "escalation":
      return { ...base, starts: [...state.starts, event.start] };
    case "hold":
      return { ...base, holds: [...state.holds, event.hold] };
    case "suppressed":
      return { ...base, suppressions: [...state.suppressions, event.suppression] };
    case "escalation-end": {
      const own = { ...state.own, escalationEnds: [...state.own.escalationEnds, event.end] };
      return { ...base, own, escalationEnds: joinedEnds(own, state.imported) };
    }
    case "cancelled":
      return hasCancel(state, event.delivery) ? base : { ...base, ...withCancel(state, event.delivery, base.time) };
    case "attempt":
      return { ...base, copies: { ...state.copies, [event.copy]: { key: event.key, channel: event.channel } } };
    case "delivery": {
      const refusals = without(state.refusals, event.delivery.key);
      const { channel } = event.delivery;
      const delivered = { ...state.delivered, [channel]: (state.delivered[channel] ?? 0) + 1 };
      return { ...base, refusals, delivered, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    case "settled":
      return { ...base, copies: without(state.copies, event.copy) };
    case "refused": {
      const streak = refusalStreak(state.refusals, event.key, event.time) + 1;
      const refusal: Refusal = { channel: event.channel, kind: event.kind, at: event.time, retryAt: event.retryAt, deliveries: state.delivered[event.channel] ?? 0, streak };
      const refusals = { ...waiting(state.refusals, event.time), [event.key]: refusal };
      return { ...base, refusals, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    case "clock": {
      const shifted = shiftState(state, event.size);
      return { ...shifted, time: Math.max(shifted.time, event.time), steps: [...shifted.steps, { at: event.time, size: event.size }] };
    }
    case "recovered": {
      const recoveries = [...state.recoveries, { at: event.time, quarantine: event.quarantine, kept: event.added, lost: event.lost, whole: event.whole }];
      // The salvage can lose an import and keep the position after it. Thus the next read of each other copy starts at 0.
      return { ...base, recoveries, exchanges: {} };
    }
    case "import":
      return foldImport(state, event);
    case "retired":
      return foldRetired(base, event);
    case "exchange":
      return { ...base, exchanges: { ...state.exchanges, [event.peer]: { log: event.log, next: event.next } } };
    case "drill":
      return { ...base, drills: { ...state.drills, [event.drill]: Math.max(state.drills[event.drill] ?? event.time, event.time) } };
    case "mode": {
      const track = state.modes[event.source] ?? {};
      // The first event of each mode sets its time. A source that went live does not observe again.
      if (event.mode === "live" ? track.live !== undefined : track.since !== undefined || track.live !== undefined) return base;
      const next: SourceModeTrack = event.mode === "live" ? { ...track, live: event.time } : { since: event.time };
      return { ...base, modes: { ...state.modes, [event.source]: next } };
    }
    default:
      return base;
  }
}

/**
 * The change of an import other than the merge. It changes only the shared state: the cancels, the ends of the
 * escalations and the refusals of a delivered key. The time of the state stays, because the instants of the import come
 * from the clock of another copy.
 */
function foldImport(state: RuntimeState, { event }: ImportEvent): RuntimeState {
  switch (event.type) {
    case "delivery":
      return { ...state, refusals: without(state.refusals, event.delivery.key) };
    case "cancelled":
      // The instants of the import come from another clock. Thus the time of entry is the own time of the state.
      return hasCancel(state, event.delivery) ? state : { ...state, ...withCancel(state, event.delivery, state.time) };
    case "escalation-end": {
      if (isRetired(state.own.merge.retired, event.end.incident)) return state;
      const imported = { ...state.imported, escalationEnds: [...state.imported.escalationEnds, event.end] };
      return { ...state, imported, escalationEnds: joinedEnds(state.own, imported) };
    }
    default:
      return state;
  }
}

/**
 * The change of a retirement. The own side gets the tombstones, and then it drops each tombstone that ended at the time
 * of the event. The imported side has no tombstone: the retirement removes its parts, and the fold of an import keeps the
 * parts of a retired report out. Thus a step of the clock of this copy moves each tombstone, and the imported side has
 * only the instants of the other copies.
 */
function foldRetired(state: RuntimeState, event: RetiredEvent): RuntimeState {
  const gone = new Set<ReportId>(event.reports);
  const keep = (end: EscalationEnd): boolean => !gone.has(end.incident);
  const own: SharedState = { merge: pruneTombstones(retire(state.own.merge, event.reports, event.until), event.time), escalationEnds: state.own.escalationEnds.filter(keep) };
  const imported: SharedState = { merge: withoutReports(state.imported.merge, gone), escalationEnds: state.imported.escalationEnds.filter(keep) };
  const cancelled = new Set(event.cancelled);
  return {
    ...state,
    own,
    imported,
    ...joined(own, imported),
    starts: state.starts.filter((start) => !gone.has(start.incident)),
    holds: state.holds.filter((hold) => !gone.has(hold.incident)),
    suppressions: state.suppressions.filter((suppression) => !gone.has(suppression.incident)),
    cancelled: state.cancelled.filter((key) => !cancelled.has(key)),
    cancelledSince: withoutAll(state.cancelledSince, cancelled),
    cancelTombstones: retireKeys(state.cancelTombstones, event.cancelled, event.until, event.time),
  };
}

// The key tombstones after a retirement. Each key of the event gets the end `until`, and each tombstone that ended at `at` goes.
function retireKeys(tombstones: readonly CancelTombstone[], keys: readonly string[], until: Instant, at: Instant): readonly CancelTombstone[] {
  const ends = new Map(tombstones.map((tombstone) => [tombstone.key, tombstone.until]));
  for (const key of keys) ends.set(key, Math.max(ends.get(key) ?? Number.NEGATIVE_INFINITY, until));
  const live = [...ends].filter(([, end]) => end > at).map(([key, end]): CancelTombstone => ({ key, until: end }));
  return live.sort((left, right) => compareCodeUnits(left.key, right.key));
}

// The cancelled keys with one more key, and its own time of entry. A time that is not finite gives no entry, thus the key has no age.
function withCancel(state: RuntimeState, key: string, at: Instant): Pick<RuntimeState, "cancelled" | "cancelledSince"> {
  return {
    cancelled: [...state.cancelled, key].sort(compareCodeUnits),
    cancelledSince: Number.isFinite(at) ? { ...state.cancelledSince, [key]: at } : state.cancelledSince,
  };
}

/**
 * This function gives each key with no more repeats: the keys of `cancelled` and the keys of the tombstones. A key of a
 * tombstone was cancelled before its incident or its orphan retired. Thus a late delivery of the key gives no repeat.
 */
export function cancelledKeys(state: Pick<RuntimeState, "cancelled" | "cancelTombstones">): ReadonlySet<string> {
  return new Set([...state.cancelled, ...state.cancelTombstones.map((tombstone) => tombstone.key)]);
}

// The state has the cancel of the key, or the key has a tombstone. A cancel of a key with a tombstone changes no delivery.
function hasCancel(state: RuntimeState, key: string): boolean {
  return state.cancelled.includes(key) || sortedHas(state.cancelTombstones, (tombstone) => tombstone.key, key);
}

// The merge parts with no part of a report of gone. A merge state in normal form keeps its form, because the function only removes parts.
function withoutReports<M extends Omit<MergeState, "retired">>(merge: M, gone: ReadonlySet<ReportId>): M {
  if (gone.size === 0) return merge;
  return {
    ...merge,
    reports: merge.reports.filter((report) => !gone.has(report.id)),
    deliveries: merge.deliveries.filter((delivery) => !gone.has(delivery.incident)),
    acks: merge.acks.filter((ack) => !gone.has(ack.incident)),
    ends: merge.ends.filter((end) => !gone.has(end.report)),
  };
}

// The parts with no part of a report with a tombstone. It gives undefined when no part stays.
function withoutRetired(parts: MergeParts | undefined, retired: readonly Tombstone[]): MergeParts | undefined {
  if (parts === undefined || retired.length === 0) return parts;
  const reports = (parts.reports ?? []).filter((report) => !isRetired(retired, report.id));
  const deliveries = (parts.deliveries ?? []).filter((delivery) => !isRetired(retired, delivery.incident));
  const acks = (parts.acks ?? []).filter((ack) => !isRetired(retired, ack.incident));
  const ends = (parts.ends ?? []).filter((end) => !isRetired(retired, end.report));
  return reports.length + deliveries.length + acks.length + ends.length === 0 ? undefined : { reports, deliveries, acks, ends };
}

// The report has a tombstone. The tombstones of a merge state in normal form are in the order of their reports.
function isRetired(retired: readonly Tombstone[], report: ReportId): boolean {
  return sortedHas(retired, (tombstone) => tombstone.report, report);
}

// A binary search for the key in a list in the order of the keys by code units.
function sortedHas<T>(list: readonly T[], keyOf: (item: T) => string, key: string): boolean {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const order = compareCodeUnits(keyOf(list[middle]!), key);
    if (order === 0) return true;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * This function moves each own instant of a state by the size of a step of the wall clock. The instants of the sources
 * and the channels do not move: `shiftMerge` of the core tells which instants of the merge move. The cursors, the
 * lines of the system reports and the counts hold no own instant. The imported state has the instants of other clocks,
 * thus it does not move.
 */
export function shiftState(state: RuntimeState, size: Duration): RuntimeState {
  const health = Object.fromEntries(Object.entries(state.health).map(([source, track]) => [source, shiftHealth(track, size)]));
  const fetched = Object.fromEntries(Object.entries(state.fetched).map(([source, at]) => [source, at + size]));
  const refusals = Object.fromEntries(Object.entries(state.refusals).map(([key, refusal]) => [key, { ...refusal, at: refusal.at + size, retryAt: refusal.retryAt + size }]));
  const own: SharedState = { merge: shiftMerge(state.own.merge, size), escalationEnds: state.own.escalationEnds.map((end) => shiftEscalationEnd(end, size)) };
  return {
    ...state,
    ...(state.start === undefined ? {} : { start: state.start + size }),
    time: state.time + size,
    own,
    ...joined(own, state.imported),
    health,
    fetched,
    refusals,
    cancelledSince: Object.fromEntries(Object.entries(state.cancelledSince).map(([key, at]) => [key, at + size])),
    cancelTombstones: state.cancelTombstones.map((tombstone) => ({ ...tombstone, until: tombstone.until + size })),
    starts: state.starts.map((start) => shiftEscalationStart(start, size)),
    holds: state.holds.map((hold) => ({ ...hold, at: hold.at + size })),
    suppressions: state.suppressions.map((suppression) => ({ ...suppression, at: suppression.at + size })),
    steps: state.steps.map((step) => ({ ...step, at: step.at + size })),
    ...(state.retiredAt === undefined ? {} : { retiredAt: state.retiredAt + size }),
    recoveries: state.recoveries.map((recovery) => ({ ...recovery, at: recovery.at + size })),
    drills: Object.fromEntries(Object.entries(state.drills).map(([drill, at]) => [drill, at + size])),
    modes: Object.fromEntries(
      Object.entries(state.modes).map(([source, track]) => [
        source,
        { ...(track.since === undefined ? {} : { since: track.since + size }), ...(track.live === undefined ? {} : { live: track.live + size }) },
      ]),
    ),
  };
}

// The refusals that the log keeps at the time `at` (`refusalKept`). A refusal with an earlier retry holds no send and no
// channel after a restart, because each reader of a wait examines the retry time. Its count of refusals in a row stays.
function waiting(refusals: Readonly<Record<string, Refusal>>, at: Instant): Readonly<Record<string, Refusal>> {
  const kept = Object.entries(refusals).filter(([, refusal]) => refusalKept(refusal, at));
  return kept.length === Object.keys(refusals).length ? refusals : Object.fromEntries(kept);
}

// The record with no entry for each id of gone.
function withoutAll<T>(record: Readonly<Record<string, T>>, gone: ReadonlySet<string>): Readonly<Record<string, T>> {
  return Object.keys(record).some((id) => gone.has(id)) ? Object.fromEntries(Object.entries(record).filter(([id]) => !gone.has(id))) : record;
}

// The record with no entry for one id.
function without<T>(record: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> {
  if (!Object.hasOwn(record, id)) return record;
  const rest = { ...record };
  delete rest[id];
  return rest;
}
