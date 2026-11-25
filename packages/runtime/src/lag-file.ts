/**
 * The file of the lag of each feed (AL-14). For each source, the file gives the median lag with its bounds. The lag of a
 * report is the time from its send time to its receipt. The sample is the reports of the merge state. The atlas gives the delay of most sources as
 * `unknown`. This file gives the measured delay.
 *
 * The runtime writes the file `lag.json` of its private folder at most one time in each `LAG_EVERY`. The measure reads
 * each report of the merge state, thus a pass does not compute it. Other programs on the same computer read the file.
 */

import { feedLags, FEED_LAG_LEVEL, FEED_LAG_WINDOW, type Duration, type FeedLag, type Instant, type Report } from "@mark1russell7/alerts";
import { latestFile, type LatestFileOptions } from "./latest-file.ts";

/** The name of the file of the lag of each feed in the private folder of the runtime. */
export const LAG_FILE = "lag.json";

/** The format of the file. A change that a reader cannot read gets a new number. */
export const LAG_FORMAT = "alerts-lag/1";

/** The shortest time between two measures: one hour. The lag of a feed changes slowly. */
export const LAG_EVERY: Duration = 3_600_000;

/** The lag of one source, with each time as an ISO 8601 text and each duration in milliseconds. */
export interface LagFileEntry extends Omit<FeedLag, "newest"> {
  /** The latest receipt in the sample. */
  readonly newest: string;
}

/** The text of the file. */
export interface LagFile {
  readonly format: typeof LAG_FORMAT;
  /** The time of the measure. */
  readonly at: string;
  /** The length of the window of the sample before the time of the measure. */
  readonly window: Duration;
  /** The confidence level of the bounds. */
  readonly level: number;
  /** Each source with one report or more in the window, in the code unit order of the ids. */
  readonly sources: readonly LagFileEntry[];
}

/** The options of the writer of the file. */
export interface LagFileOptions extends LatestFileOptions {
  /** The shortest time between two measures. The default is `LAG_EVERY`. */
  readonly every?: Duration;
}

/** The writer of the file of the lag of each feed. */
export interface LagFileWriter {
  /**
   * This method measures the lag and writes the file, when the last measure is `every` or more before `at`. It reads the
   * reports only then. It does not wait for the write, and it does not throw.
   */
  update(at: Instant, reports: () => readonly Report[]): void;
  /** This method gives a promise that ends when no write is in progress. */
  idle(): Promise<void>;
}

/** This function gives the text of the file for a time and the reports. */
export function lagFileText(at: Instant, reports: readonly Report[]): string {
  const file: LagFile = {
    format: LAG_FORMAT,
    at: iso(at),
    window: FEED_LAG_WINDOW,
    level: FEED_LAG_LEVEL,
    sources: feedLags(reports, { at }).map((lag) => ({ ...lag, newest: iso(lag.newest) })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * This function makes the writer of the file. The first update measures at once. A time before the last measure, for
 * example after a step back of the clock, also measures again.
 */
export function lagFile(options: LagFileOptions): LagFileWriter {
  const every = options.every ?? LAG_EVERY;
  const file = latestFile(options);
  let last: Instant | undefined;
  return {
    update(at, reports) {
      if (last !== undefined && at >= last && at - last < every) return;
      let text: string;
      try {
        text = lagFileText(at, reports());
      } catch (error) {
        // The alerts do not need the measure, thus a fault goes to the handler and the next update tries again.
        try {
          options.onError(error);
        } catch {
          // A fault of the error handler does not stop the pass.
        }
        return;
      }
      last = at;
      file.update(text);
    },
    idle: () => file.idle(),
  };
}

function iso(at: Instant): string {
  return new Date(at).toISOString();
}
