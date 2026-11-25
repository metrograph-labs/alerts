/**
 * The check of the lines of a decoder against one header, for the tests and for the CI job of the decoder. The root of
 * the package does not export it.
 *
 * The check puts the lines in a feed, makes the weather radio source on it, and fetches. It passes when the fetch gives
 * the observation of the header, the map gives one report of a test, and the canary check passes.
 */

import type { Instant } from "@mark1russell7/alerts";
import { createLineFeed, type LineFeed } from "./feed.ts";
import { createNwrSource } from "./index.ts";

/** The result of the check. */
export interface DecodeCheck {
  readonly pass: boolean;
  /** The reason of each failure. It is empty when the check passes. */
  readonly failures: readonly string[];
  /** The body of each observation of the fetch. */
  readonly bodies: readonly string[];
}

/** The options of the check. */
export interface DecodeCheckOptions {
  /** The header that the audio has. */
  readonly header: string;
  /** The time of the fetch. */
  readonly now: Instant;
  /** The time of the first line. The default is one minute before the fetch. Each next line comes one second later. */
  readonly first?: Instant;
}

/** This function puts each line in a new feed, one second apart. */
export function feedOf(lines: readonly string[], first: Instant): LineFeed {
  const feed = createLineFeed(Math.max(1, lines.length));
  feed.start(first);
  lines.forEach((line, i) => feed.add(line, first + i * 1000));
  return feed;
}

/** This function examines the lines of a decoder. */
export async function checkDecodedLines(lines: readonly string[], options: DecodeCheckOptions): Promise<DecodeCheck> {
  return checkFeed(feedOf(lines, options.first ?? options.now - 60_000), options);
}

/** This function examines a feed that a receiver filled. */
export async function checkFeed(feed: LineFeed, options: Pick<DecodeCheckOptions, "header" | "now">): Promise<DecodeCheck> {
  const source = createNwrSource({ feed, clock: { now: () => options.now }, coverage: [] });
  const outcome = await source.fetch({ watch: { places: [] } });
  if (!outcome.ok) return { pass: false, failures: [`the fetch failed: ${outcome.failure.message}`], bodies: [] };
  const failures: string[] = [];
  const bodies = outcome.observations.map((observation) => observation.body);
  const mine = outcome.observations.filter((observation) => observation.body === options.header);
  if (mine.length === 0) failures.push(`no observation has the header ${options.header}`);
  const others = bodies.filter((body) => body !== options.header);
  if (others.length > 0) failures.push(`the fetch gave other headers: ${others.join(", ")}`);
  const observation = mine[0];
  if (observation !== undefined) {
    const mapped = source.map({ observation });
    const report = mapped.reports[0];
    if (mapped.reports.length !== 1 || report === undefined) failures.push(`the map gave ${String(mapped.reports.length)} reports`);
    else if (report.status !== "test") failures.push(`the status of the report is ${report.status}, not test`);
    const canary = source.check?.({ observations: outcome.observations });
    if (canary?.pass !== true) failures.push(`the canary check did not pass: ${canary?.reason ?? "no read"}`);
  }
  return { pass: failures.length === 0, failures, bodies };
}
