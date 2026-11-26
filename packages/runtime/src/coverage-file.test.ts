import type { Coverage, CoverageCandidates, PlaceId, SourceHealth, SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { COVERAGE_FORMAT, coverageEntries, coverageFile, type CoverageFile } from "./coverage-file.ts";

const HOME = "place:a" as PlaceId;
const API = "api" as SourceId;
const RADIO = "radio" as SourceId;
const TORNADO = "met.tornado";
const AT = Date.UTC(2026, 10, 25, 12);

const candidates: CoverageCandidates[] = [
  { place: HOME, kind: TORNADO, sources: [API, RADIO] },
  { place: HOME, kind: "hydro", sources: [] },
];

function coverageOf(sources: SourceId[], independent: number): Coverage[] {
  return [
    { place: HOME, kind: TORNADO, sources, independent, proven: true, faults: [], commonResources: [], required: 2 },
    { place: HOME, kind: "hydro", sources: [], independent: 0, proven: true, faults: [], commonResources: [], required: 1 },
  ];
}

function healthOf(state: SourceHealth["state"]): SourceHealth[] {
  return [{ source: API, state: "healthy", since: AT - 60_000, reason: "" }, { source: RADIO, state, since: AT - 1000, reason: "" }];
}

describe("the entries of the coverage report", () => {
  it("gives each candidate source with its health, and marks the sources that count", () => {
    const entries = coverageEntries({ at: AT, candidates, coverage: coverageOf([API], 1), health: healthOf("failing") });
    expect(entries).toEqual([
      {
        place: HOME,
        kind: TORNADO,
        required: 2,
        independent: 1,
        proven: true,
        short: true,
        sources: [
          { source: API, state: "healthy", since: "2026-11-25T11:59:00.000Z", counts: true },
          { source: RADIO, state: "failing", since: "2026-11-25T11:59:59.000Z", counts: false },
        ],
      },
      { place: HOME, kind: "hydro", required: 1, independent: 0, proven: true, short: true, sources: [] },
    ]);
  });

  it("gives the state unknown to a source with no health", () => {
    const [entry] = coverageEntries({ at: AT, candidates, coverage: coverageOf([], 0), health: [] });
    expect(entry?.sources.map((source) => [source.state, source.since])).toEqual([
      ["unknown", "2026-11-25T12:00:00.000Z"],
      ["unknown", "2026-11-25T12:00:00.000Z"],
    ]);
  });
});

describe("the writer of the coverage report", () => {
  it("writes when the entries change, and not for a new time alone", async () => {
    const texts: string[] = [];
    const file = coverageFile({ write: async (text) => void texts.push(text), onError: () => undefined });
    file.update({ at: AT, candidates, coverage: coverageOf([API], 1), health: healthOf("failing") });
    await file.idle();
    file.update({ at: AT + 60_000, candidates, coverage: coverageOf([API], 1), health: healthOf("failing") });
    await file.idle();
    expect(texts).toHaveLength(1);
    file.update({ at: AT + 120_000, candidates, coverage: coverageOf([API, RADIO], 2), health: healthOf("healthy") });
    await file.idle();
    expect(texts).toHaveLength(2);
    const last = JSON.parse(texts[1] ?? "") as CoverageFile;
    expect(last.format).toBe(COVERAGE_FORMAT);
    expect(last.changed).toBe("2026-11-25T12:02:00.000Z");
    expect(last.entries[0]?.short).toBe(false);
  });

  it("writes the same report again after a failed write", async () => {
    let fail = true;
    const texts: string[] = [];
    const errors: unknown[] = [];
    const file = coverageFile({
      write: async (text) => {
        if (fail) throw new Error("disk");
        texts.push(text);
      },
      onError: (error) => errors.push(error),
    });
    const view = { at: AT, candidates, coverage: coverageOf([API], 1), health: healthOf("failing") };
    file.update(view);
    await file.idle();
    expect(errors).toHaveLength(1);
    fail = false;
    file.update({ ...view, at: AT + 60_000 });
    await file.idle();
    expect(texts).toHaveLength(1);
    expect((JSON.parse(texts[0] ?? "") as CoverageFile).changed).toBe("2026-11-25T12:00:00.000Z");
  });
});
