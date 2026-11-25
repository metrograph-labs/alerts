import { readFileSync } from "node:fs";
import { checkWith, observationId, sourceDescriptorSchema, type Observation, type Report } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, checkIndexCanary } from "./check.ts";
import { descriptorOf, GFZ_DESCRIPTOR, HP30_DESCRIPTOR, HP60_DESCRIPTOR } from "./descriptor.ts";
import { entryBody, entryBodyOf, isIndexEntry, queryPath, queryPathOf, readAnswer, readIndexAnswer, runsOfIndex, type Entry } from "./fetch.ts";
import { GFZ_INDICES, HP30_INDEX, HP60_INDEX, intervalFieldsOf, intervalStartOf, intervalText, KP_INDEX, levelOf, mapIndexObservation, mapObservation, valueOf } from "./map.ts";

/** The real answers of Hp30 (`fixtures/README.md`): the storm of May 2024, and a quiet read of 2026-11-25. */
const read = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const STORM_TEXT = read("hp30-20240510-20240512.json");
const QUIET_TEXT = read("hp30-20261125T1422Z.json");
const STORM = JSON.parse(STORM_TEXT) as { Hp30: number[]; datetime: string[] };
const ENTRIES: Entry[] = STORM.datetime.map((datetime, index) => ({ datetime, Hp30: STORM.Hp30[index] }));
const QUIET_AT = Date.parse("2026-11-25T14:22:00Z");

const SERIES = "https://kp.gfz.test/app/json/?index=Hp30";
const reply = (body: string) => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body });

const observationOf = (body: string, fetched: number): Observation => ({
  id: observationId({ source: HP30_INDEX.source, contentType: "application/json", url: SERIES, body }),
  source: HP30_INDEX.source,
  fetched,
  contentType: "application/json",
  body,
  transport: { url: SERIES, status: 200, latency: 1 },
});

/** The observations of each interval of G1 or more of the storm, each fetched 10 minutes after the start of its interval. */
const STORM_OBSERVATIONS = runsOfIndex(HP30_INDEX, ENTRIES)
  .filter(({ run }) => run !== undefined)
  .map(({ start, entry, run }) => observationOf(entryBodyOf(HP30_INDEX, entry, run), start + 600_000));
const reportsOf = (observations: readonly Observation[]): Report[] => observations.flatMap((observation) => mapIndexObservation(HP30_INDEX, observation).reports);

describe("the indices of GFZ", () => {
  it("keep the facts of the index Kp as before", () => {
    expect(KP_INDEX).toMatchObject({ name: "Kp", source: "gfz", intervalMs: 10_800_000, reportLifeMs: 21_600_000, status: true, open: false });
    expect(intervalFieldsOf(KP_INDEX)).toEqual(["datetime", "Kp", "status", "run"]);
    expect(descriptorOf(KP_INDEX)).toBe(GFZ_DESCRIPTOR);
    expect(queryPathOf(KP_INDEX, QUIET_AT)).toBe(queryPath(QUIET_AT));
    expect(valueOf(KP_INDEX, 9.333)).toBeUndefined();
  });

  it("give one source id, one valid descriptor and fields with no status for each index Hp", () => {
    expect(new Set(GFZ_INDICES.map((index) => index.source)).size).toBe(GFZ_INDICES.length);
    for (const descriptor of [GFZ_DESCRIPTOR, HP30_DESCRIPTOR, HP60_DESCRIPTOR]) expect(checkWith(sourceDescriptorSchema, descriptor).tag).toBe("ok");
    expect(HP30_DESCRIPTOR).toMatchObject({ id: "gfz-hp30", interval: 300_000, origins: ["gfz"] });
    expect(HP60_DESCRIPTOR.id).toBe("gfz-hp60");
    expect(intervalFieldsOf(HP30_INDEX)).toEqual(["datetime", "Hp30", "run"]);
  });

  it("read the start of an interval of 30 minutes and the values above 9 of an open index", () => {
    expect(intervalStartOf(HP30_INDEX, "2024-05-10T22:30:00Z")).toBe(Date.parse("2024-05-10T22:30:00Z"));
    expect(intervalStartOf(HP30_INDEX, "2024-05-10T22:15:00Z")).toBeUndefined();
    expect(intervalStartOf(HP60_INDEX, "2024-05-10T22:30:00Z")).toBeUndefined();
    expect(intervalStartOf(KP_INDEX, "2024-05-10T22:30:00Z")).toBeUndefined();
    expect(valueOf(HP30_INDEX, 11.333)).toBe(11.333);
    expect([valueOf(HP30_INDEX, -0.333), valueOf(HP30_INDEX, Number.NaN), valueOf(HP30_INDEX, "5")]).toEqual([undefined, undefined, undefined]);
    expect([levelOf(4.667), levelOf(5), levelOf(9), levelOf(11.333)]).toEqual([0, 1, 5, 5]);
  });
});

describe("the fetch of Hp30", () => {
  it("asks for the current interval of 30 minutes and the 3 days before it", () => {
    expect(queryPathOf(HP30_INDEX, QUIET_AT)).toBe("/app/json/?start=2026-11-22T14:00:00Z&end=2026-11-25T14:29:59Z&index=Hp30");
    expect(queryPathOf(HP60_INDEX, QUIET_AT)).toBe("/app/json/?start=2026-11-22T14:00:00Z&end=2026-11-25T14:59:59Z&index=Hp60");
  });

  it("reads each entry of the real answers as valid, with no status", () => {
    for (const text of [STORM_TEXT, QUIET_TEXT]) {
      const answer = JSON.parse(text) as { Hp30: unknown[]; datetime: unknown[] };
      expect(answer.datetime.every((datetime, index) => isIndexEntry(HP30_INDEX, { datetime, Hp30: answer.Hp30[index] }))).toBe(true);
    }
    const quiet = readIndexAnswer(HP30_INDEX, reply(QUIET_TEXT), SERIES, SERIES, QUIET_AT, 1);
    expect(quiet?.complete).toBe(true);
    // The quiet answer has no value of G1 or more, so only its recent intervals give observations, and none gives a report.
    expect(quiet?.observations.every((observation) => mapIndexObservation(HP30_INDEX, observation).reports.length === 0)).toBe(true);
    expect(checkIndexCanary(HP30_INDEX, quiet?.observations ?? [])).toMatchObject({ pass: true });
  });

  it("gives the whole body for an answer of a different index or with no license", () => {
    const kp = read("kp-20261117T0233Z.json");
    expect(readIndexAnswer(HP30_INDEX, reply(kp), SERIES, SERIES, QUIET_AT, 1)).toMatchObject({ complete: false, observations: [{ body: kp }] });
    const { meta: _meta, ...unlicensed } = JSON.parse(QUIET_TEXT) as Record<string, unknown>;
    expect(readIndexAnswer(HP30_INDEX, reply(JSON.stringify(unlicensed)), SERIES, SERIES, QUIET_AT, 1)?.complete).toBe(false);
    expect(readAnswer(reply(QUIET_TEXT), SERIES, SERIES, QUIET_AT, 1)?.complete).toBe(false);
  });

  it("finds the two runs of the storm of May 2024", () => {
    const runs = runsOfIndex(HP30_INDEX, ENTRIES).filter(({ run }) => run !== undefined);
    expect(runs).toHaveLength(88);
    const byRun = new Map<string, number>();
    for (const { run } of runs) byRun.set(intervalText(run!), (byRun.get(intervalText(run!)) ?? 0) + 1);
    expect([...byRun]).toEqual([
      ["2024-05-10T14:30:00Z", 80],
      ["2024-05-12T20:00:00Z", 8],
    ]);
  });
});

describe("the map of Hp30", () => {
  it("gives a report for each interval of G1 or more, with the name and the value of Hp30", () => {
    const reports = reportsOf(STORM_OBSERVATIONS);
    expect(reports).toHaveLength(88);
    expect(new Set(reports.map((report) => report.source))).toEqual(new Set(["gfz-hp30"]));
    const peak = reports.find((report) => report.parameters["interval"]?.[0] === "2024-05-10T22:30:00Z");
    expect(peak).toMatchObject({
      severity: "extreme",
      urgency: "immediate",
      expires: Date.parse("2024-05-11T01:00:00Z"),
      correlation: [{ system: "gfz-hp30-run", id: "2024-05-10T14:30:00Z" }],
      headline: "Geomagnetic storm G5: Hp30 11+ from 22:30 to 23:00 UTC on 2024-05-10",
      parameters: { hp30: ["11+"], scale: ["G5"] },
    });
    expect(peak?.parameters["status"]).toBeUndefined();
    expect(peak?.areas.at(-1)).toEqual({ type: "code", system: "gfz-hp30-interval", code: "2024-05-10T22:30:00Z", block: "caps" });
    const levels = [1, 2, 3, 4, 5].map((level) => reports.filter((report) => report.parameters["scale"]?.[0] === `G${level}`).length);
    expect(levels).toEqual([6, 14, 12, 29, 27]);
  });

  it("gives no status problem for Hp30, and a fatal problem for a value of Kp above 9", () => {
    const at = Date.parse("2024-05-10T22:30:00Z");
    expect(mapIndexObservation(HP30_INDEX, observationOf(entryBodyOf(HP30_INDEX, { datetime: intervalText(at), Hp30: 4.667 }), at)).problems).toEqual([]);
    const kp = mapObservation(observationOf(entryBody({ datetime: "2024-05-10T21:00:00Z", Kp: 9.333, status: "def" }), at));
    expect(kp.reports).toEqual([]);
    expect(kp.problems).toMatchObject([{ path: "Kp", fatal: true }]);
  });

  it("fails the canary of Hp30 when the newest interval is older than 2 hours, and keeps the canary of Kp at 6 hours", () => {
    const at = Date.parse("2024-05-10T22:30:00Z");
    const body = entryBodyOf(HP30_INDEX, { datetime: intervalText(at), Hp30: 1 });
    expect(checkIndexCanary(HP30_INDEX, [observationOf(body, at + 7_200_000)]).pass).toBe(true);
    expect(checkIndexCanary(HP30_INDEX, [observationOf(body, at + 7_260_000)]).pass).toBe(false);
    const kp = entryBody({ datetime: "2024-05-10T21:00:00Z", Kp: 1, status: "def" });
    expect(checkCanary([observationOf(kp, Date.parse("2024-05-11T03:00:00Z"))]).pass).toBe(true);
  });
});
