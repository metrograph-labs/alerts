import { reportId, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { LAG_EVERY, LAG_FORMAT, lagFile, lagFileText, type LagFile } from "./lag-file.ts";

const MINUTE = 60_000;
const QUAKES = "quakes" as SourceId;
const AT = Date.UTC(2026, 10, 25, 12);

/** This function gives a report of the source with a send time and a receipt. */
function report(key: string, sent: number, received: number): Report {
  return {
    id: reportId({ source: QUAKES, key, sent }),
    source: QUAKES,
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
    observation: `observation:${key}` as ObservationId,
    parameters: {},
  };
}

const reports = [report("start", AT - 60 * MINUTE, AT - 60 * MINUTE), report("a", AT - 30 * MINUTE, AT - 27 * MINUTE)];

describe("the text of the lag file", () => {
  it("gives the lag of each source with each time as an ISO 8601 text", () => {
    const file = JSON.parse(lagFileText(AT, reports)) as LagFile;
    expect(file.format).toBe(LAG_FORMAT);
    expect(file.at).toBe("2026-11-25T12:00:00.000Z");
    expect(file.sources.map((lag) => [lag.source, lag.count, lag.median, lag.newest])).toEqual([[QUAKES, 2, 1.5 * MINUTE, "2026-11-25T11:33:00.000Z"]]);
  });
});

describe("the writer of the lag file", () => {
  it("measures at the first update, and then at most one time in each period", async () => {
    const texts: string[] = [];
    let reads = 0;
    const read = (): readonly Report[] => {
      reads += 1;
      return reports;
    };
    const file = lagFile({ write: async (text) => void texts.push(text), onError: () => undefined });
    file.update(AT, read);
    file.update(AT + LAG_EVERY - 1, read);
    await file.idle();
    expect([reads, texts.length]).toEqual([1, 1]);
    file.update(AT + LAG_EVERY, read);
    await file.idle();
    expect([reads, texts.length]).toEqual([2, 2]);
    // A step back of the clock measures again.
    file.update(AT, read);
    await file.idle();
    expect(reads).toBe(3);
  });

  it("gives a fault of the measure to the handler, and tries again at the next update", async () => {
    const errors: unknown[] = [];
    const texts: string[] = [];
    const file = lagFile({ write: async (text) => void texts.push(text), onError: (error) => void errors.push(error) });
    file.update(AT, () => {
      throw new Error("no state");
    });
    file.update(AT + 1, () => reports);
    await file.idle();
    expect([errors.length, texts.length]).toEqual([1, 1]);
  });
});
