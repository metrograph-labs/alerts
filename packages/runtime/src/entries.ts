/**
 * This module holds the times of entry of the parts of other copies on this copy (AL-18). An import has the times of the
 * clock of the other copy. The history needs the time at which this copy knew each part. The runtime appends the exchange
 * event of a read after the imports of the read, with the time of this copy. Thus the index is a fold of the log, next to
 * the state, and a restart gives the same index.
 */
import type { EndMark, EntryTimes, Instant, MergeState, ReportId } from "@mark1russell7/alerts";
import type { RuntimeEvent } from "./events.ts";

/** The index of the times of entry of the imported reports and end marks. */
export interface EntryIndex {
  /** This function folds one event of the log. The events come in the order of the log. */
  add(event: RuntimeEvent): void;
  /** This function drops each time of a report that the merge state does not have. */
  prune(merge: Pick<MergeState, "reports">): void;
  /**
   * This function gives the times of entry for a state. An own part has its own time, because a step of the clock moved
   * it with the stamps. A part of both sides gets the earlier time.
   */
  times(own: MergeState): EntryTimes;
  /** The count of the stamps and of the parts that wait for their exchange event. */
  readonly size: number;
}

// The key of an end mark of a report: its time and its kind. The id of the report is the key of the outer map.
const markKey = (mark: Pick<EndMark, "at" | "ended">): string => `${mark.at} ${mark.ended ? "ended" : "back"}`;

// The earlier of two times, or undefined with no time.
const earlier = (a: Instant | undefined, b: Instant | undefined): Instant | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** This function gives an empty index. */
export function entryIndex(): EntryIndex {
  const reports = new Map<ReportId, Instant>();
  const marks = new Map<ReportId, Map<string, Instant>>();
  // The parts of the imports of each copy that wait for the exchange event of their read.
  const waiting = new Map<string, { reports: ReportId[]; marks: [ReportId, string][] }>();
  const waitOf = (copy: string): { reports: ReportId[]; marks: [ReportId, string][] } => {
    const held = waiting.get(copy) ?? { reports: [], marks: [] };
    waiting.set(copy, held);
    return held;
  };

  return {
    add(event) {
      switch (event.type) {
        case "import": {
          const inner = event.event;
          if (inner.type === "fetch") waitOf(event.from).reports.push(...inner.reports.map((report) => report.id));
          else if (inner.type === "ended" || inner.type === "back") {
            const key = markKey({ at: inner.time, ended: inner.type === "ended" });
            waitOf(event.from).marks.push(...inner.reports.map((report): [ReportId, string] => [report, key]));
          }
          return;
        }
        case "exchange": {
          // The first stamp of a part stays: a later read of the part changes nothing.
          const held = waiting.get(event.peer);
          waiting.delete(event.peer);
          for (const id of held?.reports ?? []) if (!reports.has(id)) reports.set(id, event.time);
          for (const [id, key] of held?.marks ?? []) {
            const own = marks.get(id) ?? new Map<string, Instant>();
            if (!own.has(key)) own.set(key, event.time);
            marks.set(id, own);
          }
          return;
        }
        case "clock": {
          // A step moves the own parts before it. The stamps are times of this copy, thus the step moves them too.
          for (const [id, at] of reports) reports.set(id, at + event.size);
          for (const own of marks.values()) for (const [key, at] of own) own.set(key, at + event.size);
          return;
        }
        case "retired":
          for (const id of event.reports) {
            reports.delete(id);
            marks.delete(id);
          }
          return;
        default:
          return;
      }
    },
    prune(merge) {
      const known = new Set(merge.reports.map((report) => report.id));
      for (const id of reports.keys()) if (!known.has(id)) reports.delete(id);
      for (const id of marks.keys()) if (!known.has(id)) marks.delete(id);
    },
    times(own) {
      const received = new Map(own.reports.map((report) => [report.id, report.received]));
      const ownMarks = new Set(own.ends.map((mark) => `${mark.report} ${markKey(mark)}`));
      return {
        report: (report) => earlier(received.get(report.id), reports.get(report.id)) ?? report.received,
        mark: (mark) => earlier(ownMarks.has(`${mark.report} ${markKey(mark)}`) ? mark.at : undefined, marks.get(mark.report)?.get(markKey(mark))) ?? mark.at,
      };
    },
    get size() {
      let count = reports.size;
      for (const own of marks.values()) count += own.size;
      for (const held of waiting.values()) count += held.reports.length + held.marks.length;
      return count;
    },
  };
}
