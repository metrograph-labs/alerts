import { readFileSync } from "node:fs";
import { canaryLimit, publishGaps, type Observation, type ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { ADDED_DATES } from "./added.ts";
import { ADDED_TIMES, checkCanary, RELEASE_MAX_AGE_MS } from "./check.ts";
import { listedAt, readCatalog } from "./fetch.ts";
import { SOURCE_ID } from "./map.ts";

const DAY = 86_400_000;

/** The real catalog, with 10 of its entries (`fixtures/README.md`). */
const FIXTURE = readFileSync(new URL("../fixtures/kev-20261117.json", import.meta.url), "utf8");
const FETCHED = Date.parse("2026-11-18T04:02:53Z");
const observationsAt = (fetched: number): Observation[] =>
  listedAt(readCatalog(FIXTURE, FETCHED)!, fetched).map((body, index) => ({ id: `o-${index}` as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } }));

describe("RELEASE_MAX_AGE_MS", () => {
  it("comes from the 505 measured gaps between the dates of addition: the bound 26 days and a margin of 1 day", () => {
    expect(ADDED_DATES).toHaveLength(506);
    expect(ADDED_TIMES).toHaveLength(506);
    expect([ADDED_DATES[0], ADDED_DATES.at(-1)]).toEqual(["2021-11-03", "2026-11-25"]);
    const gaps = publishGaps(ADDED_TIMES);
    expect(gaps).toHaveLength(505);
    expect(Math.max(...gaps)).toBe(26 * DAY);
    expect(canaryLimit(ADDED_TIMES, { margin: 0 })).toBe(26 * DAY);
    expect(RELEASE_MAX_AGE_MS).toBe(27 * DAY);
  });

  it("holds each date of the record once, in the order of time", () => {
    expect([...ADDED_DATES].sort()).toEqual(ADDED_DATES);
    expect(new Set(ADDED_DATES).size).toBe(ADDED_DATES.length);
  });
});

describe("checkCanary", () => {
  it("passes when the catalog was released at most 27 days before the fetch", () => {
    expect(checkCanary(observationsAt(FETCHED))).toEqual({ pass: true, reason: "the catalog was released at 2026-11-17T17:53:15.566Z, 0.4 days before the fetch" });
    expect(checkCanary(observationsAt(Date.parse("2026-12-14T17:53:15.566Z"))).pass).toBe(true);
  });

  it("fails when the release is older than 27 days, or when the fetch has no head", () => {
    const late = checkCanary(observationsAt(Date.parse("2026-12-14T17:53:16Z")));
    expect(late.pass).toBe(false);
    expect(late.reason).toMatch(/: the limit is 27 days$/);
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no head of the catalog with a release time" });
  });
});
