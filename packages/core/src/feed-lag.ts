/**
 * The lag of each feed (AL-14). The lag of a report is the time from its send time to its receipt by the adapter. It holds
 * the delay of the publication of the source and the interval of the reads of the runtime. The atlas gives the delay of most
 * sources as `unknown`. This measure gives the delay from the reports of the merge state.
 *
 * The function is a pure fold over the reports and the time. It reads no clock.
 */
import { median, quantileInterval } from "@mark1russell7/rigor-statistics";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Duration, Instant, Report, SourceId } from "./contracts.ts";

/** The default window of the sample: 7 days. A week holds the daily cycle and the weekly cycle of most feeds. */
export const FEED_LAG_WINDOW: Duration = 7 * 24 * 3_600_000;

/** The default confidence level of the intervals: 0.95. */
export const FEED_LAG_LEVEL = 0.95;

/** The options of `feedLags`. */
export interface FeedLagOptions {
  /** The time of the measure. A report with a receipt after this time is not in the sample. */
  readonly at: Instant;
  /** The length of the window of the sample before `at`. The default is `FEED_LAG_WINDOW`. */
  readonly window?: Duration;
  /** The confidence level of the intervals. The default is `FEED_LAG_LEVEL`. */
  readonly level?: number;
}

/** The lag of one source in the window. */
export interface FeedLag {
  readonly source: SourceId;
  /** The count of reports in the sample. */
  readonly count: number;
  /** The count of reports with a send time after their receipt, for example from a clock that is fast. Their lag is 0. */
  readonly ahead: number;
  /** The median of the lags. */
  readonly median: Duration;
  /** The lower bound of the median at the level. It is absent when the sample is too small. */
  readonly medianLow?: Duration;
  /** The upper bound of the median at the level. It is absent when the sample is too small. */
  readonly medianHigh?: Duration;
  /** The upper bound of the 90th percentile at the level. It is absent when the sample is too small. */
  readonly p90High?: Duration;
  /** The latest receipt in the sample. */
  readonly newest: Instant;
}

/**
 * This function gives the lag of each source with one report or more in the window, in the code unit order of the ids.
 *
 * - Each report id counts one time, with its earliest receipt.
 * - A report with a send time before the first receipt of its source is a backlog of the feed. The first read of a feed
 *   gets its old items, and their age is not a lag. Thus such a report is not in the sample.
 * - A report with a send time after its receipt has the lag 0, and it counts in `ahead`.
 * - A report with a time that is not a finite number is not in the sample.
 */
export function feedLags(reports: readonly Report[], options: FeedLagOptions): FeedLag[] {
  const window = options.window ?? FEED_LAG_WINDOW;
  const level = options.level ?? FEED_LAG_LEVEL;
  const from = options.at - window;
  const first = new Map<SourceId, Instant>();
  const earliest = new Map<string, Report>();
  for (const report of reports) {
    if (!Number.isFinite(report.received) || !Number.isFinite(report.sent) || report.received > options.at) continue;
    const known = first.get(report.source);
    if (known === undefined || report.received < known) first.set(report.source, report.received);
    const seen = earliest.get(report.id);
    if (seen === undefined || report.received < seen.received) earliest.set(report.id, report);
  }
  const samples = new Map<SourceId, { readonly lags: number[]; ahead: number; newest: Instant }>();
  for (const report of earliest.values()) {
    if (report.received < from) continue;
    const start = first.get(report.source);
    if (start === undefined || report.sent < start) continue;
    const sample = samples.get(report.source) ?? { lags: [], ahead: 0, newest: report.received };
    samples.set(report.source, sample);
    const lag = report.received - report.sent;
    if (lag < 0) sample.ahead += 1;
    sample.lags.push(Math.max(0, lag));
    sample.newest = Math.max(sample.newest, report.received);
  }
  return [...samples.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([source, sample]): FeedLag => {
      const middle = quantileInterval(sample.lags, 0.5, level);
      const high = quantileInterval(sample.lags, 0.9, level).high;
      return {
        source,
        count: sample.lags.length,
        ahead: sample.ahead,
        median: median(sample.lags),
        ...(Number.isFinite(middle.low) ? { medianLow: middle.low } : {}),
        ...(Number.isFinite(middle.high) ? { medianHigh: middle.high } : {}),
        ...(Number.isFinite(high) ? { p90High: high } : {}),
        newest: sample.newest,
      };
    });
}
