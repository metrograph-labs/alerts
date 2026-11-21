/**
 * This module holds the drills of this copy of the system (AL-43). It gives the drills that the copy starts and the start
 * of each due drill. It also gives the acknowledgment of each run and the next time when a drill changes. The functions
 * read no clock.
 */
import { DRILL_KIND, drillDue, drillInCopy, missedDrillAt, nextDrillAt, type DrillConfig, type DrillRun, type DrillSnapshot, type DrillWatch, type Instant, type QuietWindow, type Recipient } from "@mark1russell7/alerts";
import { envelope, frameTag, type DrillEvent } from "./events.ts";
import type { RuntimeState } from "./state.ts";

/** A drill that this copy starts, with the quiet window of its person. */
export interface CopyDrill {
  readonly drill: DrillConfig;
  readonly quiet?: QuietWindow;
}

/**
 * This function gives the drills that the copy `copy` of the rank `rank` starts (`drillInCopy`). Each drill has the
 * quiet window of its person. Thus the start of a drill does not come in the quiet window.
 */
export function copyDrills(drills: readonly DrillConfig[], recipients: readonly Recipient[], copy: string, rank: number): CopyDrill[] {
  return drills.flatMap((drill) => {
    if (!drillInCopy(drill, copy, rank)) return [];
    const quiet = recipients.find((recipient) => recipient.watch.person === drill.person)?.watch.quiet;
    return [quiet === undefined ? { drill } : { drill, quiet }];
  });
}

/**
 * This function gives the drills of other copies that the copy `copy` of the rank `rank` watches (`watchedDrillMiss`).
 * Each drill has the quiet window of its person, as in `copyDrills`.
 *
 * - A drill with a list of copies gives one watch for each copy of the list, other than `copy`.
 * - A drill with no list starts in the copy of rank 0. Each copy of another rank watches it, with no copy in the watch.
 * - The watch reads only the copies that are peers of this copy. It has no read of another copy.
 */
export function watchedDrills(drills: readonly DrillConfig[], recipients: readonly Recipient[], copy: string, rank: number): DrillWatch[] {
  return drills.flatMap((drill) => {
    const quiet = recipients.find((recipient) => recipient.watch.person === drill.person)?.watch.quiet;
    const watched = drill.copies === undefined ? (rank === 0 ? [] : [undefined]) : drill.copies.filter((other) => other !== copy);
    return watched.map((other): DrillWatch => ({ drill, ...(quiet === undefined ? {} : { quiet }), ...(other === undefined ? {} : { copy: other }) }));
  });
}

/**
 * This function gives the last run of a drill in the state, or `undefined` before the first start. The run has the
 * first acknowledgment of the person of the drill on the channel of its path. That acknowledgment is of a run report of
 * the copy after the start. An acknowledgment in the user interface or on another channel does not test the path.
 */
export function drillRunOf(state: Pick<RuntimeState, "drills" | "merge">, copy: string, drill: DrillConfig): DrillRun | undefined {
  const at = state.drills[drill.id];
  if (at === undefined) return undefined;
  const code = `${DRILL_KIND}.run`;
  const reports = new Set(
    state.merge.reports.flatMap((report) => (report.kind.code === code && report.parameters["drill"]?.[0] === drill.id && report.parameters["copy"]?.[0] === copy && report.onset !== undefined && report.onset >= at ? [report.id] : [])),
  );
  let acked: Instant | undefined;
  for (const ack of state.merge.acks) {
    if (ack.person !== drill.person || ack.via !== drill.path.channel || ack.at < at || !reports.has(ack.incident)) continue;
    if (acked === undefined || ack.at < acked) acked = ack.at;
  }
  return acked === undefined ? { drill: drill.id, at } : { drill: drill.id, at, acked };
}

/**
 * This function gives the events of the drills that start at the time `at`: each drill whose next start is `at`. The
 * id of an event has the drill, the copy and the time. Thus a write that repeats changes nothing.
 */
export function drillStarts(state: Pick<RuntimeState, "drills" | "steps">, drills: readonly CopyDrill[], copy: string, at: Instant): DrillEvent[] {
  return drills.flatMap(({ drill, quiet }) => {
    const last = state.drills[drill.id];
    if (!drillDue(drill, last === undefined ? [] : [{ drill: drill.id, at: last }], at, quiet)) return [];
    return [{ ...envelope("drill", `drill:${copy}:${drill.id}:${String(at)}${frameTag(state.steps.length)}`, at), drill: drill.id, copy }];
  });
}

/** The drills of a view: the snapshot of each drill for the system fold, and the next time when a drill changes. */
export interface DrillStep {
  readonly snapshots: readonly DrillSnapshot[];
  /** The next start of a drill, or the end of the time of the acknowledgment of a run that waits. It is after `at`. */
  readonly wakeAt?: Instant;
}

/**
 * This function gives the drills of the view at the time `at`. A drill with no next start has `noStart`, and the system
 * fold gives a failure for it. A run that waits for its acknowledgment changes at the end of its time.
 *
 * A drill whose last window ended with no run has `missed` (`missedDrillAt`). This is the case when the copy stopped
 * for the full window. The next pass after the restart gives the failure, and the next run ends it.
 */
export function drillStep(state: Pick<RuntimeState, "drills" | "merge">, drills: readonly CopyDrill[], copy: string, at: Instant): DrillStep {
  const times: Instant[] = [];
  const snapshots = drills.map(({ drill, quiet }): DrillSnapshot => {
    const run = drillRunOf(state, copy, drill);
    const runs = run === undefined ? [] : [run];
    const next = nextDrillAt(drill, runs, at, quiet);
    const missed = missedDrillAt(drill, runs, at, quiet);
    if (next !== undefined) times.push(next);
    if (run !== undefined && run.acked === undefined) times.push(run.at + drill.ackWithin);
    return { copy, drill, ...(run === undefined ? {} : { run }), ...(next === undefined ? { noStart: true } : {}), ...(missed === undefined ? {} : { missed }) };
  });
  const later = times.filter((time) => time > at);
  return later.length === 0 ? { snapshots } : { snapshots, wakeAt: Math.min(...later) };
}
