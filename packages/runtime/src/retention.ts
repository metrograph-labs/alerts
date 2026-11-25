/**
 * The retirement of old incidents in the runtime (AL-47). The core gives the rules: `retirements` and the tombstones of
 * the merge state. Thus the cost of a pass follows the recent incidents, not the age of the instance.
 *
 * - The fold retires on a cadence of the event time (AL-109). The step comes before the first event at `every` or more after
 *   the last step. Thus the live runtime and the rebuild of its log give the same state at each event.
 * - The step writes no event. A `retired` event of an older log still folds its lists.
 * - A quiet incident retires at the quiet horizon. It is not live, and it has no part that a later reader needs.
 * - An incident that a person knows retires at the time `told`, the quiet horizon by default (AL-172). It is not live,
 *   and each of its alerts has its cancel. A tombstone keeps a late copy of each report out, thus no alert goes again.
 * - An old report of a live incident leaves it when the incident keeps its values (AL-177, `lateRetirements` of the core).
 *   A report that a reader of the runtime needs stays. Thus a long stream of updates of one event has a bound.
 */
import {
  allRetirements,
  DRILL_KIND,
  incidents,
  OBSERVE_WINDOW,
  QUIET_HORIZON,
  reportPasses,
  RETENTION_HORIZON,
  SEND_LIMIT_MAX_WINDOW,
  THROTTLE_MAX_WINDOW,
  TOMBSTONE_LIFE,
  type Duration,
  type Expectation,
  type Incident,
  type Instant,
  type LinkRule,
  type Report,
  type ReportId,
} from "@mark1russell7/alerts";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { envelope, frameTag, type RetiredEvent } from "./events.ts";
import { observingSources } from "./observe.ts";
import type { RuntimeState } from "./state.ts";

/** The default interval between two searches for retirements: one hour. */
export const RETIRE_EVERY: Duration = 3_600_000;

/**
 * The time after an escalation start, a hold or a suppression that it keeps its incident (AL-172): one day. Its readers
 * are the send limits, the throttle, the held persons and the observe verdict. Each one reads a window of one day or less.
 * An incident that is not live gets no route, thus no other reader needs the entry.
 */
export const ENTRY_KEEP: Duration = Math.max(SEND_LIMIT_MAX_WINDOW, THROTTLE_MAX_WINDOW, OBSERVE_WINDOW);

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
  /**
   * The time after the last change of an incident that a person knows before it retires (AL-172). The default is the
   * quiet horizon. `quietKeeps` keeps such an incident for the horizon while a cancel of one of its alerts is not done.
   */
  readonly told?: Duration;
}

/**
 * This function gives the options with each default.
 *
 * @throws Error when the horizon, the life or the quiet horizon is not a finite number of 0 or more.
 * @throws Error when the interval is not above 0, or when the quiet horizon or the time `told` is longer than the horizon.
 */
export function retention(options: RetentionOptions = {}): Required<RetentionOptions> {
  const every = options.every ?? RETIRE_EVERY;
  if (!Number.isFinite(every) || every <= 0) throw new Error(`The interval of the retirements is ${every}, not a finite number above 0.`);
  const horizon = checked("horizon", options.horizon ?? RETENTION_HORIZON);
  const quiet = checked("quiet horizon", options.quiet ?? Math.min(QUIET_HORIZON, horizon));
  if (quiet > horizon) throw new Error(`The quiet horizon of the retention is ${quiet}, longer than the horizon ${horizon}.`);
  const told = checked("time told", options.told ?? quiet);
  if (told > horizon) throw new Error(`The time told of the retention is ${told}, longer than the horizon ${horizon}.`);
  return { horizon, life: checked("life", options.life ?? TOMBSTONE_LIFE), every, quiet, told };
}

/**
 * This function tells which incidents of a state are not quiet, thus they keep the horizon (AL-109). A later reader
 * needs each of these incidents:
 *
 * - An incident with an escalation start, a hold or a suppression of this copy, for `ENTRY_KEEP` after the time of the entry (AL-172).
 * - An incident with a report of a source in observe mode, for the observe window after the receipt of the report. The
 *   verdict of the source counts only the reports of its window (`OBSERVE_WINDOW`). After the window, the report is quiet (AL-172).
 * - An incident with a report that starts the check of an expectation. The limit of the lateness reads the whole horizon.
 *
 * - An incident with a delivery above the digest level whose key has no cancel (AL-172). The escalation cancels each alert
 *   of an incident at its end. Until the cancel is done, an alert can still ring. A digest gets no cancel.
 * - An incident with a run report of the last start of a drill (AL-187). The verdict of the run reads its acknowledgment
 *   from this incident (`drillRunOf`). A retirement of the incident turns a passed run into a failed run, and the failure calls.
 */
export function quietKeeps(state: RuntimeState, expectations: readonly Expectation[], at: Instant): (incident: Incident) => boolean {
  const { recent } = neededReports(state, expectations, at);
  return (incident) => incident.reports.some(recent);
}

/** The two tests of `neededReports`. */
interface Needed {
  /** The test of `quietKeeps`: an entry holds its report for `ENTRY_KEEP`. */
  readonly recent: (id: ReportId) => boolean;
  /** The test of `lateRetirements`: each entry holds its report. */
  readonly always: (id: ReportId) => boolean;
}

/**
 * This function tells which reports of a state a reader of the runtime needs at a time: the reports of the list of
 * `quietKeeps`. An escalation start, a hold or a suppression holds its report for `ENTRY_KEEP` in the test `recent`, and
 * at any age in the test `always`. An entry names the anchor of its incident at its time. One pass of the state gives both tests.
 */
function neededReports(state: RuntimeState, expectations: readonly Expectation[], at: Instant): Needed {
  const held = new Set<ReportId>();
  const entries = new Set<ReportId>();
  const since = at - ENTRY_KEEP;
  for (const each of [...state.starts, ...state.holds, ...state.suppressions]) {
    entries.add(each.incident);
    if (each.at >= since) held.add(each.incident);
  }
  const observing = observingSources(state);
  const counted = at - OBSERVE_WINDOW;
  const cancelled = new Set(state.cancelled);
  for (const delivery of state.merge.deliveries) if (delivery.level !== "digest" && !cancelled.has(delivery.key)) held.add(delivery.incident);
  const reports = new Map(state.merge.reports.map((report) => [report.id, report]));
  // The run reports of the last start of each drill: the filter of `drillRunOf`, with no copy and no config. One pass of
  // the reports at each step finds them, not a test in `needed`: the core reads `needed` for each report of each incident.
  if (Object.keys(state.drills).length > 0) for (const report of state.merge.reports) if (lastRun(state, report)) held.add(report.id);
  const needed = (id: ReportId): boolean => {
    if (held.has(id)) return true;
    const report = reports.get(id);
    if (report === undefined) return false;
    return (observing.has(report.source) && report.received >= counted) || expectations.some((expectation) => expectation.from === report.source && reportPasses(expectation.when, report));
  };
  return { recent: needed, always: (id) => entries.has(id) || needed(id) };
}

const DRILL_RUN = `${DRILL_KIND}.run`;

// The report is a run of the last start of its drill (AL-187).
function lastRun(state: RuntimeState, report: Report): boolean {
  if (report.kind.code !== DRILL_RUN || report.onset === undefined) return false;
  const start = state.drills[report.parameters["drill"]?.[0] ?? ""];
  return start !== undefined && report.onset >= start;
}

/**
 * This function gives the event that retires each old incident and old orphan key of the state at a time. It gives
 * `undefined` when nothing retires. The incidents come from the merge state of each copy. `link` is the link rule of the
 * delivery step and the view, thus the retirement keeps the groups of the delivery step. `expectations` are
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
  { horizon, life, quiet, told }: Required<RetentionOptions>,
  expectations: readonly Expectation[] = [],
): RetiredEvent | undefined {
  const found = incidents(state.merge, at, { link });
  const needed = neededReports(state, expectations, at);
  const rule = { horizon: quiet, told, keeps: (incident: Incident) => incident.reports.some(needed.recent) };
  // The reports of a live incident that leave it (AL-177). No delivery names them, thus they add no key.
  const { whole, late } = allRetirements(state.merge, found, at, horizon, rule, { link, keeps: needed.always });
  const reports = late.length === 0 ? whole : [...whole, ...late].sort(compareCodeUnits);
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
