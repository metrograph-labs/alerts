/**
 * The drills of the live paths (AL-43). The fakes and the fault cases of CI test the code. Only a drill tests the live
 * path: the provider, the phone and the person. A drill is data: a path, the least time between two starts, a window of
 * the starts and the time of the acknowledgment. A drill with no acknowledgment in its time fails.
 *
 * The functions are pure. They read no clock. The runs of each copy come in as data, and two runs of one start join
 * into one run. Thus the order of the runs has no effect.
 */
import { inWindow, nextBoundary, windowProblems, type TimeWindow } from "@mark1russell7/algebra/clock";
import type { ChannelDescriptor, ChannelId, CopyWatch, Duration, Instant, PersonId, QuietWindow } from "./contracts.ts";
import { inQuietWindow } from "./escalation.ts";

/**
 * The path of a drill: one channel of the escalation of the person. A drill goes as a system report of the level
 * `life-safety`, with the subject `DRILL_SUBJECT`. Thus it goes through the route and the escalation policy of a
 * life-safety warning. Only an acknowledgment of a delivery on this channel counts for the drill.
 */
export interface DrillPath {
  readonly kind: "channel";
  readonly channel: ChannelId;
}

/** One drill of the configuration. */
export interface DrillConfig {
  /** The id of the drill: 1 to 32 lowercase letters, digits and hyphens. */
  readonly id: string;
  /** The person who acknowledges the drill. */
  readonly person: PersonId;
  readonly path: DrillPath;
  /**
   * The least time from the start of one drill to the start of the next. For a drill on one day of each week, give
   * 6 days and a window on that day.
   */
  readonly every: Duration;
  /** The window of the starts. A drill starts only in this window, and not in the quiet window of the person. */
  readonly window: TimeWindow;
  /** The time from the start to the acknowledgment. With no acknowledgment in this time, the drill fails. */
  readonly ackWithin: Duration;
  /**
   * The ids of the copies that start the drill. Each of them starts its own runs. Without the list, only the copy of
   * rank 0 starts the drill. Thus two copies do not send one drill at once.
   */
  readonly copies?: readonly string[];
}

/** One run of a drill: its start, and the first acknowledgment of a delivery on the channel of the path. */
export interface DrillRun {
  /** The id of the drill. */
  readonly drill: string;
  /** The start of the run. */
  readonly at: Instant;
  /** The time of the acknowledgment. */
  readonly acked?: Instant;
}

/**
 * The verdict of a run at a time.
 *
 * - `pending`: the run has no acknowledgment, and its time continues until `until`.
 * - `passed`: the acknowledgment came in its time, `after` the start.
 * - `failed`: no acknowledgment came in the time (`no-ack`), or it came late (`late-ack`).
 */
export type DrillVerdict =
  | { readonly state: "pending"; readonly until: Instant }
  | { readonly state: "passed"; readonly after: Duration }
  | { readonly state: "failed"; readonly why: "no-ack" | "late-ack" };

// The most changes of the windows that the search of the next start reads. Each change is one boundary of the window of
// the drill or of the quiet window. Thus a drill with a window in the quiet window gives no start, and the search stops.
const SEARCH_LIMIT = 64;

/**
 * This function joins two runs of one start into one run: the earlier acknowledgment counts. The join is idempotent,
 * commutative and associative.
 */
export function joinRuns(a: DrillRun, b: DrillRun): DrillRun {
  const acked = a.acked === undefined ? b.acked : b.acked === undefined ? a.acked : Math.min(a.acked, b.acked);
  return acked === undefined ? { drill: a.drill, at: a.at } : { drill: a.drill, at: a.at, acked };
}

/** This function gives the last run of the drill `id`: the run with the latest start, joined with each run of that start. */
export function lastRun(runs: readonly DrillRun[], id: string): DrillRun | undefined {
  let last: DrillRun | undefined;
  for (const run of runs) {
    if (run.drill !== id || !Number.isFinite(run.at)) continue;
    if (last === undefined || run.at > last.at) last = run;
    else if (run.at === last.at) last = joinRuns(last, run);
  }
  return last;
}

/** This function gives the verdict of the run of a drill at the time `at`. */
export function drillVerdict(drill: DrillConfig, run: DrillRun, at: Instant): DrillVerdict {
  const until = run.at + drill.ackWithin;
  if (run.acked !== undefined) return run.acked <= until ? { state: "passed", after: Math.max(0, run.acked - run.at) } : { state: "failed", why: "late-ack" };
  return at < until ? { state: "pending", until } : { state: "failed", why: "no-ack" };
}

/**
 * This function gives the next start of a drill at the time `at` or later. A timer can wait for it. The start is in the
 * window of the drill, and it is `every` or more after the last start. The time of the acknowledgment from the start
 * ends before the next quiet window of the person. Thus a drill does not wake the person in the quiet window.
 *
 * The function gives `undefined` for a bad window and for a bad quiet window. It also gives `undefined` with no start in
 * the next 64 changes of the two windows. Thus a drill with a window in the quiet window has no start.
 */
export function nextDrillAt(drill: DrillConfig, runs: readonly DrillRun[], at: Instant, quiet?: QuietWindow): Instant | undefined {
  const last = lastRun(runs, drill.id);
  let time = last === undefined ? at : Math.max(at, last.at + drill.every);
  for (let step = 0; step < SEARCH_LIMIT; step += 1) {
    const window = !inWindow(time, drill.window) ? drill.window : quiet !== undefined && inQuietWindow(quiet, time) ? quiet : undefined;
    if (window === undefined) {
      if (!Number.isFinite(time)) return undefined;
      // The next quiet window opens in the time of the acknowledgment: the search goes on from that opening.
      const opening = quiet === undefined ? undefined : nextBoundary(time, quiet);
      if (opening === undefined || opening.at >= time + drill.ackWithin) return time;
      time = opening.at;
      continue;
    }
    const boundary = nextBoundary(time, window);
    if (boundary === undefined) return undefined;
    time = boundary.at;
  }
  return undefined;
}

/** This function tells if the copy `copy` of the rank `rank` starts the drill. */
export function drillInCopy(drill: DrillConfig, copy: string, rank: number): boolean {
  return drill.copies === undefined ? rank === 0 : drill.copies.includes(copy);
}

/** This function tells if a drill starts at the time `at`: the next start of the drill is `at`. */
export function drillDue(drill: DrillConfig, runs: readonly DrillRun[], at: Instant, quiet?: QuietWindow): boolean {
  return nextDrillAt(drill, runs, at, quiet) === at;
}

/**
 * This function gives the start that a drill missed, or `undefined`. The missed start is the next start after the last
 * run. It is before `at`, and the drill is not due at `at`. Thus the window of that start ended with no run.
 *
 * - A copy that stops for the full window misses the start. At its next pass, the missed start is a fact.
 * - A late start in the same window is not a miss: the drill is due, and it tests the path.
 * - Before the first run, no start is missed: the configuration gives no time from which to count.
 * - A reload that makes a drill due earlier also gives a missed start, until the next run.
 */
export function missedDrillAt(drill: DrillConfig, runs: readonly DrillRun[], at: Instant, quiet?: QuietWindow): Instant | undefined {
  const last = lastRun(runs, drill.id);
  if (last === undefined) return undefined;
  const expected = nextDrillAt(drill, [last], last.at, quiet);
  return expected !== undefined && expected < at && !drillDue(drill, runs, at, quiet) ? expected : undefined;
}

/**
 * One drill that another copy starts, in the watch of this copy. A copy that stops for the full window of a start reports
 * nothing in that time. Thus each other copy watches the starts of that copy, and it tells of a start that did not come.
 */
export interface DrillWatch {
  readonly drill: DrillConfig;
  /** The quiet window of the person of the drill. */
  readonly quiet?: QuietWindow;
  /**
   * The copy that starts the drill: an id of the list `copies` of the drill. Without it, the copy of rank 0 starts the
   * drill, and each other copy can be that copy.
   */
  readonly copy?: string;
}

/**
 * The time after the end of the window of a start before the watch tells of a miss: 15 minutes. In this time, the
 * exchange brings a late start of the other copy. A read of the exchange comes each few seconds.
 */
export const DRILL_WATCH_GRACE: Duration = 15 * 60_000;

/** A start of a drill that the watch did not see (`watchedDrillMiss`). */
export interface DrillWatchMiss {
  /** The start that the watch did not see. */
  readonly due: Instant;
  /** The end of the window of that start. */
  readonly end: Instant;
  /**
   * The reason of the miss.
   *
   * - `unseen`: no read gives a start at `due` or later. The copy did not answer after the end of the window, or it did not start the drill.
   * - `no-read`: the copy answers after the end of the window, but its answers give no starts of drills. A copy of an older build gives none.
   */
  readonly why: "unseen" | "no-read";
  /** The last start of the drill in the reads. */
  readonly last?: Instant;
  /** The time of the last read that passed. */
  readonly read?: Instant;
}

// The state of one watch: the start that it waits for, the end of the window of that start, and the reads of the copies.
interface WatchState {
  readonly due: Instant;
  readonly end: Instant;
  readonly last?: Instant;
  readonly scope: readonly CopyWatch[];
}

// The due start of a watch is the next start after the last start in the reads. With no start in the reads, the count
// starts at the start of the watch. An open line keeps its start until a read gives a start at that time or later.
function watchState(watch: DrillWatch, copies: readonly CopyWatch[], held: Instant | undefined): WatchState | undefined {
  const { drill, quiet } = watch;
  const scope = copies.filter((entry) => watch.copy === undefined || entry.copy === watch.copy);
  if (scope.length === 0) return undefined;
  let last: Instant | undefined;
  for (const entry of scope) {
    const start = entry.drills?.[drill.id];
    if (start !== undefined && Number.isFinite(start) && (last === undefined || start > last)) last = start;
  }
  const since = Math.min(...scope.map((entry) => entry.since));
  const due =
    held !== undefined && (last === undefined || last < held)
      ? held
      : last === undefined
        ? nextDrillAt(drill, [], since, quiet)
        : nextDrillAt(drill, [{ drill: drill.id, at: last }], last, quiet);
  if (due === undefined || (last !== undefined && last >= due)) return undefined;
  // A late start in the window of the due start is not a miss. A window with no end gives the due start as its end.
  const end = nextBoundary(due, drill.window)?.at ?? due;
  return { due, end, ...(last === undefined ? {} : { last }), scope };
}

/**
 * This function gives the time when the watch tells of a miss: the end of the window of the due start, plus `grace`. It
 * gives `undefined` when the watch waits for no start. A timer can wait for the time.
 */
export function watchedDrillReportAt(watch: DrillWatch, copies: readonly CopyWatch[], held?: Instant, grace: Duration = DRILL_WATCH_GRACE): Instant | undefined {
  const state = watchState(watch, copies, held);
  return state === undefined ? undefined : state.end + grace;
}

/**
 * This function gives the start of a drill of another copy that this copy did not see at the time `at`, or `undefined`.
 * The function reads no clock.
 *
 * - The watch reads the copies of `copies` that can start the drill. Each read that passed gives the last start of each
 *   drill of its copy.
 * - The due start is the next start after the last start in the reads (`nextDrillAt`). With no start in the reads, the
 *   count starts at the start of the watch.
 * - The start `held` of an open line stays the due start until a read gives a start at that time or later. Thus a
 *   restart of this copy does not end the line.
 * - The miss is a fact at the end of the window of the due start, plus `grace`. A start at the due time or later ends it.
 * - A copy that answers with no starts of drills gives the reason `no-read`, not a pass. Thus a watch that cannot read tells it.
 */
export function watchedDrillMiss(watch: DrillWatch, copies: readonly CopyWatch[], at: Instant, held?: Instant, grace: Duration = DRILL_WATCH_GRACE): DrillWatchMiss | undefined {
  const state = watchState(watch, copies, held);
  if (state === undefined || at < state.end + grace) return undefined;
  const { due, end, last, scope } = state;
  const answered = scope.filter((entry) => entry.read !== undefined && entry.read.at >= end);
  const why = answered.length > 0 && answered.every((entry) => entry.drills === undefined) ? "no-read" : "unseen";
  const reads = scope.flatMap((entry) => (entry.read === undefined ? [] : [entry.read.at]));
  const read = reads.length === 0 ? undefined : Math.max(...reads);
  return { due, end, why, ...(last === undefined ? {} : { last }), ...(read === undefined ? {} : { read }) };
}

/**
 * The starts of the searches for a start of a drill: Monday 5 January and Monday 6 July 2026, 00:00 UTC. The windows
 * repeat each week in local time. Two windows in two zones move by an hour at a change of an offset. Thus each season
 * has its own search of 8 days, with no change of an offset in it.
 */
export const DRILL_PROBES: readonly Instant[] = [Date.UTC(2026, 0, 5), Date.UTC(2026, 6, 6)];

// A weekly window has each of its starts in 7 days. One more day keeps a start at the edge of the week.
const PROBE_SPAN: Duration = 8 * 24 * 3_600_000;

/**
 * This function gives the problems of one drill that a schema cannot find. `loadConfig` also checks the person, the
 * subject that the person watches, the policy of the person and the contact on the channel.
 *
 * - The time of the acknowledgment is above 0, and the least time between two starts is above it.
 * - The window has a good time zone and good local times.
 * - The drill has a start out of the quiet window of the person in each season (`DRILL_PROBES`). The time of the
 *   acknowledgment ends before the quiet window.
 * - The list of the copies is not empty, and it names each copy one time.
 * - The instance has the channel of the path, and the channel tells of an acknowledgment.
 */
export function drillProblems(drill: DrillConfig, channels: readonly ChannelDescriptor[], quiet?: QuietWindow): string[] {
  const problems: string[] = [];
  const name = `The drill ${drill.id}`;
  if (!Number.isFinite(drill.ackWithin) || drill.ackWithin <= 0) problems.push(`${name} has the time of the acknowledgment ${String(drill.ackWithin)}. It is a finite number above 0.`);
  // A new start in the time of the last run makes two runs that wait together. The second hides the verdict of the first.
  if (!Number.isFinite(drill.every) || !(drill.every > drill.ackWithin)) problems.push(`${name} has the least time between two starts ${String(drill.every)}. It is above the time of the acknowledgment.`);
  const windowed = windowProblems(drill.window);
  for (const problem of windowed) problems.push(`${name}: the window: ${problem}`);
  const timed = Number.isFinite(drill.ackWithin) && drill.ackWithin > 0;
  const missing = windowed.length === 0 && timed ? DRILL_PROBES.filter((from) => !((nextDrillAt(drill, [], from, quiet) ?? Infinity) < from + PROBE_SPAN)) : [];
  if (missing.length > 0) {
    const weeks = missing.map((from) => new Date(from).toISOString().slice(0, 10)).join(" and ");
    problems.push(`${name} has no start in the weeks from ${weeks}: each time of its window is in the quiet window of the person, or too near to it.`);
  }
  // An empty list of copies starts the drill in no copy, and nothing tells of it.
  if (drill.copies !== undefined && drill.copies.length === 0) problems.push(`${name} has an empty list of copies. No copy starts it.`);
  for (const copy of new Set((drill.copies ?? []).filter((copy, index, all) => all.indexOf(copy) !== index))) problems.push(`${name} names the copy ${copy} two times.`);
  const channel = channels.find((known) => known.id === drill.path.channel);
  if (channel === undefined) problems.push(`${name} uses the channel ${drill.path.channel}, and the instance has no such channel.`);
  else if (channel.ack === "none") problems.push(`${name} uses the channel ${drill.path.channel}, and the channel does not tell of an acknowledgment. The drill cannot pass.`);
  return problems;
}
