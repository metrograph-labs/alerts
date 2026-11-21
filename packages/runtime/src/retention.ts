/**
 * The retirement of old incidents in the runtime (AL-47). The core gives the rules: `retirements` and the tombstones of
 * the merge state. Thus the cost of a pass follows the recent incidents, not the age of the instance.
 *
 * - The fold retires on a cadence of the event time (AL-109). The step comes before the first event at `every` or more after
 *   the last step. Thus the live runtime and the rebuild of its log give the same state at each event.
 * - The step writes no event. A `retired` event of an older log still folds its lists.
 * - A quiet incident retires at the quiet horizon. It is not live, and it has no part that a later reader needs.
 */
import {
  incidents,
  QUIET_HORIZON,
  reportPasses,
  retirements,
  RETENTION_HORIZON,
  TOMBSTONE_LIFE,
  type Duration,
  type Expectation,
  type Incident,
  type Instant,
  type LinkRule,
  type ReportId,
} from "@mark1russell7/alerts";
import { envelope, frameTag, type RetiredEvent } from "./events.ts";
import { observingSources } from "./observe.ts";
import type { RuntimeState } from "./state.ts";

/** The default interval between two searches for retirements: one hour. */
export const RETIRE_EVERY: Duration = 3_600_000;

/** The options of the retention of the runtime. */
export interface RetentionOptions {
  /** The time after the last change of an incident before it retires. The default is `RETENTION_HORIZON` of the core. */
  readonly horizon?: Duration;
  /** The life of a tombstone. The default is `TOMBSTONE_LIFE` of the core. */
  readonly life?: Duration;
  /** The least time between two searches for retirements. The default is `RETIRE_EVERY`. */
  readonly every?: Duration;
  /**
   * The time after the last change of a quiet incident before it retires (AL-109). The default is `QUIET_HORIZON` of the
   * core, or the horizon when the horizon is shorter. `quietKeeps` tells which incidents are not quiet.
   */
  readonly quiet?: Duration;
}

/**
 * This function gives the options with each default.
 *
 * @throws Error when the horizon, the life or the quiet horizon is not a finite number of 0 or more.
 * @throws Error when the interval is not above 0, or when the quiet horizon is longer than the horizon.
 */
export function retention(options: RetentionOptions = {}): Required<RetentionOptions> {
  const every = options.every ?? RETIRE_EVERY;
  if (!Number.isFinite(every) || every <= 0) throw new Error(`The interval of the retirements is ${every}, not a finite number above 0.`);
  const horizon = checked("horizon", options.horizon ?? RETENTION_HORIZON);
  const quiet = checked("quiet horizon", options.quiet ?? Math.min(QUIET_HORIZON, horizon));
  if (quiet > horizon) throw new Error(`The quiet horizon of the retention is ${quiet}, longer than the horizon ${horizon}.`);
  return { horizon, life: checked("life", options.life ?? TOMBSTONE_LIFE), every, quiet };
}

/**
 * This function tells which incidents of a state are not quiet, thus they keep the horizon (AL-109). A later reader
 * needs each of these incidents:
 *
 * - An incident with an escalation, a hold or a suppression of this copy. The digest tells the holds and the suppressions later.
 * - An incident with a report of a source in observe mode. The verdict of the source counts its reports over its window.
 * - An incident with a report that starts the check of an expectation. The limit of the lateness reads the whole horizon.
 *
 * An incident with a delivery or an acknowledgment keeps the horizon in the core, thus this function does not examine them.
 */
export function quietKeeps(state: RuntimeState, expectations: readonly Expectation[]): (incident: Incident) => boolean {
  const held = new Set<ReportId>();
  for (const each of [...state.starts, ...state.holds, ...state.suppressions]) held.add(each.incident);
  const observing = observingSources(state);
  const reports = new Map(state.merge.reports.map((report) => [report.id, report]));
  const needed = (id: ReportId): boolean => {
    if (held.has(id)) return true;
    const report = reports.get(id);
    if (report === undefined) return false;
    return observing.has(report.source) || expectations.some((expectation) => expectation.from === report.source && reportPasses(expectation.when, report));
  };
  return (incident) => incident.reports.some(needed);
}

/**
 * This function gives the event that retires each old incident and old orphan key of the state at a time. It gives
 * `undefined` when nothing retires. The incidents come from the merge state of each copy. `link` is the link rule of the
 * delivery step and the view, thus the retirement removes only whole incidents of the delivery step. `expectations` are
 * the expectations of the view, for `quietKeeps`.
 *
 * - An orphan key is a cancelled key with no delivery in the merge. A new read of the log of another copy can bring back an old cancel.
 * - The delivery of an own retired incident does not come back with it. Thus the orphan goes at the horizon after its time of entry.
 * - A key with no time of entry stays. Only a cancel that folds before the first own event has no entry: the state has no time then.
 * - A tombstone keeps each retired orphan key cancelled for the routes. Thus a late delivery of the key gives no repeat.
 */
export function retiredEvent(
  state: RuntimeState,
  at: Instant,
  link: LinkRule,
  { horizon, life, quiet }: Required<RetentionOptions>,
  expectations: readonly Expectation[] = [],
): RetiredEvent | undefined {
  const found = incidents(state.merge, at, { link });
  const reports = retirements(state.merge, found, at, horizon, { horizon: quiet, keeps: quietKeeps(state, expectations) });
  const gone = new Set(reports);
  // A delivery key does not name its incident, thus the event names the cancelled keys of the deliveries of the incidents.
  const keys = new Set(state.merge.deliveries.filter((delivery) => gone.has(delivery.incident)).map((delivery) => delivery.key));
  const known = new Set(state.merge.deliveries.map((delivery) => delivery.key));
  const cancelled = state.cancelled.filter((key) => keys.has(key) || (!known.has(key) && isOld(state, key, at - horizon)));
  if (reports.length === 0 && cancelled.length === 0) return undefined;
  return { ...envelope("retired", `retired:${at}${frameTag(state.steps.length)}`, at), reports, until: at + life, cancelled };
}

// The cancelled key has a time of entry at or before old.
function isOld(state: RuntimeState, key: string, old: Instant): boolean {
  const since = Object.hasOwn(state.cancelledSince, key) ? state.cancelledSince[key] : undefined;
  return since !== undefined && since <= old;
}

// A time of the options: a finite number of 0 or more.
function checked(name: string, value: Duration): Duration {
  if (!Number.isFinite(value) || value < 0) throw new Error(`The ${name} of the retention is ${value}, not a finite number of 0 or more.`);
  return value;
}
