import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess, PERSON_SUBJECT } from "./assess.ts";
import { CONFIG_FORMAT } from "./config.ts";
import { messageOf } from "./delivery.ts";
import type { ChannelId, ChannelQuota, CopyRead, CopyWatch, Coverage, DriftCheck, HealthState, Incident, JointDown, Observation, PersonId, PersonWatch, PlaceId, LimitUse, ProviderBalance, RedundancyState, Report, ReportId, SourceDescriptor, SourceHealth, SourceId, WatchedPlace } from "./contracts.ts";
import { SYSTEM_SOURCE } from "./contracts.ts";
import { DRILL_WATCH_GRACE, type DrillConfig, type DrillRun, type DrillWatch } from "./drill.ts";
import { health } from "./health.ts";
import type { Lateness } from "./lateness.ts";
import type { ObserveCondition } from "./observe.ts";
import { incidents, normalize } from "./merge.ts";
import {
  addSystemReports,
  balanceStages,
  balanceFloorsBelow,
  balanceUnreadAt,
  blockCause,
  blockCauseText,
  blockClass,
  blockSizeText,
  CHANNEL_SUBJECT,
  contextSource,
  DEFAULT_SOURCE_CLEAR,
  CLOCK_STEP_WINDOW,
  CLOCK_SUBJECT,
  COPY_STEADY_LIMIT,
  COPY_SUBJECT,
  DRILL_SUBJECT,
  copyStages,
  copyUnreadAt,
  copyUnsteadyAt,
  drillWatchAt,
  DRIFT_STEPS_SHOWN,
  driftStages,
  driftUnreadAt,
  FUNCTION_SUBJECT,
  gapGrade,
  jointStages,
  jointUnreadAt,
  HELD_SHOWN,
  heldText,
  latestIn,
  LOG_RECOVERY_WINDOW,
  LIMIT_SUBJECT,
  LOG_SUBJECT,
  LOOP_BLOCK_LIMIT,
  LOOP_BLOCK_WINDOW,
  NO_SYSTEM_LINES,
  PLACE_SUBJECT,
  quotaStages,
  recentBlocks,
  recentRecovery,
  recentStep,
  redundancyStage,
  reportsShared,
  ROUTE_FAMILY,
  ROUTE_STORE,
  SHARED_HANDOVER,
  sourceClearAt,
  sourceClearPolicy,
  sourceClearTime,
  sharedHandoverAt,
  SOURCE_SUBJECT,
  STORE_FILL_WINDOW,
  STORE_SUBJECT,
  storeEmptyAt,
  atBound,
  stepSizeText,
  systemReports,
  threats,
  useLevelsReached,
  useStages,
  useUnreadAt,
  type LogRecovery,
  type StalePlace,
  type RouteLoad,
  type StoreBound,
  type StoreFill,
  type SystemLines,
  type SystemSnapshot,
} from "./system-reports.ts";
import { alertConfigSchema, reportSchema, sourceClearConfigSchema } from "./schemas.ts";
import type { HeldAlert, HeldPerson } from "./send-limit.ts";
import { unknownKinds } from "./taxonomy.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const TORNADO = "met.tornado";

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = {
  id: "place:a" as PlaceId,
  codes: [
    { system: "ugc", code: "KSZ083" },
    { system: "same", code: "020173" },
    { system: "state", code: "KS" },
  ],
  bufferKm: 0,
};
const TEXAS: WatchedPlace = { id: "place:b" as PlaceId, codes: [{ system: "same", code: "048029" }], bufferKm: 0 };
const PLACES = [KANSAS, TEXAS];

const API: SourceDescriptor = {
  id: "api" as SourceId,
  title: "The API",
  origins: ["nws"],
  dependsOn: ["provider:api"],
  uses: ["internet", "dns", "power"],
  kinds: ["met"],
  coverage: [{ type: "code", system: "state", code: "KS" }],
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
};

const OPERATOR: PersonWatch = { person: "person:op" as PersonId, places: [KANSAS.id], rules: [], subjects: [{ system: SOURCE_SUBJECT }] };
const NEIGHBOR: PersonWatch = { person: "person:n" as PersonId, places: [KANSAS.id], rules: [] };

function healthOf(state: HealthState, since = 0): SourceHealth {
  return { source: API.id, state, since, reason: `The reason at ${since}.` };
}

function gap(fields: Partial<Coverage> = {}): Coverage {
  return { place: KANSAS.id, kind: TORNADO, sources: [], independent: 0, proven: true, faults: [], commonResources: [], required: 2, ...fields };
}

function snapshot(fields: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return { sources: [API], health: [], coverage: [], threats: [], ...fields };
}

// The levels of the live incidents of all the reports, for one person.
function levels(reports: readonly Report[], person: PersonWatch, at = 1_000_000): string[] {
  return incidents(normalize({ reports }), at).map((incident) => assess(incident, person, PLACES).level);
}

describe("the health reports", () => {
  it("gives an alert, an update, a cancel and then a new line", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing", 10)] }), 100);
    expect(down.reports).toHaveLength(1);
    const [alert] = down.reports;
    expect(alert).toMatchObject({
      source: SYSTEM_SOURCE,
      status: "system",
      op: "alert",
      references: [],
      kind: { code: "system.health.failing" },
      onset: 10,
      areas: [],
      about: [{ system: SOURCE_SUBJECT, id: "api", label: "The API" }],
      headline: "The API: the fetches fail.",
      description: "The reason at 10.",
    });
    expect(down.observations.map((observation) => observation.id)).toEqual([alert!.observation]);

    // The same state with a new reason gives no report.
    const again = systemReports(down.lines, snapshot({ health: [{ ...healthOf("failing", 10), reason: "Another count." }] }), 200);
    expect(again.reports).toEqual([]);
    expect(again.lines).toEqual(down.lines);

    const silent = systemReports(again.lines, snapshot({ health: [healthOf("silent", 300)] }), 300);
    expect(silent.reports).toMatchObject([{ op: "update", references: [alert!.key], kind: { code: "system.health.silent" } }]);

    // A source that is up keeps its line for its clear time (AL-75). Then the line ends with a cancel.
    const held = systemReports(silent.lines, snapshot({ health: [healthOf("healthy", 400)] }), 400);
    expect(held.reports).toEqual([]);
    expect(held.lines).toEqual(silent.lines);
    const up = systemReports(held.lines, snapshot({ health: [healthOf("healthy", 400)] }), 400 + DEFAULT_SOURCE_CLEAR.floor);
    expect(up.reports).toMatchObject([{ op: "cancel", references: [silent.reports[0]!.key], response: ["allclear"], kind: { code: "system.health.silent" } }]);
    expect(up.lines.open).toEqual({});

    const downAgain = systemReports(up.lines, snapshot({ health: [healthOf("changed", 500)] }), 500);
    expect(downAgain.reports).toMatchObject([{ op: "alert", references: [] }]);
    expect(new Set([alert, ...silent.reports, ...up.reports, ...downAgain.reports].map((report) => report!.key)).size).toBe(4);
  });

  it("tells old data of a source as silent, not as failed fetches (AL-207)", () => {
    // A keepalive at 15.1 minutes against a limit of 15 minutes: each fetch passed.
    const reason = "the newest keepalive message is 15.1 minutes old: the limit is 15 minutes";
    const fetches = [
      { source: API.id, at: 0, took: 1_000, fresh: 1, fatal: 0 },
      { source: API.id, at: 60_000, took: 1_000, fresh: 0, fatal: 0, canary: { pass: false, reason, late: true } },
    ] as const;
    const late = health(API, 0, fetches, 62_000).health;
    expect(late).toMatchObject({ state: "silent", reason: `The canary failed: ${reason}` });
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [late] }), 62_000);
    expect(down.reports).toMatchObject([{ op: "alert", kind: { code: "system.health.silent" }, headline: "The API: the source gives no new data." }]);

    // A canary that fails for another cause still gives the headline of failed fetches.
    const other = health(API, 0, [fetches[0], { ...fetches[1], canary: { pass: false, reason: "the feed has no head" } }], 62_000).health;
    expect(other.state).toBe("failing");
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ health: [other] }), 62_000).reports).toMatchObject([{ headline: "The API: the fetches fail." }]);
  });

  it("starts no line for a source that is up or unknown", () => {
    for (const state of ["healthy", "slow", "unknown"] as const) {
      expect(systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf(state)] }), 1).reports).toEqual([]);
    }
  });

  it("goes to the person who watches the sources, at notice, until the cancel", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing")] }), 100);
    expect(levels(down.reports, OPERATOR)).toEqual(["notice"]);
    expect(levels(down.reports, NEIGHBOR)).toEqual(["none"]);
    const [incident] = incidents(normalize({ reports: down.reports }), 200);
    expect(assess(incident!, NEIGHBOR, PLACES).reasons).toEqual([{ kind: "no-subject" }]);
    const up = systemReports(down.lines, snapshot({ health: [healthOf("healthy")] }), DEFAULT_SOURCE_CLEAR.floor);
    expect(up.reports).toMatchObject([{ op: "cancel" }]);
    expect(levels([...down.reports, ...up.reports], OPERATOR)).toEqual(["none"]);
  });

  it("gives the digest at most for the health of a source of context", () => {
    const transit: SourceDescriptor = { ...API, id: "gtfs-a" as SourceId, title: "A transit feed", kinds: ["transport.transit"] };
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ sources: [API, transit], health: [{ ...healthOf("failing"), source: transit.id }] }), 100);
    expect(down.reports).toMatchObject([{ kind: { code: "system.health.failing" }, severity: "minor", urgency: "future" }]);
    expect(levels(down.reports, OPERATOR)).toEqual(["digest"]);
    // The health of a source of other kinds keeps its level.
    expect(levels(systemReports(NO_SYSTEM_LINES, snapshot({ sources: [API, transit], health: [healthOf("failing")] }), 100).reports, OPERATOR)).toEqual(["notice"]);
  });

  it("tells a source of context: each of its kinds is a kind of context", () => {
    expect(contextSource({ ...API, kinds: ["transport.transit"] })).toBe(true);
    expect(contextSource({ ...API, kinds: ["transport.transit.detour"] })).toBe(true);
    expect(contextSource({ ...API, kinds: ["transport.transit", "met"] })).toBe(false);
    expect(contextSource({ ...API, kinds: [] })).toBe(false);
    expect(contextSource(API)).toBe(false);
  });

  it("matches a watch of one source only", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing")] }), 100);
    const one = (id: string): PersonWatch => ({ ...NEIGHBOR, subjects: [{ system: SOURCE_SUBJECT, id }] });
    expect(levels(down.reports, one("api"))).toEqual(["notice"]);
    expect(levels(down.reports, one("radio"))).toEqual(["none"]);
  });
});

describe("the end of the line of a down source (AL-75)", () => {
  const MINUTE = 60_000;

  it("gives one incident for a source that fails 2 fetches of 4 for 20 minutes, and its cancel after the clear time", () => {
    // Each fetch is one minute. The fetches 1 and 2 of each 4 fail, so the source is failing for 2 minutes, then up for 2.
    let lines: SystemLines = NO_SYSTEM_LINES;
    const reports: Report[] = [];
    let since = 0;
    let last: HealthState | undefined;
    for (let minute = 0; minute < 20; minute += 1) {
      const state: HealthState = minute % 4 < 2 ? "failing" : "healthy";
      if (state !== last) since = minute * MINUTE;
      last = state;
      const step = systemReports(lines, snapshot({ health: [healthOf(state, since)] }), minute * MINUTE);
      reports.push(...step.reports);
      lines = step.lines;
    }
    // The old fold gave one alert and one cancel for each of the 5 flaps.
    expect(reports.map((report) => report.op)).toEqual(["alert"]);
    expect(incidents(normalize({ reports }), 20 * MINUTE)).toHaveLength(1);

    // The source is up from minute 18. Its clear time is 15 minutes, so the line ends at minute 33 and not before.
    const up = snapshot({ health: [healthOf("healthy", 18 * MINUTE)] });
    expect(sourceClearAt(lines, up, 20 * MINUTE)).toEqual([33 * MINUTE]);
    expect(systemReports(lines, up, 33 * MINUTE - 1).reports).toEqual([]);
    const end = systemReports(lines, up, 33 * MINUTE);
    expect(end.reports).toMatchObject([{ op: "cancel", references: [reports[0]!.key] }]);
    expect(end.lines.open).toEqual({});
    expect(sourceClearAt(end.lines, up, 33 * MINUTE)).toEqual([]);
  });

  it("gives an update when the source is down in another state during the clear time", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing", 0)] }), 0);
    const up = systemReports(down.lines, snapshot({ health: [healthOf("healthy", MINUTE)] }), MINUTE);
    expect(up.reports).toEqual([]);
    const silent = systemReports(up.lines, snapshot({ health: [healthOf("silent", 2 * MINUTE)] }), 2 * MINUTE);
    expect(silent.reports).toMatchObject([{ op: "update", references: [down.reports[0]!.key], kind: { code: "system.health.silent" } }]);
  });

  it("keeps the line of a slow or unknown source, and starts no line for it", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing", 0)] }), 0);
    for (const state of ["slow", "unknown"] as const) {
      expect(systemReports(down.lines, snapshot({ health: [healthOf(state, MINUTE)] }), 2 * MINUTE).reports).toEqual([]);
      expect(systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf(state, MINUTE)] }), 2 * MINUTE).reports).toEqual([]);
    }
  });

  it("ends the line of a source that leaves the snapshot at once", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing", 0)] }), 0);
    expect(systemReports(down.lines, snapshot({ health: [] }), MINUTE).reports).toMatchObject([{ op: "cancel" }]);
  });

  it("takes the clear time from the interval of a slow source and from the configuration", () => {
    const hourly: SourceDescriptor = { ...API, interval: 60 * MINUTE };
    expect(sourceClearTime(DEFAULT_SOURCE_CLEAR, API)).toBe(15 * MINUTE);
    expect(sourceClearTime(DEFAULT_SOURCE_CLEAR, hourly)).toBe(180 * MINUTE);
    expect(sourceClearTime(DEFAULT_SOURCE_CLEAR, undefined)).toBe(15 * MINUTE);
    expect(sourceClearPolicy({ fetches: 1 })).toEqual({ floor: 15 * MINUTE, fetches: 1 });
    expect(sourceClearPolicy()).toEqual(DEFAULT_SOURCE_CLEAR);

    const down = systemReports(NO_SYSTEM_LINES, snapshot({ sources: [hourly], health: [healthOf("failing", 0)] }), 0);
    const up = snapshot({ sources: [hourly], health: [healthOf("healthy", MINUTE)] });
    expect(systemReports(down.lines, up, 61 * MINUTE).reports).toEqual([]);
    expect(systemReports(down.lines, up, 181 * MINUTE).reports).toMatchObject([{ op: "cancel" }]);

    // A policy of 0 and 0 ends the line at the first state that is up, as before AL-75.
    expect(sourceClearConfigSchema.safeParse({ floor: 0, fetches: 0 }).success).toBe(true);
    expect(sourceClearConfigSchema.safeParse({}).success).toBe(true);
    expect(sourceClearConfigSchema.safeParse({ floor: -1 }).success).toBe(false);
    expect(sourceClearConfigSchema.safeParse({ fetches: 1.5 }).success).toBe(false);
    expect(sourceClearConfigSchema.safeParse({ fetches: 3, other: 1 }).success).toBe(false);
    expect(alertConfigSchema.safeParse({ format: CONFIG_FORMAT, places: [], people: [], contacts: [], policies: [], sourceClear: { floor: 0 } }).error?.issues).toBeUndefined();
    expect(systemReports(down.lines, { ...up, sourceClear: { floor: 0, fetches: 0 } }, MINUTE).reports).toMatchObject([{ op: "cancel" }]);
  });
});

describe("the coverage reports", () => {
  const warning: Incident = {
    anchor: "w".repeat(64) as ReportId,
    reports: ["w".repeat(64) as ReportId],
    status: "actual",
    kind: { code: TORNADO, significance: "warning", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    live: true,
    corroboration: 1,
  };

  it("finds the threats: live, actual, a watch, a warning or no stage, at a watched place", () => {
    expect(threats([warning], PLACES)).toEqual([{ place: KANSAS.id, kind: TORNADO }]);
    expect(threats([{ ...warning, kind: { code: TORNADO, label: "Tornado" } }], PLACES)).toHaveLength(1);
    expect(threats([{ ...warning, live: false }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, status: "test" }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, kind: { code: TORNADO, significance: "statement", label: "Statement" } }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, areas: [{ type: "code", system: "same", code: "020001" }] }], PLACES)).toEqual([]);
  });

  it("finds no threat in a private incident: a coverage gap tells each person of the place (AL-92)", () => {
    expect(threats([{ ...warning, addresses: [NEIGHBOR.person] }], PLACES)).toEqual([]);
  });

  it("grades a gap by its count and its threat", () => {
    expect(gapGrade(gap(), true)).toEqual({ severity: "extreme", urgency: "immediate" });
    expect(gapGrade(gap(), false)).toEqual({ severity: "severe", urgency: "expected" });
    expect(gapGrade(gap({ independent: 1 }), true)).toEqual({ severity: "severe", urgency: "expected" });
    expect(gapGrade(gap({ independent: 2, proven: false }), true)).toEqual({ severity: "moderate", urgency: "expected" });
  });

  it("wakes the people of the place at no coverage during a warning, and only then", () => {
    const quiet = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap()] }), 100);
    expect(quiet.reports).toMatchObject([{ op: "alert", areas: [{ type: "place", place: KANSAS.id }], kind: { code: "system.coverage.met.tornado" }, instruction: expect.any(String) }]);
    expect(levels(quiet.reports, NEIGHBOR)).toEqual(["urgent"]);

    const threat = systemReports(quiet.lines, snapshot({ coverage: [gap()], threats: threats([warning], PLACES) }), 200);
    expect(threat.reports).toMatchObject([{ op: "update", references: [quiet.reports[0]!.key], severity: "extreme" }]);
    expect(levels([...quiet.reports, ...threat.reports], NEIGHBOR)).toEqual(["life-safety"]);

    // The people of another place get nothing.
    const away: PersonWatch = { ...NEIGHBOR, places: [TEXAS.id] };
    expect(levels([...quiet.reports, ...threat.reports], away)).toEqual(["none"]);
  });

  it("gives notice for one domain short of a kind that is not life-safety, and for a count that is not proven", () => {
    const winter = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ kind: "met.winter", required: 2, independent: 1, faults: ["cdn:x"] })] }), 100);
    expect(levels(winter.reports, NEIGHBOR)).toEqual(["notice"]);
    expect(winter.reports[0]!.description).toBe("A fault of cdn:x stops each source that covers met.winter at this place.");
    const unproven = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ independent: 2, proven: false, faults: ["a", "b"] })] }), 100);
    expect(levels(unproven.reports, NEIGHBOR)).toEqual(["notice"]);
  });

  it("gives an urgent push for one domain short of a life-safety kind", () => {
    const one = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ independent: 1, faults: ["cdn:x"], commonResources: ["power"] })] }), 100);
    expect(levels(one.reports, NEIGHBOR)).toEqual(["urgent"]);
    expect(one.reports[0]!.description).toContain("Each of these sources uses the power of this place.");
  });

  it("starts no line for a coverage that is not short, and cancels a line when the coverage is back", () => {
    const full = gap({ independent: 2, faults: ["a", "b"] });
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [full] }), 1).reports).toEqual([]);
    const short = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap()] }), 1);
    const back = systemReports(short.lines, snapshot({ coverage: [full] }), 2);
    expect(back.reports).toMatchObject([{ op: "cancel", areas: [{ type: "place", place: KANSAS.id }] }]);
    expect(levels([...short.reports, ...back.reports], NEIGHBOR)).toEqual(["none"]);
  });
});

describe("the quota reports", () => {
  // Midnight in America/Chicago on 1 December: the end of the window.
  const WINDOW = Date.UTC(2026, 11, 1, 6);
  const HOUR = 3_600_000;
  const PUSHOVER = "pushover" as ChannelId;
  const quota = (used: number, fields: Partial<ChannelQuota> = {}): ChannelQuota => ({ channel: PUSHOVER, limit: 10_000, reserve: 1_000, used, resetAt: WINDOW, ...fields });
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: CHANNEL_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);

  it("reaches each stage at its count: low at 2 reserves left, reserve at 1 reserve, spent at 0 or at a block", () => {
    expect(quotaStages(quota(7_999))).toEqual([]);
    expect(quotaStages(quota(8_000))).toEqual(["low"]);
    expect(quotaStages(quota(8_999))).toEqual(["low"]);
    expect(quotaStages(quota(9_000))).toEqual(["low", "reserve"]);
    expect(quotaStages(quota(9_999))).toEqual(["low", "reserve"]);
    expect(quotaStages(quota(10_000))).toEqual(["low", "reserve", "spent"]);
    expect(quotaStages(quota(5, { blockedUntil: WINDOW }))).toEqual(["low", "reserve", "spent"]);
    expect(quotaStages(quota(99, { limit: 100, reserve: 0 }))).toEqual([]);
    expect(unknownKinds(["system.quota", "system.quota.low", "system.quota.reserve", "system.quota.spent"])).toEqual([]);
  });

  it("gives one alert for each stage in a window, no update for a new count, and a cancel of each line at the reset", () => {
    const low = systemReports(NO_SYSTEM_LINES, snapshot({ quotas: [quota(8_000)] }), 100);
    expect(low.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.quota.low", label: "Low quota of a channel" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: CHANNEL_SUBJECT, id: "pushover" }],
        headline: "pushover: 2000 of 10000 units of the window are left.",
      },
    ]);
    expect(systemReports(low.lines, snapshot({ quotas: [quota(8_500)] }), 200).reports).toEqual([]);
    const reserve = systemReports(low.lines, snapshot({ quotas: [quota(9_000)] }), 300);
    expect(reserve.reports).toMatchObject([
      { op: "alert", references: [], kind: { code: "system.quota.reserve" }, severity: "severe", urgency: "expected", headline: `pushover sends only life-safety messages until ${new Date(WINDOW).toISOString()}.` },
    ]);
    expect(systemReports(reserve.lines, snapshot({ quotas: [quota(9_500)] }), 400).reports).toEqual([]);
    const reset = systemReports(reserve.lines, snapshot({ quotas: [quota(0, { resetAt: WINDOW + 31 * 24 * HOUR })] }), 500);
    expect(codes(reset.reports)).toEqual([
      ["cancel", "system.quota.low"],
      ["cancel", "system.quota.reserve"],
    ]);
    expect(reset.lines.open).toEqual({});
  });

  it("gives the spent line with the end of the block, at immediate", () => {
    const spent = systemReports(NO_SYSTEM_LINES, snapshot({ quotas: [quota(9_100, { blockedUntil: WINDOW + HOUR })] }), 100);
    expect(codes(spent.reports)).toEqual([
      ["alert", "system.quota.low"],
      ["alert", "system.quota.reserve"],
      ["alert", "system.quota.spent"],
    ]);
    expect(spent.reports[2]).toMatchObject({ urgency: "immediate", headline: `pushover sends no message until ${new Date(WINDOW + HOUR).toISOString()}.` });
  });

  it("keeps each open line of a quota when the snapshot has no quotas, and ends the lines when the quotas have no stage", () => {
    const both = systemReports(NO_SYSTEM_LINES, snapshot({ quotas: [quota(9_000)], health: [healthOf("failing")] }), 100);
    const unread = systemReports(both.lines, snapshot(), 200);
    expect(codes(unread.reports)).toEqual([["cancel", "system.health.failing"]]);
    expect(Object.keys(unread.lines.open)).toEqual(["quota/pushover/low", "quota/pushover/reserve"]);
    const none = systemReports(unread.lines, snapshot({ quotas: [] }), 300);
    expect(codes(none.reports)).toEqual([
      ["cancel", "system.quota.low"],
      ["cancel", "system.quota.reserve"],
    ]);
  });

  it("goes to the person who watches the channels at notice, and only the message of the reserve line uses the reserve", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ quotas: [quota(9_000)] }), 100);
    expect(levels(step.reports, WATCHER)).toEqual(["notice", "notice"]);
    expect(levels(step.reports, OPERATOR)).toEqual(["none", "none"]);
    const found = incidents(normalize({ reports: step.reports }), 200);
    const uses = found.map((incident) => {
      const send = { incident: incident.anchor, level: "notice" as const, person: WATCHER.person, step: 0, channel: PUSHOVER, due: 200, wait: 0, quiet: false };
      return [incident.kind.code, messageOf(incident, step.reports, send).useReserve ?? false];
    });
    expect(Object.fromEntries(uses)).toEqual({ "system.quota.low": false, "system.quota.reserve": true });
  });

  it("names the units of the quota in the texts", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ quotas: [quota(8_000, { unit: "cents" })] }), 100);
    expect(step.reports[0]).toMatchObject({ headline: "pushover: 2000 of 10000 cents of the window are left." });
    expect(step.reports[0]?.description).toContain("At 1000 cents left");
  });
});

describe("the balance reports", () => {
  const DAY = 86_400_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const CALL = "twilio-call" as ChannelId;
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: CHANNEL_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const balance = (read?: { readonly balance: number; readonly at?: number }, fields: Partial<ProviderBalance> = {}): ProviderBalance => ({
    provider: "provider:twilio",
    title: "Twilio",
    channels: [CALL],
    floors: [5],
    maxAge: 2 * DAY,
    since: START,
    ...(read === undefined ? {} : { read: { balance: read.balance, currency: "USD", at: read.at ?? START } }),
    ...fields,
  });

  it("reaches low below the floor, empty at 0 or less, and unread at the maximum age", () => {
    expect(balanceStages(balance({ balance: 5 }), START)).toEqual([]);
    expect(balanceStages(balance({ balance: 4.99 }), START)).toEqual(["low"]);
    expect(balanceStages(balance({ balance: 0 }), START)).toEqual(["low", "empty"]);
    expect(balanceStages(balance({ balance: -0.5 }), START)).toEqual(["low", "empty"]);
    expect(balanceStages(balance({ balance: 0 }, { floors: [0] }), START)).toEqual(["low", "empty"]);
    // The age counts from the last read, or from the start of the watch with no read.
    expect(balanceStages(balance({ balance: 20 }), START + 2 * DAY - 1)).toEqual([]);
    expect(balanceStages(balance({ balance: 20 }), START + 2 * DAY)).toEqual(["unread"]);
    expect(balanceStages(balance({ balance: 1 }), START + 3 * DAY)).toEqual(["low", "unread"]);
    expect(balanceStages(balance(), START + DAY)).toEqual([]);
    expect(balanceStages(balance(), START + 2 * DAY)).toEqual(["unread"]);
    expect(balanceUnreadAt(balance({ balance: 1, at: START + DAY }))).toBe(START + 3 * DAY);
    expect(unknownKinds(["system.balance", "system.balance.low", "system.balance.empty", "system.balance.unread"])).toEqual([]);
  });

  it("gives one alert for each stage, no update for a new balance, and a cancel when money comes", () => {
    const low = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 1.83164 })] }), START);
    expect(low.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.balance.low", label: "Low balance of a provider" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: CHANNEL_SUBJECT, id: CALL }],
        headline: "Twilio: the balance is 1.83 USD, below the floor of 5.00.",
      },
    ]);
    expect(Object.keys(low.lines.open)).toEqual(["balance/provider%3Atwilio/low/5"]);
    expect(systemReports(low.lines, snapshot({ balances: [balance({ balance: 1.2, at: START + DAY })] }), START + DAY).reports).toEqual([]);
    const empty = systemReports(low.lines, snapshot({ balances: [balance({ balance: -0.04, at: START + DAY })] }), START + DAY);
    expect(empty.reports).toMatchObject([{ op: "alert", kind: { code: "system.balance.empty" }, severity: "severe", urgency: "immediate", headline: "Twilio refuses each paid message: the balance is -0.04 USD." }]);
    const paid = systemReports(empty.lines, snapshot({ balances: [balance({ balance: 20, at: START + DAY + 1 })] }), START + DAY + 1);
    expect(codes(paid.reports)).toEqual([
      ["cancel", "system.balance.empty"],
      ["cancel", "system.balance.low"],
    ]);
    expect(paid.lines.open).toEqual({});
  });

  it("gives the floors below a balance from the highest to the lowest, each one time, and each floor at 0 or less", () => {
    const two = { floors: [2, 5, 2] };
    expect(balanceFloorsBelow(balance({ balance: 6 }, two))).toEqual([]);
    expect(balanceFloorsBelow(balance({ balance: 4 }, two))).toEqual([5]);
    expect(balanceFloorsBelow(balance({ balance: 1.5 }, two))).toEqual([5, 2]);
    expect(balanceFloorsBelow(balance({ balance: 0 }, { floors: [-1, 5] }))).toEqual([5, -1]);
    expect(balanceFloorsBelow(balance(undefined, two))).toEqual([]);
    expect(balanceStages(balance({ balance: 1.5 }, two), START)).toEqual(["low"]);
  });

  it("gives one alert for each floor that the balance goes below, and a cancel for each floor that money passes", () => {
    const two = { floors: [5, 2] };
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 4 }, two)] }), START);
    expect(first.reports).toMatchObject([{ op: "alert", kind: { code: "system.balance.low" }, headline: "Twilio: the balance is 4.00 USD, below the floor of 5.00.", parameters: { floor: ["5"] } }]);
    const second = systemReports(first.lines, snapshot({ balances: [balance({ balance: 1.5, at: START + DAY }, two)] }), START + DAY);
    expect(second.reports).toMatchObject([{ op: "alert", headline: "Twilio: the balance is 1.50 USD, below the floor of 2.00.", parameters: { floor: ["2"] } }]);
    expect(Object.keys(second.lines.open)).toEqual(["balance/provider%3Atwilio/low/2", "balance/provider%3Atwilio/low/5"]);
    const some = systemReports(second.lines, snapshot({ balances: [balance({ balance: 3, at: START + 2 * DAY }, two)] }), START + 2 * DAY);
    expect(codes(some.reports)).toEqual([["cancel", "system.balance.low"]]);
    expect(Object.keys(some.lines.open)).toEqual(["balance/provider%3Atwilio/low/5"]);
    expect(codes(systemReports(some.lines, snapshot({ balances: [balance({ balance: 20, at: START + 3 * DAY }, two)] }), START + 3 * DAY).reports)).toEqual([["cancel", "system.balance.low"]]);
    // A fall past the two floors in one read gives the two alerts, and the lines rebuild from the reports.
    const fall = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 1 }, two)] }), START);
    expect(fall.reports.map((report) => report.parameters["floor"])).toEqual([["2"], ["5"]]);
    expect(addSystemReports(NO_SYSTEM_LINES, fall.reports, fall.observations)).toEqual(fall.lines);
    // The other stages have no floor of their own: they give each floor.
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance(undefined, two)] }), START + 2 * DAY);
    expect(unread.reports).toMatchObject([{ kind: { code: "system.balance.unread" }, parameters: { floor: ["5", "2"] } }]);
  });

  it("gives the unread line when no read passes, and ends it at the next read", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance()] }), START + 2 * DAY);
    expect(unread.reports).toMatchObject([
      { op: "alert", kind: { code: "system.balance.unread" }, severity: "moderate", headline: `The balance of Twilio has no read since the start of the watch at ${new Date(START).toISOString()}.` },
    ]);
    const old = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 9, at: START })] }), START + 2 * DAY);
    expect(old.reports[0]).toMatchObject({ headline: `The balance of Twilio has no read since ${new Date(START).toISOString()}.` });
    const read = systemReports(unread.lines, snapshot({ balances: [balance({ balance: 9, at: START + 2 * DAY })] }), START + 2 * DAY);
    expect(codes(read.reports)).toEqual([["cancel", "system.balance.unread"]]);
  });

  it("keeps each open line of a balance when the snapshot has no balances, and ends the lines of a provider that the snapshot does not have", () => {
    const low = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 1 })], quotas: [] }), START);
    expect(systemReports(low.lines, snapshot(), START + 1).reports).toEqual([]);
    expect(codes(systemReports(low.lines, snapshot({ balances: [] }), START + 1).reports)).toEqual([["cancel", "system.balance.low"]]);
  });

  it("goes at notice to the person who watches the channels of the account, and rebuilds from its reports", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance({ balance: 0 }, { channels: [CALL, "twilio-sms" as ChannelId] })] }), START);
    expect(step.reports[0]?.about.map((subject) => subject.id)).toEqual([CALL, "twilio-sms"]);
    expect(levels(step.reports, WATCHER, START)).toEqual(["notice", "notice"]);
    expect(levels(step.reports, OPERATOR, START)).toEqual(["none", "none"]);
    expect(addSystemReports(NO_SYSTEM_LINES, step.reports, step.observations)).toEqual(step.lines);
  });
});

describe("the use reports (AL-111)", () => {
  const DAY = 86_400_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: LIMIT_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const use = (read?: { readonly used: number; readonly level?: number; readonly month?: string; readonly at?: number }, fields: Partial<LimitUse> = {}): LimitUse => ({
    id: "github:example/actions",
    provider: "provider:github",
    title: "GitHub Actions",
    levels: [0.5, 0.8, 1],
    maxAge: 2 * DAY,
    since: START,
    ...(read === undefined
      ? {}
      : { read: { month: read.month ?? "2026-11", used: read.used, limit: 10, currency: "USD", ...(read.level === undefined ? {} : { level: read.level }), at: read.at ?? START } }),
    ...fields,
  });
  const copyWatch = (copy: string, read: number): CopyWatch => ({ copy, skewLimit: 2_000, maxAge: 60_000, since: START, read: { at: read, skew: 0, sameConfig: true } });

  it("reaches level at each level up to the level of the read, and unread at the maximum age", () => {
    expect(useStages(use({ used: 4 }), START)).toEqual([]);
    expect(useStages(use({ used: 5, level: 0.5 }), START)).toEqual(["level"]);
    expect(useLevelsReached(use({ used: 5, level: 0.5 }))).toEqual([0.5]);
    expect(useLevelsReached(use({ used: 9, level: 0.8 }))).toEqual([0.5, 0.8]);
    expect(useLevelsReached(use({ used: 12, level: 1 }, { levels: [1, 0.5, 0.8, 0.5] }))).toEqual([0.5, 0.8, 1]);
    expect(useLevelsReached(use())).toEqual([]);
    // The age counts from the last read, or from the start of the watch with no read. An old read keeps its level.
    expect(useStages(use({ used: 1 }), START + 2 * DAY - 1)).toEqual([]);
    expect(useStages(use({ used: 1 }), START + 2 * DAY)).toEqual(["unread"]);
    expect(useStages(use({ used: 8, level: 0.8 }), START + 3 * DAY)).toEqual(["level", "unread"]);
    expect(useStages(use(), START + 2 * DAY)).toEqual(["unread"]);
    expect(useUnreadAt(use({ used: 1, at: START + DAY }))).toBe(START + 3 * DAY);
    expect(unknownKinds(["system.use", "system.use.level", "system.use.unread"])).toEqual([]);
  });

  it("gives one alert for each level, no update for a new amount, and a cancel at the next month", () => {
    const half = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use({ used: 5.123, level: 0.5 })] }), START);
    expect(half.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.use.level", label: "Use of a hard limit at a level" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: LIMIT_SUBJECT, id: "github:example/actions" }],
        headline: "GitHub Actions: the use of 2026-11 reached 50 % of the limit of 10.00 USD.",
        description: "The used amount is 5.12 USD. At the limit, the provider stops the paid use until the next month.",
        parameters: { level: ["0.5"], provider: ["provider:github"] },
      },
    ]);
    expect(Object.keys(half.lines.open)).toEqual(["use/github%3Aexample%2Factions/level/0.5/2026-11"]);
    // A larger amount at the same level is no new fact.
    expect(systemReports(half.lines, snapshot({ uses: [use({ used: 6, level: 0.5, at: START + DAY })] }), START + DAY).reports).toEqual([]);
    const full = systemReports(half.lines, snapshot({ uses: [use({ used: 10.5, level: 1, at: START + DAY })] }), START + DAY);
    expect(full.reports.map((report) => [report.op, report.parameters["level"]])).toEqual([
      ["alert", ["0.8"]],
      ["alert", ["1"]],
    ]);
    expect(full.reports[1]).toMatchObject({ headline: "GitHub Actions: the use of 2026-11 reached 100 % of the limit of 10.00 USD.", description: expect.stringContaining("stops the paid use") });
    const rebuilt = addSystemReports(NO_SYSTEM_LINES, [...half.reports, ...full.reports], [...half.observations, ...full.observations]);
    expect(rebuilt.open).toEqual(full.lines.open);
    // The next month starts below each level: each line ends.
    const next = systemReports(full.lines, snapshot({ uses: [use({ used: 0.2, month: "2026-12", at: START + 20 * DAY })] }), START + 20 * DAY);
    expect(codes(next.reports)).toEqual([
      ["cancel", "system.use.level"],
      ["cancel", "system.use.level"],
      ["cancel", "system.use.level"],
    ]);
    expect(next.lines.open).toEqual({});
  });

  it("gives a new alert for a level of the next month, also when no read saw the start of the month", () => {
    const november = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use({ used: 5, level: 0.5 })] }), START);
    const december = systemReports(november.lines, snapshot({ uses: [use({ used: 6, level: 0.5, month: "2026-12", at: START + 30 * DAY })] }), START + 30 * DAY);
    expect(codes(december.reports).sort()).toEqual([
      ["alert", "system.use.level"],
      ["cancel", "system.use.level"],
    ]);
    expect(Object.keys(december.lines.open)).toEqual(["use/github%3Aexample%2Factions/level/0.5/2026-12"]);
  });

  it("gives the unread line when no read passes, ends it at the next read, and keeps the open lines with no list", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use()] }), START + 2 * DAY);
    expect(unread.reports).toMatchObject([
      {
        op: "alert",
        kind: { code: "system.use.unread" },
        headline: `The use of GitHub Actions has no read since the start of the watch at ${new Date(START).toISOString()}.`,
        parameters: { level: ["0.5", "0.8", "1"] },
      },
    ]);
    const read = systemReports(unread.lines, snapshot({ uses: [use({ used: 1, at: START + 2 * DAY })] }), START + 2 * DAY);
    expect(codes(read.reports)).toEqual([["cancel", "system.use.unread"]]);
    const half = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use({ used: 5, level: 0.5 })] }), START);
    expect(systemReports(half.lines, snapshot(), START + 1).reports).toEqual([]);
    expect(codes(systemReports(half.lines, snapshot({ uses: [] }), START + 1).reports)).toEqual([["cancel", "system.use.level"]]);
  });

  it("keeps the open levels of a use with no read, thus a restart sends nothing", () => {
    const full = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use({ used: 9, level: 0.8 })] }), START);
    // After a restart, the watch has no read until its first read. The levels stay open, and no report goes.
    const restarted = systemReports(full.lines, snapshot({ uses: [use(undefined, { since: START + DAY })] }), START + DAY);
    expect(restarted.reports).toEqual([]);
    expect(restarted.lines.open).toEqual(full.lines.open);
    // The first read at the same levels gives no new fact. A read below each level ends each line.
    expect(systemReports(restarted.lines, snapshot({ uses: [use({ used: 9, level: 0.8, at: START + DAY })] }), START + DAY).reports).toEqual([]);
    expect(codes(systemReports(restarted.lines, snapshot({ uses: [use({ used: 1, at: START + DAY })] }), START + DAY).reports)).toEqual([
      ["cancel", "system.use.level"],
      ["cancel", "system.use.level"],
    ]);
  });

  it("gives the levels in one copy and the unread line in each copy", () => {
    const half = [use({ used: 5, level: 0.5 })];
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ uses: half, copy: "copy-a", copies: [copyWatch("copy-b", START)] }), START);
    expect(codes(first.reports)).toEqual([["alert", "system.use.level"]]);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ uses: half, copy: "copy-b", copies: [copyWatch("copy-a", START)] }), START).reports).toEqual([]);
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use()], copy: "copy-b", copies: [copyWatch("copy-a", START + 2 * DAY)] }), START + 2 * DAY);
    expect(codes(unread.reports)).toEqual([["alert", "system.use.unread"]]);
  });

  it("goes at notice at most to the person who watches the limits", () => {
    const full = systemReports(NO_SYSTEM_LINES, snapshot({ uses: [use({ used: 11, level: 1 })] }), START);
    expect(levels(full.reports, WATCHER, START)).toEqual(["notice", "notice", "notice"]);
    expect(levels(full.reports, OPERATOR, START)).toEqual(["none", "none", "none"]);
  });
});

describe("the joint reports (AL-148)", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const START = Date.UTC(2026, 10, 15, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: COPY_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const joint = (read?: { readonly down: number; readonly spans?: number; readonly at?: number }, fields: Partial<JointDown> = {}): JointDown => ({
    window: 7 * 24 * HOUR,
    limit: 10 * MINUTE,
    maxAge: 6 * HOUR,
    since: START,
    ...(read === undefined ? {} : { read: { down: read.down, spans: read.spans ?? 1, at: read.at ?? START } }),
    ...fields,
  });
  const copyWatch = (copy: string, read: number): CopyWatch => ({ copy, skewLimit: 2_000, maxAge: 60_000, since: START, read: { at: read, skew: 0, sameConfig: true } });

  it("reaches over above the limit, and unread at the maximum age", () => {
    expect(jointStages(joint({ down: 10 * MINUTE }), START)).toEqual([]);
    expect(jointStages(joint({ down: 10 * MINUTE + 1 }), START)).toEqual(["over"]);
    // The age counts from the last read, or from the start of the watch with no read. An old read keeps its stage.
    expect(jointStages(joint(), START + 6 * HOUR - 1)).toEqual([]);
    expect(jointStages(joint(), START + 6 * HOUR)).toEqual(["unread"]);
    expect(jointStages(joint({ down: HOUR }), START + 7 * HOUR)).toEqual(["over", "unread"]);
    expect(jointUnreadAt(joint({ down: 0, at: START + HOUR }))).toBe(START + 7 * HOUR);
    expect(unknownKinds(["system.joint", "system.joint.over", "system.joint.unread"])).toEqual([]);
  });

  it("gives one alert over the limit, no update for a new sum, and a cancel under the limit", () => {
    const over = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint({ down: 816 * MINUTE, spans: 3 }) }), START);
    expect(over.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.joint.over", label: "Joint down time over its limit" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: COPY_SUBJECT, id: "all" }],
        headline: "No copy could tell the person for 816.0 min in the last 7 days. The limit is 10.0 min.",
        parameters: { stage: ["over"], down: [String(816 * MINUTE)], spans: ["3"], limit: [String(10 * MINUTE)] },
      },
    ]);
    expect(Object.keys(over.lines.open)).toEqual(["joint/over"]);
    // A new sum over the limit is no new fact.
    expect(systemReports(over.lines, snapshot({ joint: joint({ down: 20 * MINUTE, at: START + HOUR }) }), START + HOUR).reports).toEqual([]);
    const under = systemReports(over.lines, snapshot({ joint: joint({ down: 9 * MINUTE, at: START + 2 * HOUR }) }), START + 2 * HOUR);
    expect(codes(under.reports)).toEqual([["cancel", "system.joint.over"]]);
    expect(under.lines.open).toEqual({});
    const rebuilt = addSystemReports(NO_SYSTEM_LINES, [...over.reports, ...under.reports], [...over.observations, ...under.observations]);
    expect(rebuilt.open).toEqual(under.lines.open);
  });

  it("gives the unread line when no read passes, ends it at the next read, and ends each line with no watch", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint() }), START + 6 * HOUR);
    expect(unread.reports).toMatchObject([
      { op: "alert", kind: { code: "system.joint.unread" }, headline: `The joint down time of the copies has no read since the start of the watch at ${new Date(START).toISOString()}.` },
    ]);
    const read = systemReports(unread.lines, snapshot({ joint: joint({ down: 0, at: START + 6 * HOUR }) }), START + 6 * HOUR);
    expect(codes(read.reports)).toEqual([["cancel", "system.joint.unread"]]);
    const over = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint({ down: HOUR }) }), START);
    // With no field, the open line stays. With no watch, it ends.
    expect(systemReports(over.lines, snapshot(), START + 1).reports).toEqual([]);
    expect(codes(systemReports(over.lines, snapshot({ joint: null }), START + 1).reports)).toEqual([["cancel", "system.joint.over"]]);
  });

  it("keeps the open line over with no read, thus a restart sends nothing", () => {
    const over = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint({ down: HOUR }) }), START);
    const restarted = systemReports(over.lines, snapshot({ joint: joint(undefined, { since: START + HOUR }) }), START + HOUR);
    expect(restarted.reports).toEqual([]);
    expect(restarted.lines.open).toEqual(over.lines.open);
    // The stage unread of the restarted watch comes next to the open line over.
    expect(codes(systemReports(restarted.lines, snapshot({ joint: joint(undefined, { since: START + HOUR }) }), START + 7 * HOUR).reports)).toEqual([["alert", "system.joint.unread"]]);
  });

  it("gives the line over in one copy and the unread line in each copy", () => {
    const over = joint({ down: HOUR });
    expect(codes(systemReports(NO_SYSTEM_LINES, snapshot({ joint: over, copy: "copy-a", copies: [copyWatch("copy-b", START)] }), START).reports)).toEqual([["alert", "system.joint.over"]]);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ joint: over, copy: "copy-b", copies: [copyWatch("copy-a", START)] }), START).reports).toEqual([]);
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint(), copy: "copy-b", copies: [copyWatch("copy-a", START + 6 * HOUR)] }), START + 6 * HOUR);
    expect(codes(unread.reports)).toEqual([["alert", "system.joint.unread"]]);
  });

  it("goes at notice at most to the person who watches the copies", () => {
    const over = systemReports(NO_SYSTEM_LINES, snapshot({ joint: joint({ down: HOUR }) }), START);
    expect(levels(over.reports, WATCHER, START)).toEqual(["notice"]);
    expect(levels(over.reports, OPERATOR, START)).toEqual(["none"]);
  });
});

describe("the drift reports (AL-139)", () => {
  const HOUR = 3_600_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const MAX_AGE = 48 * HOUR;
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: COPY_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const check = (read?: { readonly changes: number; readonly steps?: readonly string[]; readonly at?: number }, fields: Partial<DriftCheck> = {}): DriftCheck => ({
    name: "host-a",
    maxAge: MAX_AGE,
    since: START,
    ...(read === undefined ? {} : { read: { changes: read.changes, steps: read.steps ?? [], at: read.at ?? START } }),
    ...fields,
  });
  const copyWatch = (copy: string, read: number): CopyWatch => ({ copy, skewLimit: 2_000, maxAge: 60_000, since: START, read: { at: read, skew: 0, sameConfig: true } });

  it("reaches changed at one change, and unread at the maximum age", () => {
    expect(driftStages(check({ changes: 0 }), START)).toEqual([]);
    expect(driftStages(check({ changes: 1 }), START)).toEqual(["changed"]);
    expect(driftStages(check(), START + MAX_AGE - 1)).toEqual([]);
    expect(driftStages(check(), START + MAX_AGE)).toEqual(["unread"]);
    expect(driftStages(check({ changes: 2 }), START + MAX_AGE)).toEqual(["changed", "unread"]);
    expect(driftUnreadAt(check({ changes: 0, at: START + HOUR }))).toBe(START + HOUR + MAX_AGE);
    expect(unknownKinds(["system.drift", "system.drift.changed", "system.drift.unread"])).toEqual([]);
  });

  it("gives one alert for a drift, an update for a new list of changes, and a cancel with no change", () => {
    const changed = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: 2, steps: ["step.one", "step.two"] })] }), START);
    expect(changed.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.drift.changed", label: "Drift of a copy host" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: COPY_SUBJECT, id: "host-a" }],
        headline: "The host check host-a found 2 changes: step.one, step.two.",
        parameters: { stage: ["changed"], check: ["host-a"], changes: ["2"], steps: ["step.one", "step.two"] },
      },
    ]);
    expect(Object.keys(changed.lines.open)).toEqual(["drift/host-a/changed"]);
    // The same list is no new fact. A new list gives an update.
    expect(systemReports(changed.lines, snapshot({ drift: [check({ changes: 2, steps: ["step.one", "step.two"], at: START + HOUR })] }), START + HOUR).reports).toEqual([]);
    const more = systemReports(changed.lines, snapshot({ drift: [check({ changes: 3, steps: ["step.one"], at: START + 2 * HOUR })] }), START + 2 * HOUR);
    expect(more.reports).toMatchObject([{ op: "update", headline: "The host check host-a found 3 changes: step.one and 2 more." }]);
    const clean = systemReports(more.lines, snapshot({ drift: [check({ changes: 0, at: START + 3 * HOUR })] }), START + 3 * HOUR);
    expect(codes(clean.reports)).toEqual([["cancel", "system.drift.changed"]]);
    expect(clean.lines.open).toEqual({});
    const rebuilt = addSystemReports(NO_SYSTEM_LINES, [...changed.reports, ...more.reports, ...clean.reports], [...changed.observations, ...more.observations, ...clean.observations]);
    expect(rebuilt.open).toEqual(clean.lines.open);
  });

  it("shows at most the first names in the headline, and a count with no name", () => {
    const steps = Array.from({ length: DRIFT_STEPS_SHOWN + 2 }, (_, index) => `step.${String(index).padStart(2, "0")}`);
    const many = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: steps.length, steps })] }), START);
    expect(many.reports[0]?.headline).toBe(`The host check host-a found 12 changes: ${steps.slice(0, DRIFT_STEPS_SHOWN).join(", ")} and 2 more.`);
    expect(many.reports[0]?.parameters?.["steps"]).toEqual(steps);
    const unnamed = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: 1 })] }), START);
    expect(unnamed.reports[0]?.headline).toBe("The host check host-a found 1 change.");
  });

  it("gives the unread line when no read passes, ends it at the next read, and ends each line with no drift check", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check()] }), START + MAX_AGE);
    expect(unread.reports).toMatchObject([{ op: "alert", kind: { code: "system.drift.unread" }, headline: `The host check host-a has no good read since the start of the watch at ${new Date(START).toISOString()}.` }]);
    const read = systemReports(unread.lines, snapshot({ drift: [check({ changes: 0, at: START + MAX_AGE })] }), START + MAX_AGE);
    expect(codes(read.reports)).toEqual([["cancel", "system.drift.unread"]]);
    const changed = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: 1 })] }), START);
    // With no field, the open line stays. With no drift check, or with no entry of its name, it ends.
    expect(systemReports(changed.lines, snapshot(), START + 1).reports).toEqual([]);
    expect(codes(systemReports(changed.lines, snapshot({ drift: null }), START + 1).reports)).toEqual([["cancel", "system.drift.changed"]]);
    expect(codes(systemReports(changed.lines, snapshot({ drift: [check({ changes: 0 }, { name: "host-b" })] }), START + 1).reports)).toEqual([["cancel", "system.drift.changed"]]);
  });

  it("keeps the open line changed with no read, thus a restart sends nothing", () => {
    const changed = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: 2, steps: ["step.one"] })] }), START);
    const restarted = systemReports(changed.lines, snapshot({ drift: [check(undefined, { since: START + HOUR })] }), START + HOUR);
    expect(restarted.reports).toEqual([]);
    expect(restarted.lines.open).toEqual(changed.lines.open);
    expect(codes(systemReports(restarted.lines, snapshot({ drift: [check(undefined, { since: START + HOUR })] }), START + HOUR + MAX_AGE).reports)).toEqual([["alert", "system.drift.unread"]]);
  });

  it("gives each line of a drift in each copy, because each copy has its own checks", () => {
    const changed = [check({ changes: 1 })];
    expect(codes(systemReports(NO_SYSTEM_LINES, snapshot({ drift: changed, copy: "copy-a", copies: [copyWatch("copy-b", START)] }), START).reports)).toEqual([["alert", "system.drift.changed"]]);
    expect(codes(systemReports(NO_SYSTEM_LINES, snapshot({ drift: changed, copy: "copy-b", copies: [copyWatch("copy-a", START)] }), START).reports)).toEqual([["alert", "system.drift.changed"]]);
    // A restart with no read keeps the open line changed in each copy.
    const opened = systemReports(NO_SYSTEM_LINES, snapshot({ drift: changed, copy: "copy-b", copies: [copyWatch("copy-a", START)] }), START);
    expect(systemReports(opened.lines, snapshot({ drift: [check(undefined, { since: START + HOUR })], copy: "copy-b", copies: [copyWatch("copy-a", START + HOUR)] }), START + HOUR).reports).toEqual([]);
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check()], copy: "copy-b", copies: [copyWatch("copy-a", START + MAX_AGE)] }), START + MAX_AGE);
    expect(codes(unread.reports)).toEqual([["alert", "system.drift.unread"]]);
  });

  it("goes at notice at most to the person who watches the copies", () => {
    const changed = systemReports(NO_SYSTEM_LINES, snapshot({ drift: [check({ changes: 1 })] }), START);
    expect(levels(changed.reports, WATCHER, START)).toEqual(["notice"]);
    expect(levels(changed.reports, OPERATOR, START)).toEqual(["none"]);
  });
});

describe("the facts of a shared account (AL-62)", () => {
  const DAY = 86_400_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const CALL = "twilio-call" as ChannelId;
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const balance = (read?: { readonly balance: number; readonly at?: number }): ProviderBalance => ({
    provider: "provider:twilio",
    title: "Twilio",
    channels: [CALL],
    floors: [5],
    maxAge: 2 * DAY,
    since: START,
    ...(read === undefined ? {} : { read: { balance: read.balance, currency: "USD", at: read.at ?? START } }),
  });
  const watch = (copy: string, read?: number, since = START): CopyWatch => ({
    copy,
    skewLimit: 2_000,
    maxAge: 60_000,
    since,
    ...(read === undefined ? {} : { read: { at: read, skew: 0, sameConfig: true } }),
  });

  it("chooses the copy with the smallest id of the copies that answer, and hands over after a silence", () => {
    expect(reportsShared(undefined, [watch("copy-a", START)], START)).toBe(true);
    expect(reportsShared("copy-b", undefined, START)).toBe(true);
    expect(reportsShared("copy-a", [watch("copy-b", START)], START)).toBe(true);
    expect(sharedHandoverAt("copy-a", [watch("copy-b", START)])).toBeUndefined();
    expect(reportsShared("copy-b", [watch("copy-a", START)], START)).toBe(false);
    expect(reportsShared("copy-b", [watch("copy-a", START)], START + SHARED_HANDOVER - 1)).toBe(false);
    expect(reportsShared("copy-b", [watch("copy-a", START)], START + SHARED_HANDOVER)).toBe(true);
    // With no read that passed, the silence counts from the start of the watch.
    expect(sharedHandoverAt("copy-b", [watch("copy-a", undefined, START + DAY)])).toBe(START + DAY + SHARED_HANDOVER);
    // Of three copies, the third reports only when each copy with a smaller id is silent.
    const both = [watch("copy-a", START), watch("copy-b", START + DAY)];
    expect(sharedHandoverAt("copy-c", both)).toBe(START + DAY + SHARED_HANDOVER);
    expect(reportsShared("copy-c", both, START + SHARED_HANDOVER)).toBe(false);
    expect(reportsShared("copy-b", both, START + SHARED_HANDOVER)).toBe(true);
  });

  it("gives the low and empty lines in one copy, and the unread line in each copy", () => {
    const empty = [balance({ balance: -0.5 })];
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ balances: empty, copy: "copy-a", copies: [watch("copy-b", START)] }), START);
    expect(codes(first.reports)).toEqual([
      ["alert", "system.balance.empty"],
      ["alert", "system.balance.low"],
    ]);
    const second = systemReports(NO_SYSTEM_LINES, snapshot({ balances: empty, copy: "copy-b", copies: [watch("copy-a", START)] }), START);
    expect(second.reports).toEqual([]);
    // The unread line is a fact of the copy: its own reads fail.
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ balances: [balance()], copy: "copy-b", copies: [watch("copy-a", START + 2 * DAY)] }), START + 2 * DAY);
    expect(codes(unread.reports)).toEqual([["alert", "system.balance.unread"]]);
  });

  it("ends the lines of the second copy when the first copy answers, and opens them after the handover", () => {
    const low = [balance({ balance: 1 })];
    // The silent copy is also unread. That line is a fact of the copy watch, not of the account.
    const alone = systemReports(NO_SYSTEM_LINES, snapshot({ balances: low, copy: "copy-b", copies: [watch("copy-a", undefined)] }), START + SHARED_HANDOVER);
    expect(codes(alone.reports)).toEqual([
      ["alert", "system.balance.low"],
      ["alert", "system.copy.unread"],
    ]);
    const back = systemReports(alone.lines, snapshot({ balances: low, copy: "copy-b", copies: [watch("copy-a", START + SHARED_HANDOVER + 5_000)] }), START + SHARED_HANDOVER + 5_000);
    expect(codes(back.reports)).toEqual([
      ["cancel", "system.balance.low"],
      ["cancel", "system.copy.unread"],
    ]);
    expect(back.lines.open).toEqual({});
    // A snapshot with no balances keeps the open balance line, also in the second copy. Only the copy line ends.
    const unknown = systemReports(alone.lines, snapshot({ copy: "copy-b", copies: [watch("copy-a", START + SHARED_HANDOVER + 5_000)] }), START + SHARED_HANDOVER + 5_000);
    expect(codes(unknown.reports)).toEqual([["cancel", "system.copy.unread"]]);
    expect(Object.keys(unknown.lines.open)).toEqual(["balance/provider%3Atwilio/low/5"]);
  });

  it.each(SEEDS)("gives the facts to exactly one of two copies that answer, and to each copy in a silence (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 50; round += 1) {
      const ids = [`copy-${String(r.int(0, 999))}`, `copy-${String(r.int(0, 999))}-x`];
      const [one, two] = r.chance(0.5) ? ids : [ids[1]!, ids[0]!];
      const read = START + r.int(0, DAY);
      const at = read + r.int(0, SHARED_HANDOVER - 1);
      const answers = [reportsShared(one, [watch(two!, read)], at), reportsShared(two, [watch(one!, read)], at)];
      expect(answers.filter(Boolean)).toHaveLength(1);
      const late = read + SHARED_HANDOVER + r.int(0, DAY);
      expect([reportsShared(one, [watch(two!, read)], late), reportsShared(two, [watch(one!, read)], late)]).toEqual([true, true]);
    }
  });
});

describe("the copy reports", () => {
  const MINUTE = 60_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: COPY_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);
  const watch = (read?: Partial<CopyRead>, fields: Partial<CopyWatch> = {}): CopyWatch => ({
    copy: "cloud",
    skewLimit: 2_000,
    maxAge: MINUTE,
    since: START,
    ...(read === undefined ? {} : { read: { at: START, skew: 0, sameConfig: true, ...read } }),
    ...fields,
  });

  it("reaches skew above the limit, config at a different hash, and unread at the maximum age", () => {
    expect(copyStages(watch({}), START)).toEqual([]);
    expect(copyStages(watch({ skew: 2_000 }), START)).toEqual([]);
    expect(copyStages(watch({ skew: 2_001 }), START)).toEqual(["skew"]);
    expect(copyStages(watch({ skew: -2_001 }), START)).toEqual(["skew"]);
    expect(copyStages(watch({ sameConfig: false }), START)).toEqual(["config"]);
    // The age counts from the last read, or from the start of the watch with no read.
    expect(copyStages(watch({}), START + MINUTE - 1)).toEqual([]);
    expect(copyStages(watch({ skew: 5_000, sameConfig: false }), START + MINUTE)).toEqual(["skew", "config", "unread"]);
    expect(copyStages(watch(), START + MINUTE - 1)).toEqual([]);
    expect(copyStages(watch(), START + MINUTE)).toEqual(["unread"]);
    expect(copyUnreadAt(watch({ at: START + 5_000 }))).toBe(START + 5_000 + MINUTE);
    expect(unknownKinds(["system.copy", "system.copy.skew", "system.copy.config", "system.copy.unread", "system.copy.unsteady"])).toEqual([]);
  });

  it("reaches unsteady at the steady limit after the first read that told that the copy is not steady", () => {
    const unsteady = watch({ at: START + 20 * MINUTE }, { unsteadySince: START });
    expect(copyStages(unsteady, START + COPY_STEADY_LIMIT - 1)).toEqual([]);
    expect(copyStages(unsteady, START + COPY_STEADY_LIMIT)).toEqual(["unsteady"]);
    expect(copyUnsteadyAt(unsteady)).toBe(START + COPY_STEADY_LIMIT);
    // A copy that is steady, or that tells nothing, has no time of the stage.
    expect(copyUnsteadyAt(watch({}))).toBeUndefined();
    expect(copyStages(watch({ at: START + 30 * MINUTE }), START + 30 * MINUTE)).toEqual([]);
    // The limit is longer than the longest ready window and the steady wait together.
    expect(COPY_STEADY_LIMIT).toBeGreaterThan(10 * MINUTE + 5 * MINUTE);
  });

  it("holds one unread line and one unsteady line for a copy that starts again and again, and ends them at a steady read", () => {
    // The copy of the loop answers for 3 minutes of each try. Then it stops for 2 minutes, and it starts again.
    let lines = NO_SYSTEM_LINES;
    const alerts: (readonly [string, string])[] = [];
    let last: number | undefined;
    for (let at = START; at <= START + 60 * MINUTE; at += 30_000) {
      const inTry = (at - START) % (5 * MINUTE) < 3 * MINUTE;
      if (inTry) last = at;
      const step = systemReports(lines, snapshot({ copies: [watch(last === undefined ? undefined : { at: last }, { unsteadySince: START })] }), at);
      alerts.push(...step.reports.map((report) => [report.op, report.kind.code] as const));
      lines = step.lines;
    }
    // Without the hold, the line unread opens at each stop: 12 times in the hour.
    expect(alerts).toEqual([
      ["alert", "system.copy.unread"],
      ["alert", "system.copy.unsteady"],
    ]);
    expect(Object.keys(lines.open).sort()).toEqual(["copy/cloud/unread", "copy/cloud/unsteady"]);
    const unsteady = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ at: START + 20 * MINUTE }, { unsteadySince: START })] }), START + 20 * MINUTE);
    expect(unsteady.reports).toMatchObject([
      { op: "alert", kind: { code: "system.copy.unsteady", label: "Copy not steady" }, headline: `The copy cloud is not steady since ${new Date(START).toISOString()}.` },
    ]);
    // A steady read ends the two lines.
    const steady = systemReports(lines, snapshot({ copies: [watch({ at: START + 61 * MINUTE })] }), START + 61 * MINUTE);
    expect(codes(steady.reports)).toEqual([
      ["cancel", "system.copy.unread"],
      ["cancel", "system.copy.unsteady"],
    ]);
    expect(steady.lines.open).toEqual({});
  });

  it("keeps an open unsteady line over a restart of this copy until the first steady read", () => {
    const open = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ at: START + 20 * MINUTE }, { unsteadySince: START })] }), START + 20 * MINUTE).lines;
    // After a restart, the watch starts again. With no read, or with a read that is not steady, the line stays open.
    const restart = START + 30 * MINUTE;
    expect(systemReports(open, snapshot({ copies: [watch(undefined, { since: restart })] }), restart).reports).toEqual([]);
    expect(systemReports(open, snapshot({ copies: [watch({ at: restart + 5_000 }, { since: restart, unsteadySince: restart + 5_000 })] }), restart + 5_000).reports).toEqual([]);
    // A read of a copy that tells that it is steady ends the line.
    expect(codes(systemReports(open, snapshot({ copies: [watch({ at: restart + 10_000 }, { since: restart })] }), restart + 10_000).reports)).toEqual([["cancel", "system.copy.unsteady"]]);
  });

  it("ends the unread line at a read that passes when the copy is steady or tells nothing", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch()] }), START + MINUTE);
    // A read of a copy that is not steady keeps the line, and a read of a copy of an older build ends it as before.
    expect(systemReports(unread.lines, snapshot({ copies: [watch({ at: START + MINUTE }, { unsteadySince: START + MINUTE })] }), START + MINUTE).reports).toEqual([]);
    expect(codes(systemReports(unread.lines, snapshot({ copies: [watch({ at: START + MINUTE })] }), START + MINUTE).reports)).toEqual([["cancel", "system.copy.unread"]]);
  });

  it("gives one alert for each stage, no update for a new difference, and a cancel at a good read", () => {
    const skewed = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ skew: -2_540 })] }), START);
    expect(skewed.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.copy.skew", label: "Clock difference of a copy" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: COPY_SUBJECT, id: "cloud", label: "Copy cloud" }],
        headline: "The clock of the copy cloud differs from the clock of this copy by 2.5 s.",
        parameters: { stage: ["skew"], skew: ["-2540"], sameConfig: ["true"], age: ["0"] },
      },
    ]);
    expect(Object.keys(skewed.lines.open)).toEqual(["copy/cloud/skew"]);
    expect(systemReports(skewed.lines, snapshot({ copies: [watch({ at: START + 5_000, skew: 3_900 })] }), START + 5_000).reports).toEqual([]);
    const config = systemReports(skewed.lines, snapshot({ copies: [watch({ at: START + 5_000, skew: 3_900, sameConfig: false })] }), START + 5_000);
    expect(config.reports).toMatchObject([{ op: "alert", kind: { code: "system.copy.config" }, headline: "The copy cloud has a different configuration." }]);
    const good = systemReports(config.lines, snapshot({ copies: [watch({ at: START + 10_000 })] }), START + 10_000);
    expect(codes(good.reports)).toEqual([
      ["cancel", "system.copy.config"],
      ["cancel", "system.copy.skew"],
    ]);
    expect(good.lines.open).toEqual({});
  });

  it("gives the unread line when no read passes, and ends it at the next read", () => {
    const unread = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch()] }), START + MINUTE);
    expect(unread.reports).toMatchObject([
      { op: "alert", kind: { code: "system.copy.unread" }, headline: `No read of the copy cloud passed since the start of the watch at ${new Date(START).toISOString()}.` },
    ]);
    const old = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ at: START })] }), START + 2 * MINUTE);
    expect(old.reports[0]).toMatchObject({ headline: `No read of the copy cloud passed since ${new Date(START).toISOString()}.`, parameters: { age: [String(2 * MINUTE)] } });
    const read = systemReports(unread.lines, snapshot({ copies: [watch({ at: START + MINUTE })] }), START + MINUTE);
    expect(codes(read.reports)).toEqual([["cancel", "system.copy.unread"]]);
  });

  it("names a billing stop of the host in an update of the unread line, and keeps the text when the billing is on (AL-70)", () => {
    const at = START + MINUTE;
    const since = `No read of the copy cloud passed since the start of the watch at ${new Date(START).toISOString()}.`;
    // The alarm goes out at once, before the billing read ends.
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch()] }), at);
    expect(down.reports).toMatchObject([{ op: "alert", kind: { code: "system.copy.unread" }, headline: since }]);
    expect(down.reports[0]?.parameters["billing"]).toBeUndefined();
    // The billing state on is not a fact: the text stays, and no update goes out.
    expect(systemReports(down.lines, snapshot({ copies: [watch(undefined, { billing: { state: "on", at } })] }), at).reports).toEqual([]);
    // A billing stop is a new fact: an update of the same line names it.
    const stopped = systemReports(down.lines, snapshot({ copies: [watch(undefined, { billing: { state: "stopped", at } })] }), at);
    expect(stopped.reports).toMatchObject([
      {
        op: "update",
        kind: { code: "system.copy.unread" },
        headline: `The copy cloud is down because of a billing stop of its host. ${since}`,
        instruction: "Examine the billing account of the host. Start the billing again, then start the copy.",
        parameters: { stage: ["unread"], billing: ["stopped"] },
      },
    ]);
    expect(Object.keys(stopped.lines.open)).toEqual(["copy/cloud/unread"]);
    // A failed read keeps the text of a down copy and tells that the billing state is unread.
    const unread = systemReports(down.lines, snapshot({ copies: [watch(undefined, { billing: { state: "unread", at } })] }), at);
    expect(unread.reports).toMatchObject([{ op: "update", headline: `${since} The billing state of its host is unread.`, parameters: { billing: ["unread"] } }]);
    // A billing state that is known at the start of the line goes into the first alert.
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch(undefined, { billing: { state: "stopped", at } })] }), at).reports).toMatchObject([{ op: "alert", parameters: { billing: ["stopped"] } }]);
    // The billing state changes only the line unread, and a read of the copy ends the line.
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ skew: 9_000 }, { billing: { state: "stopped", at: START } })] }), START).reports).toMatchObject([{ headline: "The clock of the copy cloud differs from the clock of this copy by 9.0 s." }]);
    expect(codes(systemReports(stopped.lines, snapshot({ copies: [watch({ at })] }), at).reports)).toEqual([["cancel", "system.copy.unread"]]);
  });

  it("keeps each open line of a copy when the snapshot has no copies, and ends the lines of a copy that the snapshot does not have", () => {
    const skewed = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ skew: 9_000 })], balances: [] }), START);
    expect(systemReports(skewed.lines, snapshot(), START + 1).reports).toEqual([]);
    expect(codes(systemReports(skewed.lines, snapshot({ copies: [] }), START + 1).reports)).toEqual([["cancel", "system.copy.skew"]]);
    // Each copy has its own lines.
    const two = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ skew: 9_000 }), watch({ sameConfig: false }, { copy: "home-2" })] }), START);
    expect(Object.keys(two.lines.open)).toEqual(["copy/cloud/skew", "copy/home-2/config"]);
  });

  it("goes at notice to the person who watches the copies, and rebuilds from its reports", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ copies: [watch({ skew: 9_000, sameConfig: false })] }), START);
    expect(levels(step.reports, WATCHER, START)).toEqual(["notice", "notice"]);
    expect(levels(step.reports, OPERATOR, START)).toEqual(["none", "none"]);
    expect(addSystemReports(NO_SYSTEM_LINES, step.reports, step.observations)).toEqual(step.lines);
  });
});

describe("the clock reports", () => {
  const HOUR = 3_600_000;
  const START = Date.UTC(2026, 10, 15, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: CLOCK_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);

  it("names the size of a step in whole hours, whole minutes or whole seconds", () => {
    expect(stepSizeText(HOUR)).toBe("1 h");
    expect(stepSizeText(-2 * HOUR)).toBe("2 h");
    expect(stepSizeText(1.5 * HOUR)).toBe("90 min");
    expect(stepSizeText(-600_000)).toBe("10 min");
    expect(stepSizeText(90_000)).toBe("90 s");
    expect(stepSizeText(2_400)).toBe("2 s");
    expect(unknownKinds(["system.clock", "system.clock.step"])).toEqual([]);
  });

  it("finds the latest step at the time or before it, in the window", () => {
    const steps = [
      { at: START, size: -HOUR },
      { at: START + HOUR, size: 5_000 },
    ];
    expect(recentStep(steps, START - 1)).toBeUndefined();
    expect(recentStep(steps, START)).toEqual(steps[0]);
    expect(recentStep(steps, START + HOUR)).toEqual(steps[1]);
    expect(recentStep(steps, START + HOUR + CLOCK_STEP_WINDOW - 1)).toEqual(steps[1]);
    expect(recentStep(steps, START + HOUR + CLOCK_STEP_WINDOW)).toBeUndefined();
    expect(recentStep([], START)).toBeUndefined();
  });

  it("gives an alert for a step, an update for the next step in the window, and a cancel at the end of the window", () => {
    const back = systemReports(NO_SYSTEM_LINES, snapshot({ steps: [{ at: START, size: -HOUR }] }), START);
    expect(back.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.clock.step", label: "Step of the clock" },
        severity: "minor",
        urgency: "past",
        onset: START,
        areas: [],
        about: [{ system: CLOCK_SUBJECT, id: "wall" }],
        headline: "The wall clock stepped back by 1 h.",
        parameters: { size: [String(-HOUR)] },
      },
    ]);
    expect(Object.keys(back.lines.open)).toEqual(["clock"]);
    expect(systemReports(back.lines, snapshot({ steps: [{ at: START, size: -HOUR }] }), START + HOUR).reports).toEqual([]);
    const steps = [
      { at: START, size: -HOUR },
      { at: START + HOUR, size: 600_000 },
    ];
    const forward = systemReports(back.lines, snapshot({ steps }), START + HOUR);
    expect(forward.reports).toMatchObject([{ op: "update", references: [back.reports[0]!.key], headline: "The wall clock stepped forward by 10 min." }]);
    expect(codes(systemReports(forward.lines, snapshot({ steps }), START + HOUR + CLOCK_STEP_WINDOW).reports)).toEqual([["cancel", "system.clock.step"]]);
    expect(addSystemReports(NO_SYSTEM_LINES, [...back.reports, ...forward.reports], [...back.observations, ...forward.observations])).toEqual(forward.lines);
  });

  it("goes to the digest of the person who watches the clock, and to no other person", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ steps: [{ at: START, size: HOUR }] }), START);
    expect(levels(step.reports, WATCHER, START)).toEqual(["digest"]);
    expect(levels(step.reports, OPERATOR, START)).toEqual(["none"]);
  });
});

describe("the loop reports", () => {
  const START = Date.UTC(2026, 10, 22, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: COPY_SUBJECT }] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);

  it("names the length of a block, and gives its class", () => {
    expect(blockSizeText(1_840)).toBe("1.8 s");
    expect(blockSizeText(1_000)).toBe("1.0 s");
    expect(blockSizeText(9_940)).toBe("9.9 s");
    expect(blockSizeText(12_400)).toBe("12 s");
    expect([999, 1_000, 1_999, 2_000, 4_999, 5_000, 25_000, 90_000].map(blockClass)).toEqual([0, 1_000, 1_000, 2_000, 2_000, 5_000, 20_000, 60_000]);
    expect(unknownKinds(["system.loop", "system.loop.block"])).toEqual([]);
  });

  it("finds the blocks at the time or before it, in the window, and skips a block under the limit", () => {
    const blocks = [
      { at: START, size: 1_200 },
      { at: START + 1_000, size: LOOP_BLOCK_LIMIT - 1 },
      { at: START + 60_000, size: 3_000 },
    ];
    expect(recentBlocks(blocks, START - 1)).toEqual([]);
    expect(recentBlocks(blocks, START + 60_000)).toEqual([blocks[0], blocks[2]]);
    expect(recentBlocks(blocks, START + LOOP_BLOCK_WINDOW)).toEqual([blocks[2]]);
    expect(recentBlocks(blocks, START + 60_000 + LOOP_BLOCK_WINDOW)).toEqual([]);
  });

  it("gives an alert for a block, an update only for a block of a higher class, and a cancel at the end of the window", () => {
    const first = [{ at: START, size: 1_400 }];
    const opened = systemReports(NO_SYSTEM_LINES, snapshot({ blocks: first, copy: "cloud" }), START + 5_000);
    expect(opened.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.loop.block", label: "Block of the event loop" },
        severity: "moderate",
        urgency: "expected",
        onset: START,
        areas: [],
        about: [{ system: COPY_SUBJECT, id: "cloud" }],
        headline: "The event loop of the runtime was blocked for 1.4 s.",
        parameters: { longest: ["1400"], at: [String(START)], count: ["1"] },
      },
    ]);
    expect(Object.keys(opened.lines.open)).toEqual(["loop"]);
    // A second block of the same class gives no update.
    const same = [...first, { at: START + 60_000, size: 1_900 }];
    expect(systemReports(opened.lines, snapshot({ blocks: same, copy: "cloud" }), START + 65_000).reports).toEqual([]);
    const longer = [...same, { at: START + 120_000, size: 6_000 }];
    const updated = systemReports(opened.lines, snapshot({ blocks: longer, copy: "cloud" }), START + 125_000);
    expect(updated.reports).toMatchObject([{ op: "update", references: [opened.reports[0]!.key], headline: "The event loop of the runtime was blocked for 6.0 s." }]);
    // The longest block leaves the window, and a short block keeps the line open: the class does not fall, thus no update.
    const late = [...longer, { at: START + 120_000 + LOOP_BLOCK_WINDOW - 1_000, size: 1_200 }];
    const kept = systemReports(updated.lines, snapshot({ blocks: late, copy: "cloud" }), START + 120_000 + LOOP_BLOCK_WINDOW);
    expect(kept.reports).toEqual([]);
    const end = START + 120_000 + 2 * LOOP_BLOCK_WINDOW - 1_000;
    expect(codes(systemReports(kept.lines, snapshot({ blocks: late, copy: "cloud" }), end).reports)).toEqual([["cancel", "system.loop.block"]]);
  });

  it("tells the cause of the longest block, and a new cause of the same class gives no update (AL-180)", () => {
    const work = { at: START, size: 2_400, cpu: 2_300, faults: 0, gc: 900 };
    expect(blockCauseText(work)).toBe("The block had 2.3 s of processor time, 0 page reads from the disk and 0.9 s of pauses of the garbage collector. Thus the block was mostly work of the processor.");
    expect(blockCauseText({ at: START, size: 2_000, faults: 3 })).toBe("The block had 3 page reads from the disk.");
    expect(blockCauseText({ at: START, size: 2_000 })).toBeUndefined();
    expect(blockCause({ cpu: 1, gc: 0 })).toEqual({ cpu: 1, gc: 0 });
    const opened = systemReports(NO_SYSTEM_LINES, snapshot({ blocks: [work], copy: "cloud" }), START + 5_000);
    expect(opened.reports).toMatchObject([{ op: "alert", parameters: { longest: ["2400"], cpu: ["2300"], faults: ["0"], gc: ["900"] } }]);
    expect(opened.reports[0]?.description).toContain("In the longest block: The block had 2.3 s of processor time");
    const wait = [work, { at: START + 60_000, size: 2_600, cpu: 100, faults: 400 }];
    expect(systemReports(opened.lines, snapshot({ blocks: wait, copy: "cloud" }), START + 65_000).reports).toEqual([]);
  });

  it("names this copy when the snapshot has no copy", () => {
    const opened = systemReports(NO_SYSTEM_LINES, snapshot({ blocks: [{ at: START, size: 2_000 }] }), START);
    expect(opened.reports).toMatchObject([{ about: [{ system: COPY_SUBJECT, id: "this", label: "This copy" }] }]);
  });

  it("goes as a notice to the person who watches the copies, and to no other person", () => {
    const opened = systemReports(NO_SYSTEM_LINES, snapshot({ blocks: [{ at: START, size: 2_500 }], copy: "home" }), START);
    expect(levels(opened.reports, WATCHER, START)).toEqual(["notice"]);
    expect(levels(opened.reports, OPERATOR, START)).toEqual(["none"]);
  });
});

describe("the log reports", () => {
  const DAY = 24 * 3_600_000;
  const START = Date.UTC(2026, 10, 16, 12);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: LOG_SUBJECT }] };
  const FOLDER = "runtime.sqlite.broken-20261116T120000Z";
  const whole: LogRecovery = { at: START, quarantine: FOLDER, kept: 40, lost: 0, whole: true };
  const lossy: LogRecovery = { at: START + 1_000, quarantine: `${FOLDER}-2`, kept: 30, lost: 3, whole: false };
  const unread: LogRecovery = { at: START, quarantine: FOLDER, kept: 0, lost: 0, whole: false };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);

  it("finds the latest recovery at the time or before it, in the window, with the rule of the steps of the clock", () => {
    expect(LOG_RECOVERY_WINDOW).toBe(DAY);
    expect(unknownKinds(["system.log", "system.log.recovered"])).toEqual([]);
    expect(recentRecovery([whole, lossy], START - 1)).toBeUndefined();
    expect(recentRecovery([whole, lossy], START)).toEqual(whole);
    expect(recentRecovery([whole, lossy], START + 1_000)).toEqual(lossy);
    expect(recentRecovery([whole, lossy], START + 1_000 + DAY)).toBeUndefined();
    expect(latestIn([whole, { ...whole, kept: 1 }], START, 1)).toEqual({ ...whole, kept: 1 });
    expect(latestIn([whole], START + 1, 1)).toBeUndefined();
  });

  it("gives an alert that names the quarantine, an update for a second recovery, and a cancel at the end of the window", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ recoveries: [whole] }), START);
    expect(first.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.log.recovered", label: "Recovery of the log" },
        severity: "minor",
        urgency: "past",
        onset: START,
        areas: [],
        about: [{ system: LOG_SUBJECT, id: "runtime" }],
        headline: "The log file of the alert system was broken.",
        parameters: { quarantine: [FOLDER], kept: ["40"], lost: ["0"], whole: ["true"] },
      },
    ]);
    expect(first.reports[0]!.description).toBe(`The alert system moved the broken file into the quarantine folder ${FOLDER}, and it started a new log. It kept each of the 40 events.`);
    expect(Object.keys(first.lines.open)).toEqual(["log"]);
    expect(systemReports(first.lines, snapshot({ recoveries: [whole] }), START + 500).reports).toEqual([]);
    const second = systemReports(first.lines, snapshot({ recoveries: [whole, lossy] }), START + 1_000);
    expect(second.reports).toMatchObject([{ op: "update", references: [first.reports[0]!.key], severity: "moderate", urgency: "expected" }]);
    expect(second.reports[0]!.description).toContain("It kept 30 events, and it could not read each part of the file (3 positions).");
    expect(codes(systemReports(second.lines, snapshot({ recoveries: [whole, lossy] }), START + 1_000 + DAY).reports)).toEqual([["cancel", "system.log.recovered"]]);
    expect(addSystemReports(NO_SYSTEM_LINES, [...first.reports, ...second.reports], [...first.observations, ...second.observations])).toEqual(second.lines);
  });

  it("goes to the digest of the person who watches the log with no loss, to the notice with a loss, and to no other person", () => {
    const quiet = systemReports(NO_SYSTEM_LINES, snapshot({ recoveries: [whole] }), START);
    expect(levels(quiet.reports, WATCHER, START)).toEqual(["digest"]);
    expect(levels(quiet.reports, OPERATOR, START)).toEqual(["none"]);
    const loud = systemReports(NO_SYSTEM_LINES, snapshot({ recoveries: [lossy] }), START + 1_000);
    expect(levels(loud.reports, WATCHER, START + 1_000)).toEqual(["notice"]);
    // A file that the salvage cannot read gives no count of the lost positions. It is a loss all the same.
    const none = systemReports(NO_SYSTEM_LINES, snapshot({ recoveries: [unread] }), START);
    expect(none.reports).toMatchObject([{ severity: "moderate", urgency: "expected" }]);
    expect(none.reports[0]!.description).toContain("It kept 0 events, and it could not read each part of the file. A lost event");
    expect(levels(none.reports, WATCHER, START)).toEqual(["notice"]);
  });
});

describe("the store reports (AL-86)", () => {
  const START = Date.UTC(2026, 10, 18, 12);
  const END = START + STORE_FILL_WINDOW;
  const fire: StoreFill = { store: "shapes", family: "fire", entries: 0, since: START, within: STORE_FILL_WINDOW, sources: [API.id] };
  const county: StoreFill = { ...fire, family: "county" };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code, report.about[0]!.id]);

  it("gives no report before the end of the window, and an alert for each family with no entry at its end", () => {
    expect(STORE_FILL_WINDOW).toBe(60 * 60_000);
    expect(unknownKinds(["system.store", "system.store.empty"])).toEqual([]);
    expect(storeEmptyAt(fire)).toBe(END);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ stores: [fire, county] }), END - 1).reports).toEqual([]);
    const late = systemReports(NO_SYSTEM_LINES, snapshot({ stores: [fire, { ...county, entries: 3 }] }), END);
    expect(late.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.store.empty", label: "Empty store" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [
          { system: STORE_SUBJECT, id: "shapes/fire" },
          { system: SOURCE_SUBJECT, id: API.id, label: "The API" },
        ],
        headline: "The store shapes has no entry of the family fire 60 minutes after the start.",
        parameters: { entries: ["0"], within: [String(STORE_FILL_WINDOW)] },
      },
    ]);
    expect(Object.keys(late.lines.open)).toEqual(["store/shapes/fire"]);
  });

  it("keeps the line over a restart with no entry, keeps it with no list, and ends it at the first entry", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ stores: [fire] }), END);
    // A restart gives a new start. The family has no entry, thus the line stays open, with no new report.
    const restart: StoreFill = { ...fire, since: END + 60_000 };
    const held = systemReports(first.lines, snapshot({ stores: [restart] }), END + 61_000);
    expect(held.reports).toEqual([]);
    expect(held.lines).toEqual(first.lines);
    // With no list, as when the read of the store throws, the line stays open.
    expect(systemReports(first.lines, snapshot(), END + 62_000).reports).toEqual([]);
    const filled = systemReports(first.lines, snapshot({ stores: [{ ...restart, entries: 1 }] }), END + 63_000);
    expect(codes(filled.reports)).toEqual([["cancel", "system.store.empty", "shapes/fire"]]);
    expect(filled.lines.open).toEqual({});
    // An empty list is a copy with no store. Then no family is a condition.
    expect(codes(systemReports(first.lines, snapshot({ stores: [] }), END + 64_000).reports)).toEqual([["cancel", "system.store.empty", "shapes/fire"]]);
  });

  it("goes as a notice to the person who watches a source of the store or the store, and to no other person", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ stores: [fire] }), END);
    expect(levels(step.reports, OPERATOR, END)).toEqual(["notice"]);
    expect(levels(step.reports, NEIGHBOR, END)).toEqual(["none"]);
    expect(levels(step.reports, { ...NEIGHBOR, subjects: [{ system: STORE_SUBJECT }] }, END)).toEqual(["notice"]);
  });
});

describe("the bound reports (AL-145)", () => {
  const AT = Date.UTC(2026, 10, 24, 12);
  const state: StoreBound = { store: "state", family: "reports", entries: 9_000, limit: 10_000, waiting: 0, sources: [] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code, report.about[0]!.id]);

  it("gives an alert when the store reaches its bound or an entry waits, and no update for a new count", () => {
    expect(unknownKinds(["system.store.full"])).toEqual([]);
    expect(atBound(state)).toBe(false);
    expect(atBound({ ...state, entries: 10_000 })).toBe(true);
    expect(atBound({ ...state, waiting: 1 })).toBe(true);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ bounds: [state] }), AT).reports).toEqual([]);
    const full = systemReports(NO_SYSTEM_LINES, snapshot({ bounds: [{ ...state, entries: 10_000, waiting: 250, sources: [API.id] }] }), AT);
    expect(full.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.store.full", label: "Full store" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [
          { system: STORE_SUBJECT, id: "state/reports" },
          { system: SOURCE_SUBJECT, id: API.id, label: "The API" },
        ],
        headline: "The store state is at its bound of 10,000 entries of the family reports.",
        parameters: { entries: ["10000"], limit: ["10000"], waiting: ["250"] },
      },
    ]);
    expect(Object.keys(full.lines.open)).toEqual(["bound/state/reports"]);
    // A new count is not a fact. Thus the line gives no update.
    expect(systemReports(full.lines, snapshot({ bounds: [{ ...state, entries: 10_000, waiting: 900 }] }), AT + 60_000).reports).toEqual([]);
    // With no list, the line stays open.
    expect(systemReports(full.lines, snapshot(), AT + 120_000).reports).toEqual([]);
    // Space in the store and no entry that waits end the line.
    expect(codes(systemReports(full.lines, snapshot({ bounds: [state] }), AT + 180_000).reports)).toEqual([["cancel", "system.store.full", "state/reports"]]);
  });

  it("goes as a notice to the person who watches a source of the waiting entries or the store", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ bounds: [{ ...state, waiting: 1, sources: [API.id] }] }), AT);
    expect(levels(step.reports, OPERATOR, AT)).toEqual(["notice"]);
    expect(levels(step.reports, NEIGHBOR, AT)).toEqual(["none"]);
    expect(levels(step.reports, { ...NEIGHBOR, subjects: [{ system: STORE_SUBJECT }] }, AT)).toEqual(["notice"]);
  });
});

describe("the route reports (AL-154)", () => {
  const AT = Date.UTC(2026, 10, 26, 12);
  const below: RouteLoad = { routes: 10_999, limit: 11_000 };
  const at: RouteLoad = { routes: 11_000, limit: 11_000 };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code, report.about[0]!.id]);
  const watch = (copy: string, read: number): CopyWatch => ({ copy, skewLimit: 2_000, maxAge: 60_000, since: AT, read: { at: read, skew: 0, sameConfig: true } });

  it("gives an alert at the limit, no update for a new count, and a cancel below the limit", () => {
    expect(unknownKinds(["system.store.routes"])).toEqual([]);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ routes: below }), AT).reports).toEqual([]);
    const many = systemReports(NO_SYSTEM_LINES, snapshot({ routes: at }), AT);
    expect(many.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.store.routes", label: "Many routes" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: STORE_SUBJECT, id: `${ROUTE_STORE}/${ROUTE_FAMILY}` }],
        headline: "The delivery has 11,000 routes, at or over its limit of 11,000 routes.",
        parameters: { routes: ["11000"], limit: ["11000"] },
      },
    ]);
    expect(Object.keys(many.lines.open)).toEqual(["routes/delivery"]);
    // A new count is not a fact. Thus the line gives no update.
    expect(systemReports(many.lines, snapshot({ routes: { ...at, routes: 40_000 } }), AT + 60_000).reports).toEqual([]);
    // With no field, the line stays open: a restart has no count until its first delivery step.
    expect(systemReports(many.lines, snapshot(), AT + 120_000).reports).toEqual([]);
    expect(codes(systemReports(many.lines, snapshot({ routes: below }), AT + 180_000).reports)).toEqual([["cancel", "system.store.routes", "delivery/routes"]]);
  });

  it("is reported and ended only by the copy that reports the shared facts", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ routes: at, copy: "copy-a", copies: [watch("copy-b", AT)] }), AT);
    expect(codes(first.reports)).toEqual([["alert", "system.store.routes", "delivery/routes"]]);
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ routes: at, copy: "copy-b", copies: [watch("copy-a", AT)] }), AT).reports).toEqual([]);
    // The second copy keeps the open line of the first copy, also with a count below the limit.
    expect(systemReports(first.lines, snapshot({ routes: below, copy: "copy-b", copies: [watch("copy-a", AT)] }), AT).reports).toEqual([]);
  });

  it("goes as a notice to the person who watches the store, and to no other person", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ routes: at }), AT);
    // The report names no source. Thus a person who watches only the sources does not get it.
    expect(levels(step.reports, OPERATOR, AT)).toEqual(["none"]);
    expect(levels(step.reports, NEIGHBOR, AT)).toEqual(["none"]);
    expect(levels(step.reports, { ...NEIGHBOR, subjects: [{ system: STORE_SUBJECT }] }, AT)).toEqual(["notice"]);
  });
});

describe("the redundancy reports (AL-90)", () => {
  const AT = Date.UTC(2026, 10, 23, 20);
  const push = { id: "push", name: "The push to a person" };
  const pushover = { id: "pushover", name: "Pushover" };
  const twilio = { id: "twilio", name: "Twilio" };
  const carriers = { id: "carriers", name: "The carriers of the texts" };
  const full: RedundancyState = { function: push, works: true, points: [], down: [] };
  const single: RedundancyState = { function: push, works: true, points: [pushover], down: [carriers] };
  const stopped: RedundancyState = { function: push, works: false, points: [], down: [carriers, pushover] };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code, report.about[0]!.id]);

  it("gives the stage of a function from its state", () => {
    expect(unknownKinds(["system.redundancy", "system.redundancy.single", "system.redundancy.stopped"])).toEqual([]);
    expect(redundancyStage(full)).toBeUndefined();
    expect(redundancyStage(single)).toBe("single");
    expect(redundancyStage(stopped)).toBe("stopped");
    // A function that does not work is stopped, also with points in its state.
    expect(redundancyStage({ works: false, points: [pushover] })).toBe("stopped");
  });

  it("gives an alert for a new single point of failure, and no report for a function with its full redundancy", () => {
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ redundancy: [full] }), AT).reports).toEqual([]);
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ redundancy: [single] }), AT);
    expect(step.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.redundancy.single", label: "Function with a new single point of failure" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: FUNCTION_SUBJECT, id: "push", label: "The push to a person" }],
        headline: "The push to a person has a single point of failure: Pushover.",
        description: "The open incidents tell that these parts are down: The carriers of the texts. A failure of this point alone stops The push to a person.",
        parameters: { stage: ["single"], points: ["pushover"], down: ["carriers"] },
      },
    ]);
    expect(Object.keys(step.lines.open)).toEqual(["redundancy/push/single"]);
    expect(addSystemReports(NO_SYSTEM_LINES, step.reports, step.observations)).toEqual(step.lines);
  });

  it("moves from single to stopped and back, and ends each line at the full redundancy", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ redundancy: [single] }), AT);
    // A new down part that leaves the same points is not a new fact.
    const same = systemReports(first.lines, snapshot({ redundancy: [{ ...single, down: [carriers, twilio] }] }), AT + 1);
    expect(same.reports).toEqual([]);
    const stop = systemReports(first.lines, snapshot({ redundancy: [stopped] }), AT + 2);
    expect(codes(stop.reports)).toEqual([
      ["cancel", "system.redundancy.single", "push"],
      ["alert", "system.redundancy.stopped", "push"],
    ]);
    expect(stop.reports[1]).toMatchObject({ severity: "severe", urgency: "immediate", headline: "The push to a person does not work." });
    const back = systemReports(stop.lines, snapshot({ redundancy: [full] }), AT + 3);
    expect(codes(back.reports)).toEqual([["cancel", "system.redundancy.stopped", "push"]]);
    expect(back.lines.open).toEqual({});
  });

  it("updates the line when the points change, and keeps each open line with no list", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ redundancy: [single] }), AT);
    const more = systemReports(first.lines, snapshot({ redundancy: [{ ...single, points: [twilio, pushover] }] }), AT + 1);
    expect(more.reports).toMatchObject([{ op: "update", references: [first.reports[0]!.key], parameters: { points: ["pushover", "twilio"] } }]);
    // With no list, as when the stack of the chain is not in the configuration, the line stays open.
    expect(systemReports(first.lines, snapshot(), AT + 2).reports).toEqual([]);
  });

  it("goes as a notice to the person who watches the functions of the chain, and to no other person", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ redundancy: [single] }), AT);
    expect(levels(step.reports, NEIGHBOR, AT)).toEqual(["none"]);
    expect(levels(step.reports, { ...NEIGHBOR, subjects: [{ system: FUNCTION_SUBJECT }] }, AT)).toEqual(["notice"]);
  });
});

describe("the notices of the send limit (AL-81)", () => {
  const AT = Date.UTC(2026, 10, 18, 12);
  const WINDOW = 60 * 60_000;
  const held = (person: PersonWatch, first = AT - 60_000, last = AT): HeldPerson => ({ person: person.person, first, last, until: last + WINDOW, count: 2, alerts: [] });

  it("gives one private notice to each person with a hold, with the person as its only address", () => {
    expect(unknownKinds(["system.limit", "system.limit.held"])).toEqual([]);
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ held: [held(OPERATOR)] }), AT);
    expect(step.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.limit.held", label: "Alerts held" },
        severity: "moderate",
        urgency: "expected",
        onset: AT - 60_000,
        areas: [],
        about: [{ system: PERSON_SUBJECT, id: OPERATOR.person }],
        addresses: [OPERATOR.person],
        headline: "The send limit holds new alerts for you",
      },
    ]);
    expect(step.reports.every((report) => reportSchema.safeParse(report).success)).toBe(true);
    // Only the person gets the notice. A person who watches the person or each source does not get it.
    expect(levels(step.reports, OPERATOR, AT)).toEqual(["notice"]);
    expect(levels(step.reports, NEIGHBOR, AT)).toEqual(["none"]);
    expect(levels(step.reports, { ...NEIGHBOR, subjects: [{ system: PERSON_SUBJECT }, { system: SOURCE_SUBJECT }] }, AT)).toEqual(["none"]);
  });

  it("gives no report for a later hold in the window, and cancels the line of the same person when the holds leave the window", () => {
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ held: [held(OPERATOR)] }), AT);
    // A later hold changes the last time and the count, not the facts. Thus the person gets one notice in each window.
    expect(systemReports(first.lines, snapshot({ held: [{ ...held(OPERATOR, AT - 60_000, AT + 60_000), count: 3 }] }), AT + 60_000).reports).toEqual([]);
    // With no list, as in a copy with no delivery, the line stays open.
    expect(systemReports(first.lines, snapshot(), AT + 120_000).reports).toEqual([]);
    const ended = systemReports(first.lines, snapshot({ held: [] }), AT + WINDOW);
    expect(ended.reports.map((report) => [report.op, report.kind.code, report.addresses])).toEqual([["cancel", "system.limit.held", [OPERATOR.person]]]);
    expect(ended.lines.open).toEqual({});
    // A hold after the end opens a new line, thus a new notice.
    const again = systemReports(ended.lines, snapshot({ held: [held(OPERATOR, AT + WINDOW + 1, AT + WINDOW + 1)] }), AT + WINDOW + 1);
    expect(again.reports.map((report) => report.op)).toEqual(["alert"]);
  });

  it("keeps the addresses of a line in the lines that the log gives", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ held: [held(OPERATOR)] }), AT);
    const lines = addSystemReports(NO_SYSTEM_LINES, step.reports, step.observations);
    expect(lines).toEqual(step.lines);
    expect(systemReports(lines, snapshot({ held: [] }), AT + WINDOW).reports[0]?.addresses).toEqual([OPERATOR.person]);
  });

  it("names the held alerts from the highest level, and the count of the rest (AL-98)", () => {
    const alert = (index: number, level: "notice" | "urgent"): HeldAlert => ({ incident: String(index).repeat(64) as ReportId, level, headline: `Flood Statement ${index}` });
    const alerts = [alert(1, "urgent"), alert(2, "notice"), alert(3, "notice"), alert(4, "notice"), alert(5, "notice")];
    expect(heldText({ alerts: alerts.slice(0, HELD_SHOWN) }).split("\n")).toEqual([
      "The send limit holds 3 new alerts for you:",
      "- Flood Statement 1 (urgent)",
      "- Flood Statement 2 (notice)",
      "- Flood Statement 3 (notice)",
      "The limit does not hold a life-safety warning.",
    ]);
    expect(heldText({ alerts }).split("\n")).toEqual([
      "The send limit holds 5 new alerts for you:",
      "- Flood Statement 1 (urgent)",
      "- Flood Statement 2 (notice)",
      "- Flood Statement 3 (notice)",
      "- 2 other alerts",
      "The limit does not hold a life-safety warning.",
    ]);
    // With no known report, the text names no alert.
    expect(heldText({ alerts: [] })).toBe("More new alerts came than your send limit lets through in one window. The limit does not hold a life-safety warning.");
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ held: [{ ...held(OPERATOR), alerts }] }), AT);
    expect(step.reports[0]?.description).toBe(heldText({ alerts }));
  });

  it("comes from one copy: the copy that reports the facts of a shared account", () => {
    // The copy a has the smaller id, and it answers. Thus it reports, and the copy b does not.
    const watch = (copy: string): CopyWatch => ({ copy, skewLimit: 60_000, maxAge: 10 * 60_000, since: AT });
    const count = (copy: string, other: string): number =>
      systemReports(NO_SYSTEM_LINES, snapshot({ held: [held(OPERATOR)], copy, copies: [watch(other)] }), AT).reports.filter((report) => report.kind.code === "system.limit.held").length;
    expect([count("a", "b"), count("b", "a")]).toEqual([1, 0]);
  });
});

describe("the reports of the stale moving places (AL-40)", () => {
  const AT = Date.UTC(2026, 10, 24, 12);
  const stale = (persons: readonly PersonId[] = [OPERATOR.person]): StalePlace => ({ place: "place:moving" as PlaceId, label: "Phone", persons });

  it("gives one private notice to the persons of the place, with the label and no position", () => {
    expect(unknownKinds(["system.place", "system.place.stale"])).toEqual([]);
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ stale: [stale()], copy: "home" }), AT);
    expect(step.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.place.stale", label: "Stale moving place" },
        severity: "moderate",
        urgency: "expected",
        areas: [],
        about: [{ system: PLACE_SUBJECT, id: "place:moving", label: "Phone" }],
        addresses: [OPERATOR.person],
        headline: "The watch of the moving place Phone stopped.",
      },
    ]);
    expect(step.reports.every((report) => reportSchema.safeParse(report).success)).toBe(true);
    expect(levels(step.reports, OPERATOR, AT)).toEqual(["notice"]);
    expect(levels(step.reports, NEIGHBOR, AT)).toEqual(["none"]);
  });

  it("gives no report for a place with no person, keeps the line with no list, and cancels it at the next good fix", () => {
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ stale: [stale([])] }), AT).reports).toEqual([]);
    const first = systemReports(NO_SYSTEM_LINES, snapshot({ stale: [stale()], copy: "home" }), AT);
    expect(systemReports(first.lines, snapshot({ stale: [stale()], copy: "home" }), AT + 60_000).reports).toEqual([]);
    expect(systemReports(first.lines, snapshot({ copy: "home" }), AT + 60_000).reports).toEqual([]);
    const ended = systemReports(first.lines, snapshot({ stale: [], copy: "home" }), AT + 120_000);
    expect(ended.reports.map((report) => [report.op, report.kind.code, report.addresses])).toEqual([["cancel", "system.place.stale", [OPERATOR.person]]]);
    expect(ended.lines.open).toEqual({});
  });

  it("keeps a line of each copy apart", () => {
    const home = systemReports(NO_SYSTEM_LINES, snapshot({ stale: [stale()], copy: "home" }), AT);
    // Another copy with no stale place keeps the line of this copy open.
    const lines = addSystemReports(NO_SYSTEM_LINES, home.reports, home.observations);
    expect(lines).toEqual(home.lines);
    expect(systemReports(lines, snapshot({ stale: [stale()], copy: "cloud" }), AT).reports.map((report) => report.op)).toEqual(["alert"]);
    // Another copy with an empty list ends none of the lines of this copy.
    expect(systemReports(lines, snapshot({ stale: [], copy: "cloud" }), AT).reports).toEqual([]);
  });
});

describe("the observe reports (AL-73)", () => {
  const START = Date.UTC(2026, 10, 18, 12);
  const NEW: SourceDescriptor = { ...API, id: "gtfs-new" as SourceId, title: "The new feed" };
  const CONTEXT: SourceDescriptor = { ...API, id: "gtfs-context" as SourceId, title: "The transit feed", kinds: ["transport.transit"] };
  const held: ObserveCondition = { source: NEW.id, state: "held", since: START, reason: "person 1: 7 notices in 1 hour, limit 6", incidents: [] };
  const lifeSafety: ObserveCondition = { source: NEW.id, state: "life-safety", since: START, reason: "", incidents: ["a".repeat(64) as ReportId] };
  const observed = (observing?: readonly ObserveCondition[]) => snapshot({ sources: [API, NEW, CONTEXT], ...(observing === undefined ? {} : { observing }) });
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code]);

  it("opens a held line with the reason as its text, keeps it with a new reason or with no list, and ends it with an empty list", () => {
    const open = systemReports(NO_SYSTEM_LINES, observed([held]), START);
    expect(open.reports).toMatchObject([{ op: "alert", kind: { code: "system.health.observe" }, severity: "moderate", urgency: "expected", about: [{ system: SOURCE_SUBJECT }] }]);
    expect(open.reports[0]!.headline).toBe("The new feed: the source stays in the observe mode.");
    expect(open.reports[0]!.description).toBe(held.reason);
    expect(Object.keys(open.lines.open)).toEqual(["observe/gtfs-new/held"]);
    expect(systemReports(open.lines, observed([{ ...held, reason: "person 1: 8 notices in 1 hour, limit 6" }]), START + 1).reports).toEqual([]);
    expect(systemReports(open.lines, observed(), START + 2).reports).toEqual([]);
    expect(codes(systemReports(open.lines, observed([]), START + 3).reports)).toEqual([["cancel", "system.health.observe"]]);
  });

  it("gives a life-safety line an update for each new incident, and the operator a notice", () => {
    const open = systemReports(NO_SYSTEM_LINES, observed([lifeSafety]), START);
    expect(codes(open.reports)).toEqual([["alert", "system.health.observe-life-safety"]]);
    expect(levels(open.reports, OPERATOR, START)).toEqual(["notice"]);
    expect(levels(open.reports, NEIGHBOR, START)).toEqual(["none"]);
    const more = systemReports(open.lines, observed([{ ...lifeSafety, incidents: [...lifeSafety.incidents, "b".repeat(64) as ReportId] }]), START + 1);
    expect(codes(more.reports)).toEqual([["update", "system.health.observe-life-safety"]]);
  });

  it("keeps the health line in its clear time and the held line of the same source open, because their names differ", () => {
    const MINUTE = 60_000;
    // The new source fails, then comes back at START. Its health line holds for its clear time of 15 minutes (AL-75).
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ sources: [API, NEW], health: [{ ...healthOf("failing", START - MINUTE), source: NEW.id }] }), START - MINUTE);
    const both = (observing: readonly ObserveCondition[]) => snapshot({ sources: [API, NEW], health: [{ ...healthOf("healthy", START), source: NEW.id }], observing });
    const open = systemReports(down.lines, both([held]), START);
    expect(codes(open.reports)).toEqual([["alert", "system.health.observe"]]);
    expect(Object.keys(open.lines.open).sort()).toEqual(["health/gtfs-new", "observe/gtfs-new/held"]);
    // The clear time ends the health line only. The held line stays until its verdict passes.
    const cleared = systemReports(open.lines, both([held]), START + 15 * MINUTE);
    expect(codes(cleared.reports)).toEqual([["cancel", "system.health.failing"]]);
    expect(Object.keys(cleared.lines.open)).toEqual(["observe/gtfs-new/held"]);
  });

  it("gives a source of context only the level digest", () => {
    const open = systemReports(NO_SYSTEM_LINES, observed([{ ...held, source: CONTEXT.id }]), START);
    expect(open.reports).toMatchObject([{ severity: "minor", urgency: "future" }]);
    expect(levels(open.reports, OPERATOR, START)).toEqual(["digest"]);
  });
});

describe("the drill reports", () => {
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;
  const START = Date.UTC(2026, 10, 21, 17);
  const WATCHER: PersonWatch = { ...NEIGHBOR, subjects: [{ system: DRILL_SUBJECT, id: "push-weekly" }] };
  const DRILL: DrillConfig = {
    id: "push-weekly",
    person: WATCHER.person,
    path: { kind: "channel", channel: "pushover" as ChannelId },
    every: 6 * 24 * 60 * MINUTE,
    window: { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] },
    ackWithin: 30 * MINUTE,
  };
  const codes = (reports: readonly Report[]) => reports.map((report) => [report.op, report.kind.code, report.key.slice(0, report.key.lastIndexOf("#"))]);
  const drills = (run?: Partial<DrillRun>, copy = "home") => ({ drills: [{ copy, drill: DRILL, ...(run === undefined ? {} : { run: { drill: DRILL.id, at: START, ...run } }) }] });

  it("opens the run line at the start, and cancels it at the acknowledgment", () => {
    const started = systemReports(NO_SYSTEM_LINES, snapshot(drills({})), START);
    expect(codes(started.reports)).toEqual([["alert", "system.drill.run", "drill/home/push-weekly"]]);
    expect(started.reports[0]).toMatchObject({ severity: "extreme", urgency: "immediate", onset: START, areas: [], about: [{ system: DRILL_SUBJECT, id: "push-weekly" }] });
    expect(started.reports[0]!.headline).toBe("Drill push-weekly: acknowledge this message. This is not a warning.");
    // The same run later gives no report, and an acknowledgment in the time passes the drill.
    expect(systemReports(started.lines, snapshot(drills({})), START + 29 * MINUTE).reports).toEqual([]);
    const passed = systemReports(started.lines, snapshot(drills({ acked: START + 5 * MINUTE })), START + 5 * MINUTE);
    expect(codes(passed.reports)).toEqual([["cancel", "system.drill.run", "drill/home/push-weekly"]]);
    expect(passed.lines.open).toEqual({});
  });

  it("ends the run line and opens the failed line at the end of the time, and updates it for a late acknowledgment", () => {
    const started = systemReports(NO_SYSTEM_LINES, snapshot(drills({})), START);
    const failed = systemReports(started.lines, snapshot(drills({})), START + 30 * MINUTE);
    // The fold gives the reports in the order of the names of the lines.
    expect(codes(failed.reports)).toEqual([
      ["cancel", "system.drill.run", "drill/home/push-weekly"],
      ["alert", "system.drill.failed", "drill/home/push-weekly/failed"],
    ]);
    expect(failed.reports[1]!.headline).toBe("The drill push-weekly failed: no acknowledgment came in 30 minutes.");
    // A call says the description, thus the time is in words, not an ISO time (AL-188).
    expect(failed.reports[1]!.description).toContain("The drill message went out at 17:00 UTC on 21 November 2026 on the channel ");
    const late = systemReports(failed.lines, snapshot(drills({ acked: START + 40 * MINUTE })), START + 40 * MINUTE);
    expect(codes(late.reports)).toEqual([["update", "system.drill.failed", "drill/home/push-weekly/failed"]]);
    expect(late.reports[0]!.headline).toBe("The drill push-weekly failed: the acknowledgment came after 30 minutes.");
    // The next run ends the failed line, and its own verdict decides again.
    const next = systemReports(late.lines, snapshot(drills({ at: START + DRILL.every + DAY })), START + DRILL.every + DAY);
    expect(codes(next.reports)).toEqual([
      ["alert", "system.drill.run", "drill/home/push-weekly"],
      ["cancel", "system.drill.failed", "drill/home/push-weekly/failed"],
    ]);
  });

  it("gives a failure with the reason no-start for a drill with no next start, and ends it at the next start", () => {
    const stuck = { drills: [{ copy: "home", drill: DRILL, noStart: true }] };
    const failed = systemReports(NO_SYSTEM_LINES, snapshot(stuck), START);
    expect(codes(failed.reports)).toEqual([["alert", "system.drill.failed", "drill/home/push-weekly/no-start"]]);
    expect(failed.reports[0]!.headline).toBe("The drill push-weekly has no next start.");
    expect(failed.reports[0]!.parameters).toEqual({ drill: ["push-weekly"], copy: ["home"], why: ["no-start"] });
    // The same condition later gives no report. A next start ends the line, and the last run keeps its own line.
    expect(systemReports(failed.lines, snapshot(stuck), START + MINUTE).reports).toEqual([]);
    const fixed = systemReports(failed.lines, snapshot(drills({})), START + 2 * MINUTE);
    expect(codes(fixed.reports)).toEqual([
      ["alert", "system.drill.run", "drill/home/push-weekly"],
      ["cancel", "system.drill.failed", "drill/home/push-weekly/no-start"],
    ]);
  });

  it("gives a failure with the reason missed for a start that the copy missed, and ends it at the next run", () => {
    const due = START + DRILL.every + DAY;
    const missed = { drills: [{ copy: "home", drill: DRILL, run: { drill: DRILL.id, at: START, acked: START + MINUTE }, missed: due }] };
    const failed = systemReports(NO_SYSTEM_LINES, snapshot(missed), due + 7 * 60 * MINUTE);
    expect(codes(failed.reports)).toEqual([["alert", "system.drill.failed", "drill/home/push-weekly/missed"]]);
    expect(failed.reports[0]).toMatchObject({ severity: "moderate", urgency: "expected", onset: due, areas: [] });
    expect(failed.reports[0]!.headline).toBe("The drill push-weekly did not start at its time.");
    expect(failed.reports[0]!.parameters).toEqual({ drill: ["push-weekly"], copy: ["home"], why: ["missed"] });
    // The same missed start later gives no report. The next run ends the line, and its own line opens.
    expect(systemReports(failed.lines, snapshot(missed), due + DAY).reports).toEqual([]);
    const next = due + 7 * DAY;
    const run = systemReports(failed.lines, snapshot(drills({ at: next })), next);
    expect(codes(run.reports)).toEqual([
      ["alert", "system.drill.run", "drill/home/push-weekly"],
      ["cancel", "system.drill.failed", "drill/home/push-weekly/missed"],
    ]);
  });

  it("keeps the lines with no drills in the snapshot, ends them for a drill that is gone, and starts no line with no run", () => {
    const started = systemReports(NO_SYSTEM_LINES, snapshot(drills({})), START);
    expect(systemReports(started.lines, snapshot(), START + 40 * MINUTE).reports).toEqual([]);
    expect(codes(systemReports(started.lines, snapshot({ drills: [] }), START + MINUTE).reports)).toEqual([["cancel", "system.drill.run", "drill/home/push-weekly"]]);
    expect(systemReports(NO_SYSTEM_LINES, snapshot(drills()), START).reports).toEqual([]);
    // A run of another drill is not a run of this drill.
    expect(systemReports(NO_SYSTEM_LINES, snapshot(drills({ drill: "other" })), START).reports).toEqual([]);
    // Each copy has its own lines.
    const two = systemReports(NO_SYSTEM_LINES, snapshot({ drills: [...drills({}).drills, ...drills({}, "cloud").drills] }), START);
    expect(Object.keys(two.lines.open)).toEqual(["drill/cloud/push-weekly", "drill/home/push-weekly"]);
  });

  it("reaches life-safety for the person who watches the drill, notice for a failure, and rebuilds from its reports", () => {
    const started = systemReports(NO_SYSTEM_LINES, snapshot(drills({})), START);
    expect(levels(started.reports, WATCHER, START)).toEqual(["life-safety"]);
    expect(levels(started.reports, NEIGHBOR, START)).toEqual(["none"]);
    expect(levels(started.reports, { ...NEIGHBOR, subjects: [{ system: DRILL_SUBJECT, id: "other" }] }, START)).toEqual(["none"]);
    const failed = systemReports(started.lines, snapshot(drills({})), START + 30 * MINUTE);
    const failure = failed.reports.filter((report) => report.op === "alert");
    expect(levels(failure, WATCHER, START + 30 * MINUTE)).toEqual(["notice"]);
    expect(addSystemReports(started.lines, failed.reports, failed.observations)).toEqual(failed.lines);
  });

  describe("the watch of a drill of another copy", () => {
    const HOUR = 60 * MINUTE;
    const watch: DrillWatch = { drill: { ...DRILL, copies: ["cloud"] }, copy: "cloud" };
    const next = START + 7 * DAY;
    // The window of each Saturday ends at 17:00 in Chicago, 6 hours after its start.
    const end = next + 6 * HOUR;
    const read = (at: number): CopyRead => ({ at, skew: 0, sameConfig: true });
    const cloud = (extra: Partial<CopyWatch> = {}): CopyWatch => ({ copy: "cloud", skewLimit: MINUTE, maxAge: 5 * MINUTE, since: START - DAY, ...extra });
    const watched = (copy: CopyWatch) => ({ copies: [copy], copy: "home", drillWatches: [watch] });
    const own = (reports: readonly Report[]) => reports.filter((report) => report.key.startsWith("drill-watch/"));
    const seen = cloud({ read: read(START + HOUR), drills: { [DRILL.id]: START } });

    it("tells of a start that the other copy missed, keeps it over a restart, and ends it at the next start", () => {
      expect(own(systemReports(NO_SYSTEM_LINES, snapshot(watched(seen)), end + DRILL_WATCH_GRACE - 1).reports)).toEqual([]);
      const missed = systemReports(NO_SYSTEM_LINES, snapshot(watched(seen)), end + DRILL_WATCH_GRACE);
      expect(codes(own(missed.reports))).toEqual([["alert", "system.drill.failed", "drill-watch/cloud/push-weekly"]]);
      expect(own(missed.reports)[0]).toMatchObject({ severity: "moderate", urgency: "expected", onset: end, areas: [] });
      expect(own(missed.reports)[0]!.headline).toBe("No start of the drill push-weekly came from the copy cloud.");
      expect(own(missed.reports)[0]!.parameters).toEqual({ drill: ["push-weekly"], copy: ["cloud"], why: ["unseen"] });
      expect(own(missed.reports)[0]!.description).toContain(`The last read of the copy cloud that passed was at ${new Date(START + HOUR).toISOString()}.`);
      expect(levels(own(missed.reports), WATCHER, end + DRILL_WATCH_GRACE)).toEqual(["notice"]);
      expect(addSystemReports(NO_SYSTEM_LINES, missed.reports, missed.observations)).toEqual(missed.lines);
      // A new read with the same facts gives no update. After a restart, the watch starts again, and the open line keeps its start.
      expect(own(systemReports(missed.lines, snapshot(watched(cloud({ read: read(end + DAY), drills: { [DRILL.id]: START } }))), end + DAY).reports)).toEqual([]);
      expect(own(systemReports(missed.lines, snapshot(watched(cloud({ since: end + DAY }))), end + DAY + HOUR).reports)).toEqual([]);
      // The next start of the other copy ends the line.
      const back = cloud({ read: read(next + 7 * DAY + HOUR), drills: { [DRILL.id]: next + 7 * DAY } });
      expect(codes(own(systemReports(missed.lines, snapshot(watched(back)), next + 7 * DAY + HOUR).reports))).toEqual([["cancel", "system.drill.failed", "drill-watch/cloud/push-weekly"]]);
    });

    it("tells that it cannot read when the other copy answers with no starts of drills", () => {
      const old = systemReports(NO_SYSTEM_LINES, snapshot(watched(cloud({ read: read(START + 7 * HOUR) }))), START + 7 * HOUR);
      expect(codes(own(old.reports))).toEqual([["alert", "system.drill.failed", "drill-watch/cloud/push-weekly"]]);
      expect(own(old.reports)[0]).toMatchObject({ severity: "minor", onset: START + 6 * HOUR });
      expect(own(old.reports)[0]!.headline).toBe("This copy cannot tell if the drill push-weekly started.");
      expect(own(old.reports)[0]!.parameters).toEqual({ drill: ["push-weekly"], copy: ["cloud"], why: ["no-read"] });
      // A read with the starts changes the reason, thus the line gets an update.
      const unseen = systemReports(old.lines, snapshot(watched(cloud({ read: read(START + 8 * HOUR), drills: {} }))), START + 8 * HOUR);
      expect(codes(own(unseen.reports))).toEqual([["update", "system.drill.failed", "drill-watch/cloud/push-weekly"]]);
    });

    it("keeps the lines with no watches in the snapshot, and ends them for a watch that is gone", () => {
      const missed = systemReports(NO_SYSTEM_LINES, snapshot(watched(seen)), end + DRILL_WATCH_GRACE);
      expect(own(systemReports(missed.lines, snapshot(), end + DAY).reports)).toEqual([]);
      expect(codes(own(systemReports(missed.lines, snapshot({ copies: [seen], copy: "home", drillWatches: [] }), end + DAY).reports))).toEqual([["cancel", "system.drill.failed", "drill-watch/cloud/push-weekly"]]);
      // The lines of the drills of this copy keep their own guard.
      const run = drills({ at: end + DRILL_WATCH_GRACE });
      const both = systemReports(missed.lines, snapshot({ ...watched(seen), ...run }), end + DRILL_WATCH_GRACE);
      expect(Object.keys(both.lines.open).filter((line) => line.startsWith("drill")).sort()).toEqual(["drill-watch/cloud/push-weekly", "drill/home/push-weekly"]);
      expect(systemReports(both.lines, snapshot(run), end + DRILL_WATCH_GRACE + MINUTE).lines.open).toHaveProperty(["drill-watch/cloud/push-weekly"]);
    });

    it("gives the time of the miss for a timer, with the start of the open line", () => {
      expect(drillWatchAt(NO_SYSTEM_LINES, watch, [seen])).toBe(end + DRILL_WATCH_GRACE);
      const missed = systemReports(NO_SYSTEM_LINES, snapshot(watched(seen)), end + DRILL_WATCH_GRACE);
      expect(drillWatchAt(missed.lines, watch, [cloud({ since: end + DAY })])).toBe(end + DRILL_WATCH_GRACE);
      expect(drillWatchAt(NO_SYSTEM_LINES, watch, [])).toBeUndefined();
    });
  });
});

describe("the properties of the fold", () => {
  const states: HealthState[] = ["unknown", "healthy", "slow", "failing", "silent", "changed"];
  const sources = ["a", "b", "c"].map((id) => ({ ...API, id: id as SourceId, title: `Source ${id}` }));

  it.each(SEEDS)("keeps one open line for each condition, and links each line (seed %i)", (seed) => {
    const r = random(seed);
    let lines: SystemLines = NO_SYSTEM_LINES;
    const all: Report[] = [];
    const observations: Observation[] = [];
    for (let step = 0; step < 120; step += 1) {
      const health = sources.filter(() => r.chance(0.8)).map((source) => ({ source: source.id, state: r.pick(states), since: step, reason: "" }));
      const coverage = [KANSAS, TEXAS].flatMap((place) =>
        [TORNADO, "met.winter"].filter(() => r.chance(0.5)).map((kind) => gap({ place: place.id, kind, independent: r.int(0, 2), proven: r.chance(0.9) })),
      );
      const late: Lateness[] = r.chance(0.3)
        ? [{ expectation: "a-to-b", from: "a" as SourceId, to: "b" as SourceId, state: "late", limit: { delay: 60_000, misses: 1 }, missed: [`report:${r.int(0, 3)}` as ReportId], since: step }]
        : [];
      // A snapshot with no quotas is a failed read of the counts.
      const quotas: ChannelQuota[] | undefined = r.chance(0.2)
        ? undefined
        : [{ channel: "pushover" as ChannelId, limit: 100, reserve: 10, used: r.int(70, 100), resetAt: 5_000_000, ...(r.chance(0.1) ? { blockedUntil: 5_000_000 } : {}) }];
      // A random floor of the clear time, with no intervals. The line of a source that is up stays open while the source is up for less than the floor.
      const floor = r.pick([0, 20_000, 60_000, 200_000]);
      const input = snapshot({ sources, health, coverage, lateness: late, threats: r.chance(0.3) ? [{ place: KANSAS.id, kind: TORNADO }] : [], ...(quotas === undefined ? {} : { quotas }), sourceClear: { floor, fetches: 0 } });
      const before = lines;
      const result = systemReports(lines, input, step * 1_000);
      const label = `seed ${seed} step ${step}`;
      // The reports and their observations give the lines again, so the runtime rebuilds them from its log.
      expect(addSystemReports(before, result.reports, result.observations), label).toEqual(result.lines);
      observations.push(...result.observations);
      // Each update and cancel references the last key of its line, and an alert starts a line.
      for (const report of result.reports) {
        const name = report.key.slice(0, report.key.lastIndexOf("#"));
        expect(report.references, label).toEqual(report.op === "alert" ? [] : [before.open[name]!.key]);
      }
      // The open lines are the conditions of the snapshot.
      const held = (entry: (typeof health)[number]): boolean => before.open[`health/${entry.source}`] !== undefined && step * 1_000 - entry.since < floor;
      const down = health.filter((entry) => ["failing", "silent", "changed"].includes(entry.state) || held(entry)).length + late.length;
      const short = coverage.filter((entry) => !entry.proven || entry.independent < entry.required).length;
      const staged = quotas === undefined ? Object.keys(before.open).filter((name) => name.startsWith("quota/")).length : quotas.flatMap(quotaStages).length;
      expect(Object.keys(result.lines.open), label).toHaveLength(down + short + staged);
      // The same snapshot again gives no report.
      expect(systemReports(result.lines, input, step * 1_000 + 1).reports, label).toEqual([]);
      lines = result.lines;
      all.push(...result.reports);
      // The live incidents of the merge are the open lines.
      const live = incidents(normalize({ reports: all }), step * 1_000).filter((incident) => incident.live);
      expect(live, label).toHaveLength(down + short + staged);
    }
    expect(new Set(all.map((report) => report.key)).size).toBe(all.length);
    // All the reports in one call give the last lines. A report of another source changes nothing.
    const other = { ...all[0]!, source: "a" as SourceId, key: "other#999" };
    expect(addSystemReports(NO_SYSTEM_LINES, [...all, other], observations)).toEqual(lines);
  });

  it("throws for a system report with no observation, because then the log is not complete", () => {
    const step = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing")] }), 1_000);
    expect(() => addSystemReports(NO_SYSTEM_LINES, step.reports, [])).toThrow(/has no observation/);
  });
});
