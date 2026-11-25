import { median, quantileInterval } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import type { ObservationId, Report, SourceId } from "./contracts.ts";
import { FEED_LAG_WINDOW, feedLags } from "./feed-lag.ts";
import { reportId } from "./ids.ts";

const MINUTE = 60_000;
const QUAKES = "quakes" as SourceId;
const WARNINGS = "warnings" as SourceId;

/** This function gives a report of a source with a send time and a receipt. */
function report(source: SourceId, key: string, sent: number, received: number): Report {
  return {
    id: reportId({ source, key, sent }),
    source,
    origin: "test",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "geo.earthquake", label: "Earthquake" },
    categories: ["geo"],
    severity: "minor",
    urgency: "past",
    certainty: "observed",
    response: ["none"],
    sent,
    received,
    areas: [],
    about: [],
    sender: "test",
    headline: "Earthquake",
    observation: `observation:${source}:${key}` as ObservationId,
    parameters: {},
  };
}

describe("feedLags", () => {
  it("gives the median and its bounds from the lag of each report", () => {
    // The first report starts the source. Each next report has a lag of k minutes.
    const reports = [report(QUAKES, "start", 0, 0), ...Array.from({ length: 40 }, (_, k) => report(QUAKES, `e${String(k)}`, (k + 1) * 60 * MINUTE, (k + 1) * 60 * MINUTE + k * MINUTE))];
    const [lag] = feedLags(reports, { at: 100 * 60 * MINUTE });
    const lags = [0, ...Array.from({ length: 40 }, (_, k) => k * MINUTE)];
    expect(lag?.source).toBe(QUAKES);
    expect(lag?.count).toBe(41);
    expect(lag?.ahead).toBe(0);
    expect(lag?.median).toBe(median(lags));
    const middle = quantileInterval(lags, 0.5, 0.95);
    expect([lag?.medianLow, lag?.medianHigh]).toEqual([middle.low, middle.high]);
    expect(lag?.p90High).toBe(quantileInterval(lags, 0.9, 0.95).high);
    expect(lag?.newest).toBe(40 * 60 * MINUTE + 39 * MINUTE);
  });

  it("leaves out the backlog of the first read of a feed", () => {
    // The first read gets two old items. Their send time is before the first receipt, thus they are not a lag.
    const reports = [report(QUAKES, "old1", 0, 500 * MINUTE), report(QUAKES, "old2", 100 * MINUTE, 500 * MINUTE), report(QUAKES, "new", 600 * MINUTE, 603 * MINUTE)];
    const [lag] = feedLags(reports, { at: 700 * MINUTE });
    expect(lag?.count).toBe(1);
    expect(lag?.median).toBe(3 * MINUTE);
  });

  it("counts each report id one time, with its earliest receipt", () => {
    const first = report(QUAKES, "e", 10 * MINUTE, 10 * MINUTE);
    const again = { ...first, received: 50 * MINUTE };
    const [lag] = feedLags([first, again], { at: 60 * MINUTE });
    expect([lag?.count, lag?.median]).toEqual([1, 0]);
  });

  it("gives a lag of 0 to a report sent after its receipt, and counts it as ahead", () => {
    const [lag] = feedLags([report(WARNINGS, "a", 0, 0), report(WARNINGS, "b", 12 * MINUTE, 10 * MINUTE)], { at: 20 * MINUTE });
    expect([lag?.count, lag?.ahead, lag?.median]).toEqual([2, 1, 0]);
  });

  it("keeps only the window before the time, and gives no bound for a small sample", () => {
    const at = FEED_LAG_WINDOW + 100 * MINUTE;
    const reports = [report(WARNINGS, "start", 0, 0), report(WARNINGS, "in", at - 10 * MINUTE, at - 8 * MINUTE), report(WARNINGS, "later", at + MINUTE, at + 2 * MINUTE)];
    const [lag] = feedLags(reports, { at });
    expect(lag?.count).toBe(1);
    expect(lag?.median).toBe(2 * MINUTE);
    expect(lag?.medianLow).toBeUndefined();
    expect(lag?.medianHigh).toBeUndefined();
    expect(lag?.p90High).toBeUndefined();
  });

  it("gives the sources in code unit order, and no entry for a source with no report in the window", () => {
    // Each source starts at 0. Thus each next report is a lag, not a backlog.
    const starts = [WARNINGS, QUAKES].map((source) => report(source, "start", 0, 0));
    const reports = [...starts, report(WARNINGS, "w", 0, MINUTE), report(QUAKES, "q", 0, 2 * MINUTE), report("aside" as SourceId, "x", 0, 0)];
    expect(feedLags(reports, { at: 10 * MINUTE }).map((lag) => lag.source)).toEqual(["aside", QUAKES, WARNINGS]);
    expect(feedLags(reports, { at: 10 * MINUTE, window: MINUTE / 2 })).toEqual([]);
  });

  it("leaves out a report with a time that is not a finite number", () => {
    const [lag] = feedLags([report(QUAKES, "a", 0, 0), { ...report(QUAKES, "b", MINUTE, MINUTE), sent: Number.NaN }], { at: 10 * MINUTE });
    expect(lag?.count).toBe(1);
  });
});
