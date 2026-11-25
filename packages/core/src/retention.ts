/**
 * The retention of the merge state (AL-47). An incident that ended long ago leaves the merge state as a whole. The
 * event log keeps each of its reports. Thus the cost of a pass follows the recent incidents, not the age of the instance.
 *
 * - `retirements` gives the reports of each whole incident that is not live and has no change in the horizon.
 *   With a quiet rule, an incident that sent nothing to a person retires after the shorter quiet horizon (AL-109).
 *   With the field `told` of the rule, an incident that a person knows retires after that time (AL-172).
 * - `retire` gives them tombstones. A tombstone keeps a late copy of a report out of the state.
 *   An example is a copy from the log of another copy of the system.
 * - `pruneTombstones` drops each tombstone after its time `until`, thus the tombstones also have a bound.
 *
 * A retirement removes whole incidents. The groups of reports are the connected components of the links, thus the
 * removal of a whole group changes no other group. The test of this module holds it.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Duration, Incident, Instant, MergeState, ReportId } from "./contracts.ts";
import { add } from "./merge.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The default horizon: an incident leaves the merge state 7 days after its last change. */
export const RETENTION_HORIZON: Duration = 7 * DAY;

/**
 * The default horizon of a quiet incident (AL-109): 6 hours. Most incidents send nothing to a person, for example an
 * alert of a far area. They are most of the merge state, thus this horizon sets the memory of the state.
 */
export const QUIET_HORIZON: Duration = 6 * HOUR;

/**
 * The early retirement of a quiet incident (AL-109). A quiet incident has no delivery and no acknowledgment of a
 * report. Thus no person knows it, and no escalation, end message or repeat applies to it.
 */
export interface QuietRule {
  /** The time after the last change of a quiet incident before it retires. A value above the horizon gives the horizon. */
  readonly horizon: Duration;
  /**
   * This function tells if a reader keeps a quiet incident for the full horizon. An example is a check that counts the
   * incidents of a source over a longer window. The default keeps no incident.
   */
  readonly keeps?: ((incident: Incident) => boolean) | undefined;
  /**
   * The time after the last change of an incident that a person knows before it retires (AL-172). The default is the
   * horizon. A value above the horizon gives the horizon. The rule `keeps` also keeps such an incident for the horizon,
   * for example while a cancel of one of its alerts is not done. A tombstone keeps a late copy of each report out.
   */
  readonly told?: Duration | undefined;
}

/**
 * The default life of a tombstone: 30 days. A feed lists a report for approximately 30 days at most, for example the
 * feed of the earthquakes of the last 30 days. A new copy of the system that fetches the report gives it while the
 * tombstone is there, thus the report stays out.
 */
export const TOMBSTONE_LIFE: Duration = 30 * DAY;

/**
 * This function gives the reports to retire at a time, in the order of their ids. `found` is the incidents of `state`
 * at `at`. An incident retires as a whole when it is not live and its last change is at or before `at - horizon`.
 * With the rule `quiet`, a quiet incident that the rule does not keep retires at `at - quiet.horizon`. An incident that a
 * person knows and that the rule does not keep retires at `at - quiet.told`.
 *
 * The last change of an incident is the latest time of its parts. These are the sent, received and expiry times of its
 * reports, and the times of their end marks, deliveries and acknowledgments. Thus an expiry in the future keeps a
 * cancelled report. Each error is on the safe side: an incident stays longer, not shorter.
 */
export function retirements(state: MergeState, found: readonly Incident[], at: Instant, horizon: Duration = RETENTION_HORIZON, quiet?: QuietRule): ReportId[] {
  const changed = new Map<ReportId, Instant>();
  const touch = (report: ReportId, time: Instant): void => {
    const held = changed.get(report);
    if (held === undefined || time > held) changed.set(report, time);
  };
  for (const report of state.reports) touch(report.id, Math.max(report.sent, report.received, report.expires ?? -Infinity));
  for (const mark of state.ends) touch(mark.report, mark.at);
  for (const delivery of state.deliveries) touch(delivery.incident, delivery.at);
  for (const ack of state.acks) touch(ack.incident, ack.at);
  const long = Math.max(0, horizon);
  const limit = at - long;
  // The reports that a person knows: each delivery and each acknowledgment names a report of its incident.
  const told = new Set<ReportId>();
  for (const delivery of state.deliveries) told.add(delivery.incident);
  for (const ack of state.acks) told.add(ack.incident);
  const shorter = (time: Duration | undefined): Instant => (time === undefined ? limit : at - Math.min(long, Math.max(0, time)));
  const quietLimit = quiet === undefined ? limit : shorter(quiet.horizon);
  const toldLimit = quiet === undefined ? limit : shorter(quiet.told);
  const limitOf = (incident: Incident): Instant => {
    if (quiet === undefined || (quiet.keeps?.(incident) ?? false)) return limit;
    return incident.reports.some((report) => told.has(report)) ? toldLimit : quietLimit;
  };
  return found
    .filter((incident) => {
      if (incident.live) return false;
      const until = limitOf(incident);
      return incident.reports.every((report) => (changed.get(report) ?? Infinity) <= until);
    })
    .flatMap((incident) => incident.reports)
    .sort(compareCodeUnits);
}

/** This function gives the state with a tombstone for each report, until the time `until`. It removes the parts of the reports. */
export function retire(state: MergeState, reports: readonly ReportId[], until: Instant): MergeState {
  return add(state, { retired: reports.map((report) => ({ report, until })) });
}

/** This function drops each tombstone with its time `until` at or before `at`. It brings back no part. */
export function pruneTombstones(state: MergeState, at: Instant): MergeState {
  const retired = state.retired.filter((tombstone) => tombstone.until > at);
  return retired.length === state.retired.length ? state : { ...state, retired };
}

