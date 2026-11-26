/**
 * The age limit of a canary from the measured publish times of a source (AL-207). A canary fails when the newest item
 * of a fetch is older than its limit. The largest normal age of the newest item is the largest normal gap between two
 * publications. So the limit is the upper bound of a high quantile of the measured gaps, plus a margin.
 *
 * The functions are pure. They read no clock. The same record gives the same limit, so a test can pin each limit.
 */
import type { Duration, Instant } from "./contracts.ts";
import { delayLimit, type DelayLimitOptions } from "./lateness.ts";

/**
 * The default quantile and level of a canary limit: the upper bound of the 99th percentile of the gaps, at the level
 * 0.95. The runtime uses the same values for the limits of the lateness. The bound needs a record of 368 gaps or more.
 */
export const CANARY_LIMITS: DelayLimitOptions = { quantile: 0.99, level: 0.95 };

/** The options of `canaryLimit`. */
export interface CanaryLimitOptions {
  /**
   * The time that the limit adds to the bound of the gaps. It holds the delay from the time of an item to its
   * publication, and the resolution of the times of the record. A record of dates has a resolution of one day.
   */
  readonly margin: Duration;
  /** The quantile of the gaps. The default is the quantile of `CANARY_LIMITS`. */
  readonly quantile?: number;
  /** The level of confidence of the upper bound. The default is the level of `CANARY_LIMITS`. */
  readonly level?: number;
}

/**
 * This function gives the gaps between the publications of a record, in the order of the times. Each time counts one
 * time, because one publication can hold many items. A time that is not a finite number is not in the record.
 */
export function publishGaps(times: readonly Instant[]): Duration[] {
  const sorted = [...new Set(times.filter((time) => Number.isFinite(time)))].sort((a, b) => a - b);
  const gaps: Duration[] = [];
  for (let index = 1; index < sorted.length; index += 1) gaps.push(sorted[index]! - sorted[index - 1]!);
  return gaps;
}

/**
 * This function gives the age limit of a canary from the publish times of a source: the upper bound of the quantile
 * of the gaps (`publishGaps`), plus the margin. The bound comes from `quantileInterval` of rigor-statistics, through
 * `delayLimit`. A record with too few gaps for an upper bound gives `undefined`: no limit.
 */
export function canaryLimit(times: readonly Instant[], options: CanaryLimitOptions): Duration | undefined {
  const bound = delayLimit(publishGaps(times), { quantile: options.quantile ?? CANARY_LIMITS.quantile, level: options.level ?? CANARY_LIMITS.level });
  return bound === undefined ? undefined : bound + options.margin;
}
