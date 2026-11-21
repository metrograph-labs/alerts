import { clopperPearson, quantileInterval } from "@mark1russell7/rigor-statistics";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess } from "./assess.ts";
import type { ObservationId, PersonId, PersonWatch, PlaceId, Report, SourceDescriptor, SourceId, WatchedPlace } from "./contracts.ts";
import { coverage } from "./coverage.ts";
import { reportId } from "./ids.ts";
import {
  carriages,
  decide,
  decideStep,
  delayLimit,
  lateness,
  latenessStep,
  lateSources,
  limitRule,
  missLimit,
  missRecord,
  reportPasses,
  type Carriage,
  type CheckOutcome,
  type DecideState,
  type Decision,
  type Expectation,
  type LatenessFolds,
  type LimitRule,
} from "./lateness.ts";
import { incidents, normalize } from "./merge.ts";
import { NO_SYSTEM_LINES, SOURCE_SUBJECT, systemReports, type SystemSnapshot } from "./system-reports.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const TORNADO = "met.tornado";
const API = "api" as SourceId;
const WEA = "wea" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

// The second source carries each warning of the first source that has the parameter WEAHandling.
const EXPECT: Expectation = { id: "api-to-wea", from: API, to: WEA, when: { statuses: ["actual"], parameters: ["WEAHandling"] } };

function report(source: SourceId, key: string, received: number, fields: Partial<Report> = {}): Report {
  return {
    id: reportId({ source, key, sent: received }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: key }],
    status: "actual",
    op: "alert",
    kind: { code: TORNADO, label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: received,
    received,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `observation:${source}:${key}` as ObservationId,
    parameters: source === API ? { WEAHandling: ["Imminent Threat"] } : {},
    ...fields,
  };
}

function checksOf(reports: readonly Report[], at = 10_000_000): Carriage[] {
  const state = normalize({ reports });
  return carriages(state, incidents(state, at), [EXPECT]);
}

function descriptor(id: SourceId, provider: string): SourceDescriptor {
  return {
    id,
    title: id === API ? "The API" : "The WEA feed",
    origins: ["nws"],
    dependsOn: [`provider:${provider}`],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: 60_000,
    slowAfter: 10_000,
    auth: "none",
  };
}

describe("the filter of an expectation", () => {
  it("holds each field that is present", () => {
    const base = report(API, "w1", 0);
    expect(reportPasses({}, base)).toBe(true);
    expect(reportPasses({ statuses: ["actual"] }, base)).toBe(true);
    expect(reportPasses({ statuses: ["test"] }, base)).toBe(false);
    expect(reportPasses({ ops: ["update"] }, base)).toBe(false);
    expect(reportPasses({ kinds: ["met"] }, base)).toBe(true);
    expect(reportPasses({ kinds: ["met.flood"] }, base)).toBe(false);
    expect(reportPasses({ parameters: ["WEAHandling"] }, base)).toBe(true);
    expect(reportPasses({ parameters: ["WEAHandling"] }, { ...base, parameters: { WEAHandling: [] } })).toBe(false);
    expect(reportPasses({ parameters: ["WEAHandling"] }, { ...base, parameters: {} })).toBe(false);
    const keyed = { ...base, correlation: [{ system: "vtec", id: "KTOP.TO.W.0001.2026" }] };
    expect(reportPasses({ correlation: ["vtec"] }, keyed)).toBe(true);
    expect(reportPasses({ correlation: ["vtec", "cap"] }, keyed)).toBe(false);
    expect(reportPasses({ correlation: ["cap"] }, { ...base, correlation: [] })).toBe(false);
  });
});

describe("the checks", () => {
  it("gives the delay of the copy in the same incident", () => {
    const checks = checksOf([report(API, "w1", 1_000), report(WEA, "w1", 61_000, { sent: 1_000 })]);
    expect(checks).toEqual([{ expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000, arrived: 61_000 }]);
  });

  it("gives an arrival before the start when the copy came first", () => {
    expect(checksOf([report(API, "w1", 50_000), report(WEA, "w1", 20_000, { sent: 50_000 })])).toMatchObject([{ started: 50_000, arrived: 20_000 }]);
  });

  it("gives a check with no arrival when no copy came", () => {
    const [check] = checksOf([report(API, "w1", 1_000)]);
    expect(check).toBeDefined();
    expect(check!.arrived).toBeUndefined();
  });

  it("starts no check for a report that the filter does not pass", () => {
    expect(checksOf([report(API, "w1", 1_000, { parameters: {} })])).toEqual([]);
    expect(checksOf([report(WEA, "w1", 1_000)])).toEqual([]);
  });

  it("gives each message of an event its own check: the extension too", () => {
    const checks = checksOf([
      report(API, "w1", 5_000, { op: "update", key: "w1b", references: ["w1"] }),
      report(API, "w1", 1_000),
      report(WEA, "w1", 9_000, { key: "w1c", sent: 5_000 }),
      report(WEA, "w1", 3_000, { sent: 1_000 }),
    ]);
    expect(checks).toEqual([
      { expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000, arrived: 3_000 },
      { expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 5_000 }), started: 5_000, arrived: 9_000 },
    ]);
    // A lost copy of the extension is a check with no copy.
    expect(checksOf([report(API, "w1", 5_000, { op: "update", key: "w1b" }), report(API, "w1", 1_000), report(WEA, "w1", 3_000, { sent: 1_000 })]).map((check) => check.arrived)).toEqual([3_000, undefined]);
  });

  it("counts a copy with a different sent time as no copy", () => {
    expect(checksOf([report(API, "w1", 1_000), report(WEA, "w1", 3_000)])).toEqual([{ expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000 }]);
  });

  it("counts two copies at one sent time one time, and takes the first", () => {
    const checks = checksOf([report(API, "w1", 1_000), report(WEA, "w1", 9_000, { sent: 1_000 }), report(WEA, "w1", 7_000, { key: "w1c", sent: 1_000 })]);
    expect(checks).toEqual([{ expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000, arrived: 7_000 }]);
  });

  it("counts two reports of the source at one sent time one time, from the first report", () => {
    const checks = checksOf([report(API, "w1", 4_000, { sent: 1_000 }), report(API, "w1", 1_000, { key: "w1b" }), report(WEA, "w1", 6_000, { sent: 1_000 })]);
    expect(checks).toEqual([{ expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000, arrived: 6_000 }]);
  });

  it("gives one check for each incident", () => {
    expect(checksOf([report(API, "w1", 1_000), report(API, "w2", 2_000), report(WEA, "w2", 3_000, { sent: 2_000 })]).map((check) => check.arrived)).toEqual([undefined, 3_000]);
  });

  for (const seed of SEEDS) {
    it(`does not change with the order of the reports (seed ${seed})`, () => {
      const rng = random(seed);
      const reports: Report[] = [];
      for (let warning = 0; warning < 12; warning += 1) {
        const start = Math.floor(rng.next() * 1_000_000);
        reports.push(report(API, `w${warning}`, start));
        if (rng.next() < 0.7) reports.push(report(WEA, `w${warning}`, start + Math.floor(rng.next() * 300_000) - 60_000, { sent: start }));
        if (rng.next() < 0.3) {
          reports.push(report(API, `w${warning}`, start + 1_000, { key: `w${warning}u`, op: "update" }));
          if (rng.next() < 0.7) reports.push(report(WEA, `w${warning}`, start + 1_000 + Math.floor(rng.next() * 300_000), { key: `w${warning}uc`, sent: start + 1_000 }));
        }
      }
      const shuffled = [...reports];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(rng.next() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
      }
      expect(checksOf(shuffled)).toEqual(checksOf(reports));
      expect(checksOf(reports).some((check) => check.arrived !== undefined)).toBe(true);
    });
  }
});

describe("the limit of the delay", () => {
  it("gives no limit for a sample that is too small", () => {
    expect(delayLimit([], { quantile: 0.99, level: 0.95 })).toBeUndefined();
    expect(delayLimit([10, 20, 30, 40, 50], { quantile: 0.99, level: 0.95 })).toBeUndefined();
  });

  it("is the upper bound of the quantile of the delays", () => {
    const delays = Array.from({ length: 400 }, (_, index) => 30_000 + index * 500);
    const limit = delayLimit(delays, { quantile: 0.99, level: 0.95 });
    expect(limit).toBe(quantileInterval(delays, 0.99, 0.95).high);
    expect(limit!).toBeGreaterThanOrEqual(30_000 + 0.99 * 399 * 500);
  });

  it("is not less than 0", () => {
    const delays = Array.from({ length: 400 }, (_, index) => -100_000 + index);
    expect(delayLimit(delays, { quantile: 0.99, level: 0.95 })).toBe(0);
  });
});

describe("the record of an expectation", () => {
  const check = (started: number, arrived?: number): Carriage => ({
    expectation: EXPECT.id,
    report: `r${started}` as Carriage["report"],
    started,
    ...(arrived === undefined ? {} : { arrived }),
  });
  const fixed = (delay: number) => (): number => delay;
  // The limit is 600 s with no sample, and 100 s after the first decision.
  const drop = (sample: readonly number[]): number => (sample.length === 0 ? 600_000 : 100_000);
  const fields = (record: readonly Decision[]) => record.map(({ outcome, limit, decided, sample }) => ({ outcome, limit, decided, sample }));

  it("fixes the deadline of each check at its start", () => {
    const record = decide([check(0, 10_000), check(5_000), check(20_000)], EXPECT.id, 200_000, drop);
    expect(fields(record)).toEqual([
      { outcome: "met", limit: 600_000, decided: 10_000, sample: 10_000 },
      { outcome: "open", limit: 600_000, decided: undefined, sample: undefined },
      { outcome: "missed", limit: 100_000, decided: 120_000, sample: 100_000 },
    ]);
  });

  it("puts a decision at the time of a start after that start", () => {
    const [, same, after] = decide([check(0, 10_000), check(10_000), check(10_001)], EXPECT.id, 10_001, drop);
    expect(same!.limit).toBe(600_000);
    expect(after!.limit).toBe(100_000);
  });

  it("gives a met check its delay as the sample, and a missed check its limit", () => {
    const record = decide([check(0, 30_000), check(1_000_000, 1_900_000), check(2_000_000)], EXPECT.id, 3_000_000, fixed(600_000));
    expect(record.map((entry) => [entry.outcome, entry.decided, entry.sample])).toEqual([
      ["met", 30_000, 30_000],
      ["missed", 1_600_000, 600_000],
      ["missed", 2_600_000, 600_000],
    ]);
  });

  it("measures in the warm-up, does not miss there, and clips a late measure at the limit in force", () => {
    // The rule has a limit from two samples: the largest sample.
    const most = (sample: readonly number[]): number | undefined => (sample.length < 2 ? undefined : Math.max(...sample));
    const record = decide([check(0, 50_000), check(1_000, 31_000), check(2_000), check(3_000, 900_000)], EXPECT.id, 1_000_000, most);
    expect(fields(record)).toEqual([
      { outcome: "measured", limit: undefined, decided: 50_000, sample: 50_000 },
      { outcome: "measured", limit: undefined, decided: 31_000, sample: 30_000 },
      { outcome: "waiting", limit: undefined, decided: undefined, sample: undefined },
      { outcome: "measured", limit: undefined, decided: 900_000, sample: 50_000 },
    ]);
  });

  it("counts a copy only when it came at or before the time, and a check only when it started by the time", () => {
    expect(decide([check(0, 700_000)], EXPECT.id, 650_000, fixed(600_000))[0]!.outcome).toBe("missed");
    expect(decide([check(0, 500_000)], EXPECT.id, 450_000, fixed(600_000))[0]!.outcome).toBe("open");
    expect(decide([check(0, 500_000)], EXPECT.id, 500_000, fixed(600_000))[0]!.outcome).toBe("met");
    expect(decide([check(10)], EXPECT.id, 5, fixed(1))).toEqual([]);
    expect(decide([{ ...check(0), expectation: "other" }], EXPECT.id, 5, fixed(1))).toEqual([]);
  });
});

describe("the lateness", () => {
  const check = (started: number, arrived?: number): Carriage => ({
    expectation: EXPECT.id,
    report: `r${started}` as Carriage["report"],
    started,
    ...(arrived === undefined ? {} : { arrived }),
  });
  const fixed = (delay: number, misses: number): LimitRule => ({ delay: () => delay, misses: () => misses });
  const RULE = fixed(600_000, 1);

  it("only measures when the expectation has no limit", () => {
    expect(lateness([check(0)], [EXPECT], 10_000_000, limitRule({ quantile: 0.99, level: 0.95 }))).toEqual([{ expectation: EXPECT.id, from: API, to: WEA, state: "no-limit", missed: [] }]);
    // A limit of the delay with no count of misses: the check only measures, and the next deadline stays.
    expect(lateness([check(0)], [EXPECT], 1_000, { delay: () => 600_000, misses: () => undefined })).toEqual([
      { expectation: EXPECT.id, from: API, to: WEA, state: "no-limit", missed: [], wakeAt: 600_000 },
    ]);
  });

  it("gives no data before a check came or passed its limit, and the time of the next limit", () => {
    expect(lateness([], [EXPECT], 0, RULE)[0]).toMatchObject({ state: "no-data", missed: [] });
    const [pending] = lateness([check(1_000)], [EXPECT], 2_000, RULE);
    expect(pending).toMatchObject({ state: "no-data", missed: [], wakeAt: 601_000 });
  });

  it("is met when the copy came by its deadline, and late when the copy came after it", () => {
    expect(lateness([check(0, 60_000)], [EXPECT], 100_000, RULE)[0]!.state).toBe("met");
    expect(lateness([check(0, 600_000)], [EXPECT], 700_000, RULE)[0]!.state).toBe("met");
    expect(lateness([check(0, 900_000)], [EXPECT], 1_000_000, RULE)[0]).toMatchObject({ state: "late", missed: ["r0"], since: 600_000 });
  });

  it("is late when a check passes its limit with no copy", () => {
    expect(lateness([check(0)], [EXPECT], 599_999, RULE)[0]!.state).toBe("no-data");
    expect(lateness([check(0)], [EXPECT], 600_000, RULE)[0]).toMatchObject({ state: "late", missed: ["r0"], since: 600_000 });
  });

  it("counts a copy only when it came at or before the time", () => {
    expect(lateness([check(0, 500_000)], [EXPECT], 450_000, RULE)[0]).toMatchObject({ state: "no-data", wakeAt: 600_000 });
    expect(lateness([check(0, 500_000)], [EXPECT], 500_000, RULE)[0]!.state).toBe("met");
  });

  it("lists each miss after the last met check, and the first met check ends the misses", () => {
    const checks = [check(0, 30_000), check(1_000_000), check(2_000_000), check(3_000_000)];
    const late = lateness(checks, [EXPECT], 3_100_000, RULE)[0]!;
    expect(late).toMatchObject({ state: "late", missed: ["r1000000", "r2000000"], since: 1_600_000, wakeAt: 3_600_000 });
    const back = lateness([...checks, check(4_000_000, 4_050_000)], [EXPECT], 4_100_000, RULE)[0]!;
    expect(back).toMatchObject({ state: "met", missed: [] });
  });

  it("stays late through a lag: a copy after its deadline does not end the misses", () => {
    const lag = [check(0, 30_000), check(1_000_000, 1_900_000), check(2_000_000, 2_900_000)];
    expect(lateness(lag, [EXPECT], 3_000_000, RULE)[0]).toMatchObject({ state: "late", missed: ["r1000000", "r2000000"], since: 1_600_000 });
  });

  it("is late only at the count of misses of the limit", () => {
    const two = fixed(600_000, 2);
    const checks = [check(0, 30_000), check(1_000_000), check(2_000_000)];
    expect(lateness(checks, [EXPECT], 1_700_000, two)[0]).toMatchObject({ state: "met", missed: ["r1000000"] });
    expect(lateness(checks, [EXPECT], 1_700_000, two)[0]!.since).toBeUndefined();
    expect(lateness(checks, [EXPECT], 2_600_000, two)[0]).toMatchObject({ state: "late", missed: ["r1000000", "r2000000"], since: 2_600_000 });
    expect(lateness(checks.slice(1), [EXPECT], 1_700_000, two)[0]!.state).toBe("no-data");
  });

  it("reads only the checks from the since of the expectation", () => {
    const checks = [check(0), check(1_000_000)];
    expect(lateness(checks, [EXPECT], 1_700_000, RULE)[0]).toMatchObject({ state: "late", missed: ["r0", "r1000000"], since: 600_000 });
    // A check that starts at the since is in the record, and each earlier check is not.
    expect(lateness(checks, [{ ...EXPECT, since: 1_000_000 }], 1_700_000, RULE)[0]).toMatchObject({ state: "late", missed: ["r1000000"], since: 1_600_000 });
    const fresh = lateness(checks, [{ ...EXPECT, since: 1_000_001 }], 1_700_000, RULE)[0]!;
    expect(fresh).toMatchObject({ state: "no-data", missed: [] });
    expect(fresh.wakeAt).toBeUndefined();
  });

  it("takes a count below 1 as 1", () => {
    expect(lateness([check(0)], [EXPECT], 600_000, fixed(600_000, 0))[0]).toMatchObject({ state: "late", since: 600_000 });
  });

  it("gives the late sources", () => {
    const states = lateness([check(0)], [EXPECT, { ...EXPECT, id: "other", to: "x" as SourceId }], 10, fixed(1, 1));
    expect(lateSources(states)).toEqual([WEA]);
  });
});

describe("the limit of the misses", () => {
  const check = (started: number, arrived?: number, expectation = EXPECT.id): Carriage => ({
    expectation,
    report: `r${started}` as Carriage["report"],
    started,
    ...(arrived === undefined ? {} : { arrived }),
  });
  const recordOf = (checks: readonly Carriage[], at: number): Decision[] => decide(checks, EXPECT.id, at, () => 600_000);

  it("counts only the decided checks, and a copy after its deadline is a miss", () => {
    const checks = [check(0, 10_000), check(1_000_000, 1_700_000), check(2_000_000, 2_100_000), check(3_000_000)];
    // The check after the miss is not a trial.
    expect(missRecord(recordOf(checks, 3_599_999))).toEqual({ trials: 2, misses: 1 });
    expect(missRecord(recordOf(checks, 3_600_000))).toEqual({ trials: 3, misses: 2 });
    expect(missRecord(recordOf([...checks, check(0, 1, "other")], 3_600_000))).toEqual({ trials: 3, misses: 2 });
  });

  it("counts a measured check as met, and skips an open or a waiting check", () => {
    const of = (outcome: CheckOutcome): Decision => ({ check: check(0), outcome });
    const record = (["measured", "waiting", "missed", "open", "missed", "met", "missed"] as const).map(of);
    expect(missRecord(record)).toEqual({ trials: 3, misses: 2 });
  });

  it("counts a long stop of the source as one miss", () => {
    const stop = [check(0, 1_000), ...[1, 2, 3, 4, 5, 6].map((hour) => check(hour * 3_600_000)), check(7 * 3_600_000, 7 * 3_600_000 + 1_000)];
    expect(missRecord(recordOf(stop, 10 * 3_600_000))).toEqual({ trials: 2, misses: 1 });
  });

  it("does not change with the order of the checks", () => {
    const checks = [check(0, 10_000), check(1_000_000), check(2_000_000, 2_100_000), check(3_000_000, 3_010_000), check(4_000_000)];
    const reversed = [...checks].reverse();
    expect(missRecord(recordOf(reversed, 5_000_000))).toEqual(missRecord(recordOf(checks, 5_000_000)));
  });

  it("gives no count with no trials", () => {
    expect(missLimit({ trials: 0, misses: 0 }, 0.95)).toBeUndefined();
  });

  it("gives the smallest count whose chance in normal work is at most 1 - level", () => {
    for (const level of [0.9, 0.95, 0.99]) {
      for (const [misses, trials] of [[0, 5], [0, 50], [0, 400], [3, 400], [40, 400], [150, 400], [9, 10]] as const) {
        const k = missLimit({ trials, misses }, level)!;
        const { high } = clopperPearson(misses, trials, level);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(high ** k).toBeLessThanOrEqual(1 - level);
        if (k > 1) expect(high ** (k - 1)).toBeGreaterThan(1 - level);
      }
    }
  });

  it("needs more misses for a source that misses more in normal work", () => {
    const counts = [0, 4, 40, 120, 240].map((misses) => missLimit({ trials: 400, misses }, 0.95)!);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[0]).toBe(1);
    expect(counts[4]).toBeGreaterThan(counts[0]!);
  });
});

describe("the measured limits", () => {
  const check = (started: number, arrived?: number): Carriage => ({
    expectation: EXPECT.id,
    report: `r${started}` as Carriage["report"],
    started,
    ...(arrived === undefined ? {} : { arrived }),
  });
  const OPTIONS = { quantile: 0.99, level: 0.95 };
  // Normal work: 400 checks, one each 1000 s, with a delay from 30 s to 79 s.
  const normal = Array.from({ length: 400 }, (_, i) => check(i * 1_000_000, i * 1_000_000 + 30_000 + (i % 50) * 1_000));
  const delays = normal.map((one) => one.arrived! - one.started);

  it("gives no limits for a sample that is too small", () => {
    expect(lateness([check(0, 1_000)], [EXPECT], 10_000, limitRule(OPTIONS))[0]!.state).toBe("no-limit");
  });

  it("gives the limit of the delays in normal work", () => {
    const [state] = lateness(normal, [EXPECT], 400 * 1_000_000, limitRule(OPTIONS));
    expect(state).toMatchObject({ state: "met", missed: [], limit: { delay: delayLimit(delays, OPTIONS) } });
    expect(state!.limit!.misses).toBeGreaterThanOrEqual(1);
  });

  it("holds the limit through a lag, stays late, and is met again at the first copy in time", () => {
    const start = 400 * 1_000_000;
    // The copies of 20 checks come 5000 s late. At the time `at`, each of them came.
    const lag = Array.from({ length: 20 }, (_, i) => check(start + i * 1_000_000, start + i * 1_000_000 + 5_000_000));
    const at = start + 25_000_000;
    const before = lateness(normal, [EXPECT], start, limitRule(OPTIONS))[0]!;
    const during = lateness([...normal, ...lag], [EXPECT], at, limitRule(OPTIONS))[0]!;
    expect(during).toMatchObject({ state: "late", limit: { delay: before.limit!.delay }, missed: lag.map((one) => one.report) });
    const back = check(at, at + 40_000);
    expect(lateness([...normal, ...lag, back], [EXPECT], at + 40_000, limitRule(OPTIONS))[0]).toMatchObject({ state: "met", missed: [], limit: { delay: before.limit!.delay } });
  });

  it("holds the limit through a stop and its backlog", () => {
    const start = 400 * 1_000_000;
    // The source stops for 20 checks, then it sends each copy at once.
    const stop = Array.from({ length: 20 }, (_, i) => check(start + i * 1_000_000, start + 20_000_000));
    const at = start + 20_000_000;
    const before = lateness(normal, [EXPECT], start, limitRule(OPTIONS))[0]!;
    expect(lateness([...normal, ...stop], [EXPECT], at, limitRule(OPTIONS))[0]).toMatchObject({ state: "late", limit: { delay: before.limit!.delay } });
  });
});

// A random list of checks: ties of the start, copies that come first, copies that do not come, and lags.
function randomChecks(rng: Random, count: number): Carriage[] {
  const checks: Carriage[] = [];
  let started = 0;
  for (let index = 0; index < count; index += 1) {
    started += rng.next() < 0.1 ? 0 : Math.floor(rng.next() * 120_000);
    const draw = rng.next();
    const arrived = draw < 0.1 ? undefined : draw < 0.2 ? started + Math.floor(rng.next() * 3_600_000) : started + Math.floor(rng.next() * 90_000) - 10_000;
    checks.push({ expectation: EXPECT.id, report: `r${String(index).padStart(4, "0")}` as Carriage["report"], started, ...(arrived === undefined ? {} : { arrived }) });
  }
  return checks;
}

describe("the gate: the record does not change with the order of the checks", () => {
  for (const seed of SEEDS) {
    it(`gives one record and one state for each order (seed ${seed})`, () => {
      const rng = random(seed);
      const checks = randomChecks(rng, 120);
      const shuffled = [...checks];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(rng.next() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
      }
      const rule = limitRule({ quantile: 0.9, level: 0.95 });
      const at = checks.at(-1)!.started + 3_600_000;
      expect(decide(shuffled, EXPECT.id, at, rule.delay)).toEqual(decide(checks, EXPECT.id, at, rule.delay));
      expect(lateness(shuffled, [EXPECT], at, rule)).toEqual(lateness(checks, [EXPECT], at, rule));
    });
  }
});

describe("the gate: the rank of the limit grows by 1 or less for each sample", () => {
  it("holds for the quantiles and the levels of a grid, with the policy among them", () => {
    for (const quantile of [0.5, 0.9, 0.95, 0.99, 0.999]) {
      for (const level of [0.9, 0.95, 0.99]) {
        let before = quantileInterval([0], quantile, level).highRank;
        for (let n = 2; n <= 600; n += 1) {
          const { highRank } = quantileInterval(Array.from({ length: n }, (_, i) => i), quantile, level);
          if (highRank > before + 1) expect.fail(`quantile ${quantile}, level ${level}, n ${n}: the rank grows from ${before} to ${highRank}`);
          before = highRank;
        }
      }
    }
  });
});

describe("the gate: the limit does not pass the first limit", () => {
  for (const seed of SEEDS) {
    it(`holds over random delays, losses and lags (seed ${seed})`, () => {
      const rng = random(seed);
      for (const options of [{ quantile: 0.9, level: 0.95 }, { quantile: 0.99, level: 0.95 }]) {
        const checks = randomChecks(rng, 500);
        const seen: number[] = [];
        const rule = (sample: readonly number[]): number | undefined => {
          const limit = delayLimit(sample, options);
          if (limit !== undefined) seen.push(limit);
          return limit;
        };
        const at = checks.at(-1)!.started + 7_200_000;
        const record = decide(checks, EXPECT.id, at, rule);
        expect(seen.length, `quantile ${options.quantile}`).toBeGreaterThan(50);
        expect(record.some((entry) => entry.outcome === "missed")).toBe(true);
        const first = seen[0]!;
        for (const limit of seen) if (limit > first) expect.fail(`quantile ${options.quantile}: the limit ${limit} passes the first limit ${first}`);
        expect(lateness(checks, [EXPECT], at, limitRule(options))[0]!.limit!.delay).toBeLessThanOrEqual(first);
      }
    });
  }
});

describe("the gate: the miss rate in normal work", () => {
  // Normal work: each copy comes, with no lag. A check misses only when its delay passes the limit at its start.
  const OPTIONS = { quantile: 0.9, level: 0.95 };
  const COUNT = 800;
  const DELAYS: readonly { readonly name: string; readonly draw: (rng: Random) => number }[] = [
    { name: "uniform from 30 s to 80 s", draw: (rng) => 30_000 + Math.floor(rng.next() * 50_000) },
    { name: "exponential with a mean of 60 s after 10 s", draw: (rng) => 10_000 + Math.floor(-60_000 * Math.log(1 - rng.next())) },
  ];
  // The checks start far apart, or in an overlap: a check starts before the copies of the checks before it come.
  const GAPS = [1_000_000, 15_000];
  const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const sd = (values: readonly number[]): number => Math.sqrt(values.reduce((a, b) => a + (b - mean(values)) ** 2, 0) / (values.length - 1));

  // The rate of the censored record, and the rate of the baseline: each check after the warm-up against the limit of
  // the true delays of the copies that came before its start.
  function rates(seed: number, draw: (rng: Random) => number, gap: number): { censored: number; baseline: number } {
    const rng = random(seed);
    const checks: Carriage[] = Array.from({ length: COUNT }, (_, index) => {
      const started = index * gap;
      return { expectation: EXPECT.id, report: `r${String(index).padStart(4, "0")}` as Carriage["report"], started, arrived: started + draw(rng) };
    });
    const record = decide(checks, EXPECT.id, COUNT * gap + 3_600_000, (sample) => delayLimit(sample, OPTIONS));
    const judged = record.filter((entry) => entry.outcome === "met" || entry.outcome === "missed");
    const censored = judged.filter((entry) => entry.outcome === "missed").length / judged.length;
    let misses = 0;
    for (const { check } of judged) {
      const limit = delayLimit(checks.filter((other) => other.arrived! < check.started).map((other) => other.arrived! - other.started), OPTIONS)!;
      if (check.arrived! - check.started > limit) misses += 1;
    }
    return { censored, baseline: misses / judged.length };
  }

  for (const { name, draw } of DELAYS) {
    for (const gap of GAPS) {
      it(`misses at 1.5 × (1 - quantile) or less, with delays ${name} and a gap of ${gap} ms`, () => {
        const runs = SEEDS.map((seed) => rates(seed, draw, gap));
        const censored = runs.map((run) => run.censored);
        const baseline = runs.map((run) => run.baseline);
        // The log line is the measure of the prediction alerts-al8-censored-miss-rate.
        console.log(
          `al8-miss-rate delays="${name}" gap=${gap} seeds=${SEEDS.length} censored=${mean(censored).toFixed(4)}±${sd(censored).toFixed(4)} max=${Math.max(...censored).toFixed(4)} baseline=${mean(baseline).toFixed(4)}±${sd(baseline).toFixed(4)}`,
        );
        expect(mean(censored)).toBeLessThanOrEqual(1.5 * (1 - OPTIONS.quantile));
        for (const rate of censored) expect(rate).toBeLessThanOrEqual(2 * (1 - OPTIONS.quantile));
      });
    }
  }
});

describe("the effect of a late source", () => {
  const SOURCES = [descriptor(API, "api"), descriptor(WEA, "wea")];
  const HEALTH = SOURCES.map((source) => ({ source: source.id, state: "healthy" as const, since: 0, reason: "" }));

  it("does not count for the coverage, also when its health is up", () => {
    const input = { sources: SOURCES, health: HEALTH, places: [KANSAS], kinds: [TORNADO] };
    expect(coverage(input)[0]).toMatchObject({ independent: 2, sources: [API, WEA] });
    expect(coverage({ ...input, late: [WEA] })[0]).toMatchObject({ independent: 1, sources: [API] });
  });

  it("gives a line of system reports to the person who watches the sources", () => {
    const RULE = { delay: () => 600_000, misses: () => 1 };
    const snap = (checks: readonly Carriage[], at: number): SystemSnapshot => ({
      sources: SOURCES,
      health: HEALTH,
      coverage: [],
      threats: [],
      lateness: lateness(checks, [EXPECT], at, RULE),
    });
    const first = { expectation: EXPECT.id, report: "r1" as Carriage["report"], started: 0 };
    const down = systemReports(NO_SYSTEM_LINES, snap([first], 700_000), 700_000);
    expect(down.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.health.late" },
        onset: 600_000,
        about: [{ system: SOURCE_SUBJECT, id: WEA, label: "The WEA feed" }],
        headline: "The WEA feed is late: it did not carry the reports of The API in time.",
        description: "Reports with no copy: 1. The limit of the delay is 600 seconds, and the limit of the misses is 1, from the measured delays and misses.",
      },
    ]);

    const operator: PersonWatch = { person: "person:op" as PersonId, places: [], rules: [], subjects: [{ system: SOURCE_SUBJECT }] };
    const neighbor: PersonWatch = { person: "person:n" as PersonId, places: [KANSAS.id], rules: [] };
    const [incident] = incidents(normalize({ reports: down.reports }), 700_000);
    expect(assess(incident!, operator, [KANSAS]).level).toBe("notice");
    expect(assess(incident!, neighbor, [KANSAS]).level).toBe("none");

    const second = { ...first, report: "r2" as Carriage["report"], started: 1_000_000 };
    const more = systemReports(down.lines, snap([first, second], 1_700_000), 1_700_000);
    expect(more.reports).toMatchObject([{ op: "update", references: [down.reports[0]!.key] }]);

    const back = systemReports(more.lines, snap([first, second, { ...second, report: "r3" as Carriage["report"], started: 2_000_000, arrived: 2_010_000 }], 2_100_000), 2_100_000);
    expect(back.reports).toMatchObject([{ op: "cancel", response: ["allclear"], kind: { code: "system.health.late" } }]);
    expect(back.lines.open).toEqual({});
  });
});

describe("the gate: a fold that continues its state gives the record of the fold from the start", () => {
  // The count of the calls of the rule in one step. A step that continues its state calls the rule once for each new decision.
  const newDecisions = (record: readonly Decision[], after: number): number => record.filter((entry) => entry.decided !== undefined && entry.decided > after).length;
  const allDecisions = (record: readonly Decision[]): number => record.filter((entry) => entry.decided !== undefined).length;

  for (const seed of SEEDS) {
    it(`holds over a chain of passes with late checks, changed copies and steps back (seed ${seed})`, () => {
      const rng = random(seed);
      const rule = limitRule({ quantile: 0.9, level: 0.95 });
      let calls = 0;
      // One counted function for the whole chain. Thus each state can continue, because its rule is the same function.
      const delay = (sample: readonly number[]): number | undefined => {
        calls += 1;
        return rule.delay(sample);
      };
      const counted: LimitRule = { delay, misses: rule.misses };
      const checks = randomChecks(rng, 300);
      const end = checks.at(-1)!.started + 3_600_000;
      let state: DecideState | undefined;
      let folds: LatenessFolds | undefined;
      let at = 0;
      let late = 0;
      const seen = { continued: 0, again: 0 };
      while (at < end) {
        const before = state?.at;
        const draw = rng.next();
        // A step back, a step with no time, or a step forward.
        const next = draw < 0.05 ? Math.max(0, at - Math.floor(rng.next() * 600_000)) : draw < 0.1 ? at : at + Math.floor(rng.next() * 400_000);
        let breaks = before !== undefined && next < before;
        if (before !== undefined) {
          const change = rng.next();
          if (change < 0.05) {
            // A late report: a new check that starts by the time of the state.
            checks.push({ expectation: EXPECT.id, report: `late${String(late++)}` as Carriage["report"], started: Math.floor(rng.next() * (before + 1)), arrived: before + 50_000 });
            breaks = true;
          } else if (change < 0.1) {
            // A changed copy: a copy by the time of the state comes at another time.
            const index = checks.findIndex((check) => check.started <= before && check.arrived !== undefined && check.arrived <= before);
            if (index !== -1) {
              const check = checks[index]!;
              checks[index] = { ...check, arrived: check.arrived! - 1 - Math.floor(rng.next() * 1_000) };
              breaks = true;
            }
          }
        }
        calls = 0;
        const step = decideStep(state, checks, EXPECT.id, next, delay);
        const fresh = decide(checks, EXPECT.id, next, rule.delay);
        expect(step.record, `at ${next}`).toEqual(fresh);
        const continued = before !== undefined && !breaks;
        expect(calls, `the calls at ${next}`).toBe(continued ? newDecisions(fresh, before) : 1 + allDecisions(fresh));
        if (continued) seen.continued += 1;
        else seen.again += 1;

        // The step of the lateness continues its folds in the same way. It calls the rule once more for the limit of the whole sample.
        calls = 0;
        const states = latenessStep(checks, [EXPECT], next, counted, folds);
        expect(states.lateness, `the lateness at ${next}`).toEqual(lateness(checks, [EXPECT], next, rule));
        expect(calls, `the calls of the lateness at ${next}`).toBe((continued ? newDecisions(fresh, before) : 1 + allDecisions(fresh)) + 1);
        state = step.state;
        folds = states.folds;
        at = next;
      }
      expect(seen.continued).toBeGreaterThan(20);
      expect(seen.again).toBeGreaterThan(2);
    });
  }

  it("starts again for another rule, another expectation or a time before the state", () => {
    const rule = limitRule({ quantile: 0.9, level: 0.95 });
    const checks = randomChecks(random(1), 60);
    const at = checks.at(-1)!.started;
    const { state } = decideStep(undefined, checks, EXPECT.id, at, rule.delay);
    let calls = 0;
    const other = (sample: readonly number[]): number | undefined => {
      calls += 1;
      return rule.delay(sample);
    };
    expect(decideStep(state, checks, EXPECT.id, at, other).record).toEqual(decide(checks, EXPECT.id, at, rule.delay));
    expect(calls).toBe(1 + allDecisions(state.record));
    expect(decideStep(state, checks, "other", at, rule.delay).record).toEqual([]);
    expect(decideStep(state, checks, EXPECT.id, at - 1, rule.delay).record).toEqual(decide(checks, EXPECT.id, at - 1, rule.delay));
  });
});
