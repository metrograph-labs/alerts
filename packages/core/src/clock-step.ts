/**
 * This module holds the steps of the wall clock. A step changes the wall clock and not the monotonic clock, for
 * example a correction of the system time. The runtime then moves each of its own instants by the size of the step.
 * Thus each own instant keeps its distance on the monotonic clock, and each timer comes at its time.
 *
 * The instants of others do not move, because they come from the clocks of the sources and the channels. They are
 * the times of a report of a source, `asOf` of an end mark and the time of an acknowledgment. The times of a report
 * of a source are `sent`, `effective`, `onset`, `expires` and `ends`. The system reports are own reports, thus each
 * of their instants moves.
 */
import type { Acknowledgment, Delivery, Duration, EndMark, Instant, MergeState, Report } from "./contracts.ts";
import type { EscalationEnd, EscalationStart } from "./delivery.ts";
import type { HealthTrack } from "./health.ts";
import { normalize } from "./merge.ts";
import { SYSTEM_SOURCE } from "./contracts.ts";

/** A change of the wall clock against the monotonic clock larger than this size is a step. A smaller change is a drift. */
export const CLOCK_STEP_ABOVE: Duration = 2000;

const by = (instant: Instant, size: Duration): Instant => instant + size;

/** This function moves the own instants of a report. A system report moves each instant. A report of a source moves only `received`. */
export function shiftReport(report: Report, size: Duration): Report {
  if (report.source !== SYSTEM_SOURCE) return { ...report, received: by(report.received, size) };
  return {
    ...report,
    sent: by(report.sent, size),
    received: by(report.received, size),
    ...(report.effective === undefined ? {} : { effective: by(report.effective, size) }),
    ...(report.onset === undefined ? {} : { onset: by(report.onset, size) }),
    ...(report.expires === undefined ? {} : { expires: by(report.expires, size) }),
    ...(report.ends === undefined ? {} : { ends: by(report.ends, size) }),
  };
}

/** This function moves the time of a delivery: the time at which the channel accepted the message. */
export function shiftDelivery(delivery: Delivery, size: Duration): Delivery {
  return { ...delivery, at: by(delivery.at, size) };
}

/** This function moves the time of an end mark. Its `asOf` is the time of the data of the source, thus it does not move. */
export function shiftEndMark(mark: EndMark, size: Duration): EndMark {
  return { ...mark, at: by(mark.at, size) };
}

/** This function moves the own instants of the parts of a merge state, and gives its normal form. An acknowledgment does not move. */
export function shiftMerge(state: MergeState, size: Duration): MergeState {
  const acks: readonly Acknowledgment[] = state.acks;
  return normalize({
    reports: state.reports.map((report) => shiftReport(report, size)),
    deliveries: state.deliveries.map((delivery) => shiftDelivery(delivery, size)),
    acks,
    ends: state.ends.map((mark) => shiftEndMark(mark, size)),
    // The runtime sets the end of a tombstone from its own clock, thus the end moves.
    retired: state.retired.map((tombstone) => ({ ...tombstone, until: by(tombstone.until, size) })),
  });
}

/** This function moves each instant of a health track. Each time of the track comes from the fetches of the runtime. */
export function shiftHealth(track: HealthTrack, size: Duration): HealthTrack {
  return {
    ...track,
    since: by(track.since, size),
    time: by(track.time, size),
    staleFrom: by(track.staleFrom, size),
    ...(track.quietFrom === undefined ? {} : { quietFrom: by(track.quietFrom, size) }),
    ...(track.passed === undefined ? {} : { passed: { ...track.passed, at: by(track.passed.at, size) } }),
    ...(track.lastFailure === undefined ? {} : { lastFailure: { ...track.lastFailure, at: by(track.lastFailure.at, size) } }),
  };
}

/** This function moves the time of the start of an escalation. */
export function shiftEscalationStart(start: EscalationStart, size: Duration): EscalationStart {
  return { ...start, at: by(start.at, size) };
}

/** This function moves the time of the end of an escalation. */
export function shiftEscalationEnd(end: EscalationEnd, size: Duration): EscalationEnd {
  return { ...end, at: by(end.at, size) };
}
