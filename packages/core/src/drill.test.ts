import { describe, expect, it } from "vitest";
import type { ChannelDescriptor, ChannelId, CopyRead, CopyWatch, PersonId, QuietWindow } from "./contracts.ts";
import { drillDue, drillInCopy, drillProblems, drillVerdict, joinRuns, lastRun, missedDrillAt, nextDrillAt, watchedDrillMiss, watchedDrillReportAt, DRILL_WATCH_GRACE, type DrillConfig, type DrillRun, type DrillWatch } from "./drill.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;

// A public time zone of Texas. In November 2026, Chicago is 6 hours behind UTC.
const ZONE = "America/Chicago";
// Saturday 21 November 2026, 11:00 in Chicago.
const SATURDAY = Date.UTC(2026, 10, 21, 17);
// Wednesday 18 November 2026, 06:00 in Chicago.
const WEDNESDAY = Date.UTC(2026, 10, 18, 12);

const WEEKLY: DrillConfig = {
  id: "push-weekly",
  person,
  path: { kind: "channel", channel: pushover },
  every: 6 * DAY,
  window: { zone: ZONE, start: "11:00", end: "17:00", days: [6] },
  ackWithin: 30 * MINUTE,
};

const run = (at: number, extra: Partial<DrillRun> = {}): DrillRun => ({ drill: WEEKLY.id, at, ...extra });

function channel(ack: ChannelDescriptor["ack"]): ChannelDescriptor {
  return { id: pushover, title: "Pushover", dependsOn: [], uses: ["internet", "dns", "power"], breaksThrough: true, repeats: true, ack, maxTitle: 250, maxBody: 1024 };
}

describe("joinRuns and lastRun", () => {
  const variants: DrillRun[] = [run(SATURDAY), run(SATURDAY, { acked: SATURDAY + 5 * MINUTE }), run(SATURDAY, { acked: SATURDAY + 9 * MINUTE }), run(SATURDAY, { acked: SATURDAY - MINUTE })];

  it("is idempotent, commutative and associative over each set of variants", () => {
    for (const a of variants) {
      expect(joinRuns(a, a)).toEqual(a);
      for (const b of variants) {
        expect(joinRuns(a, b)).toEqual(joinRuns(b, a));
        for (const c of variants) expect(joinRuns(joinRuns(a, b), c)).toEqual(joinRuns(a, joinRuns(b, c)));
      }
    }
  });

  it("keeps the earlier acknowledgment", () => {
    expect(joinRuns(variants[1]!, variants[2]!)).toEqual(run(SATURDAY, { acked: SATURDAY + 5 * MINUTE }));
    expect(joinRuns(variants[0]!, variants[2]!)).toEqual(run(SATURDAY, { acked: SATURDAY + 9 * MINUTE }));
  });

  it("gives the run of the latest start of the drill, joined, in any order", () => {
    const runs = [run(SATURDAY - 7 * DAY, { acked: SATURDAY - 7 * DAY + MINUTE }), run(SATURDAY), { drill: "other", at: SATURDAY + DAY }, run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }), run(Number.NaN)];
    expect(lastRun(runs, WEEKLY.id)).toEqual(run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }));
    expect(lastRun([...runs].reverse(), WEEKLY.id)).toEqual(run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }));
    expect(lastRun(runs, "none")).toBeUndefined();
  });
});

describe("drillVerdict", () => {
  it("waits for the acknowledgment until the end of its time, then fails", () => {
    expect(drillVerdict(WEEKLY, run(SATURDAY), SATURDAY + 29 * MINUTE)).toEqual({ state: "pending", until: SATURDAY + 30 * MINUTE });
    expect(drillVerdict(WEEKLY, run(SATURDAY), SATURDAY + 30 * MINUTE)).toEqual({ state: "failed", why: "no-ack" });
  });

  it("passes with an acknowledgment in its time, and fails with a late one", () => {
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY + 30 * MINUTE }), SATURDAY + HOUR)).toEqual({ state: "passed", after: 30 * MINUTE });
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY - MINUTE }), SATURDAY)).toEqual({ state: "passed", after: 0 });
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY + 31 * MINUTE }), SATURDAY + HOUR)).toEqual({ state: "failed", why: "late-ack" });
  });
});

describe("nextDrillAt and drillDue", () => {
  it("starts at the next opening of the window, and at once in the window", () => {
    expect(nextDrillAt(WEEKLY, [], WEDNESDAY)).toBe(SATURDAY);
    expect(nextDrillAt(WEEKLY, [], SATURDAY + HOUR)).toBe(SATURDAY + HOUR);
    expect(drillDue(WEEKLY, [], SATURDAY + HOUR)).toBe(true);
    expect(drillDue(WEEKLY, [], WEDNESDAY)).toBe(false);
  });

  it("waits the least time after the last start, also after a run with no acknowledgment", () => {
    const last = [run(SATURDAY + 5 * MINUTE)];
    expect(nextDrillAt(WEEKLY, last, SATURDAY + HOUR)).toBe(SATURDAY + 7 * DAY);
    expect(drillDue(WEEKLY, last, SATURDAY + HOUR)).toBe(false);
    // Six days after the start is a Friday, so the drill waits for the window of the next Saturday.
    expect(nextDrillAt(WEEKLY, [run(SATURDAY + 5 * MINUTE)], SATURDAY + 6 * DAY + 10 * MINUTE)).toBe(SATURDAY + 7 * DAY);
    // A least time that ends in the window starts the drill at that time.
    const daily: DrillConfig = { ...WEEKLY, every: DAY, window: { zone: ZONE, start: "11:00", end: "17:00" } };
    expect(nextDrillAt(daily, [run(SATURDAY + 2 * HOUR)], SATURDAY + 3 * HOUR)).toBe(SATURDAY + DAY + 2 * HOUR);
  });

  it("follows the clock of the zone when daylight saving time starts", () => {
    // Daylight saving time starts in Chicago at 02:00 on Sunday 8 March 2026. Then 09:00 is 14:00 UTC, not 15:00.
    const sunday: DrillConfig = { ...WEEKLY, window: { zone: ZONE, start: "09:00", end: "10:00", days: [0] } };
    expect(nextDrillAt(sunday, [], Date.UTC(2026, 2, 7, 18))).toBe(Date.UTC(2026, 2, 8, 14));
  });

  it("does not start in the quiet window of the person", () => {
    const morning: DrillConfig = { ...WEEKLY, every: DAY, window: { zone: ZONE, start: "06:00", end: "12:00" } };
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    // 06:00 on Wednesday is in the quiet window, so the drill starts at 08:00.
    expect(nextDrillAt(morning, [], WEDNESDAY, quiet)).toBe(WEDNESDAY + 2 * HOUR);
    expect(drillDue(morning, [], WEDNESDAY, quiet)).toBe(false);
    // The quiet window ends at 13:00, before the end of the window of the drill at 14:00, so the drill starts at 13:00.
    const late: QuietWindow = { zone: ZONE, start: "22:00", end: "13:00" };
    expect(nextDrillAt({ ...morning, window: { zone: ZONE, start: "06:00", end: "14:00" } }, [], WEDNESDAY, late)).toBe(WEDNESDAY + 7 * HOUR);
  });

  it("starts only when the time of the acknowledgment ends before the next quiet window", () => {
    const evening: DrillConfig = { ...WEEKLY, every: DAY, window: { zone: ZONE, start: "21:00", end: "22:30" } };
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    // 21:00 gives 30 minutes before the quiet window at 22:00, so the drill starts at 21:00.
    expect(nextDrillAt(evening, [], WEDNESDAY, quiet)).toBe(WEDNESDAY + 15 * HOUR);
    // At 21:40, the time of the acknowledgment ends at 22:10, in the quiet window. The drill waits for 21:00 of the next day.
    expect(nextDrillAt(evening, [], WEDNESDAY + 15 * HOUR + 40 * MINUTE, quiet)).toBe(WEDNESDAY + DAY + 15 * HOUR);
    expect(drillDue(evening, [], WEDNESDAY + 15 * HOUR + 40 * MINUTE, quiet)).toBe(false);
    // The last start for this time is 21:30.
    expect(drillDue(evening, [], WEDNESDAY + 15 * HOUR + 30 * MINUTE, quiet)).toBe(true);
    expect(drillDue(evening, [], WEDNESDAY + 15 * HOUR + 31 * MINUTE, quiet)).toBe(false);
  });

  it("gives no start for a window in the quiet window, a quiet full day or a bad window", () => {
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    expect(nextDrillAt({ ...WEEKLY, window: { zone: ZONE, start: "23:00", end: "05:00" } }, [], WEDNESDAY, quiet)).toBeUndefined();
    expect(nextDrillAt(WEEKLY, [], WEDNESDAY, { zone: ZONE, start: "00:00", end: "00:00" })).toBeUndefined();
    expect(nextDrillAt({ ...WEEKLY, window: { zone: "Mars/Olympus", start: "11:00", end: "17:00" } }, [], WEDNESDAY)).toBeUndefined();
    expect(nextDrillAt({ ...WEEKLY, window: { zone: ZONE, start: "25:00", end: "17:00" } }, [], WEDNESDAY)).toBeUndefined();
    expect(nextDrillAt(WEEKLY, [], Number.NaN)).toBeUndefined();
    expect(drillDue(WEEKLY, [], Number.NaN)).toBe(false);
  });
});

describe("missedDrillAt", () => {
  const last = [run(SATURDAY)];
  const next = SATURDAY + 7 * DAY;

  it("gives the next start after the last run when its window ended with no run", () => {
    // The window of the next Saturday ends at 17:00 in Chicago. After it, the start of that Saturday is missed.
    expect(missedDrillAt(WEEKLY, last, next + 6 * HOUR)).toBe(next);
    expect(missedDrillAt(WEEKLY, last, next + 3 * DAY)).toBe(next);
    // Two weeks with no run still give the first missed start.
    expect(missedDrillAt(WEEKLY, last, next + 7 * DAY + 6 * HOUR)).toBe(next);
  });

  it("gives no missed start before the next start, at a late start in the window and before the first run", () => {
    expect(missedDrillAt(WEEKLY, last, SATURDAY + 3 * DAY)).toBeUndefined();
    expect(missedDrillAt(WEEKLY, last, next)).toBeUndefined();
    expect(missedDrillAt(WEEKLY, last, next + 2 * HOUR)).toBeUndefined();
    expect(drillDue(WEEKLY, last, next + 2 * HOUR)).toBe(true);
    expect(missedDrillAt(WEEKLY, [], next + 3 * DAY)).toBeUndefined();
    // A run at the next start ends the miss.
    expect(missedDrillAt(WEEKLY, [...last, run(next + 2 * HOUR)], next + 6 * HOUR)).toBeUndefined();
  });

  it("counts from the next start out of the quiet window of the person", () => {
    // A quiet window until 12:00 moves the next start to 12:00. The window of that start still ends at 17:00.
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "12:00" };
    expect(missedDrillAt(WEEKLY, [run(SATURDAY + HOUR)], next + 6 * HOUR, quiet)).toBe(next + HOUR);
    expect(missedDrillAt(WEEKLY, [run(SATURDAY + HOUR)], next + 30 * MINUTE, quiet)).toBeUndefined();
  });
});

describe("watchedDrillMiss and watchedDrillReportAt", () => {
  const next = SATURDAY + 7 * DAY;
  // The window of each Saturday ends at 17:00 in Chicago, 6 hours after its start.
  const end = next + 6 * HOUR;
  const watch: DrillWatch = { drill: { ...WEEKLY, copies: ["cloud"] }, copy: "cloud" };
  const read = (at: number): CopyRead => ({ at, skew: 0, sameConfig: true });
  const peer = (extra: Partial<CopyWatch> = {}): CopyWatch => ({ copy: "cloud", skewLimit: MINUTE, maxAge: 5 * MINUTE, since: SATURDAY - DAY, ...extra });

  it("gives the start after the last start of the other copy when its window ended with no start", () => {
    const copies = [peer({ read: read(SATURDAY + HOUR), drills: { [WEEKLY.id]: SATURDAY } })];
    expect(watchedDrillReportAt(watch, copies)).toBe(end + DRILL_WATCH_GRACE);
    expect(watchedDrillMiss(watch, copies, end + DRILL_WATCH_GRACE - 1)).toBeUndefined();
    expect(watchedDrillMiss(watch, copies, end + DRILL_WATCH_GRACE)).toEqual({ due: next, end, why: "unseen", last: SATURDAY, read: SATURDAY + HOUR });
    // Two weeks with no start still give the first missed start.
    expect(watchedDrillMiss(watch, copies, end + 7 * DAY)).toMatchObject({ due: next });
  });

  it("ends the miss at a start at the due time or later, also at a late start in the window", () => {
    const late = [peer({ read: read(end + HOUR), drills: { [WEEKLY.id]: next + 2 * HOUR } })];
    expect(watchedDrillMiss(watch, late, end + HOUR)).toBeUndefined();
    // The watch then waits for the start of the next week.
    expect(watchedDrillReportAt(watch, late)).toBe(end + 7 * DAY + DRILL_WATCH_GRACE);
  });

  it("counts from the start of the watch when no read gives a start", () => {
    // The watch starts on Friday. The first start is then the Saturday after it.
    const first = SATURDAY + 6 * HOUR + DRILL_WATCH_GRACE;
    expect(watchedDrillMiss(watch, [peer()], first)).toEqual({ due: SATURDAY, end: SATURDAY + 6 * HOUR, why: "unseen" });
    expect(watchedDrillMiss(watch, [peer({ read: read(first), drills: {} })], first)).toMatchObject({ why: "unseen", read: first });
  });

  it("tells that it cannot read when the copy answers with no starts of drills", () => {
    const old = [peer({ read: read(end + HOUR) })];
    expect(watchedDrillMiss(watch, old, end + HOUR)).toMatchObject({ due: SATURDAY, why: "no-read" });
    // An answer before the end of the window does not tell that the copy cannot give the start.
    expect(watchedDrillMiss(watch, [peer({ read: read(SATURDAY - HOUR) })], end + HOUR)).toMatchObject({ why: "unseen" });
  });

  it("keeps the start of an open line over a restart of this copy", () => {
    // After a restart, the watch starts again on Sunday, and with no start in the reads it waits for the next Saturday.
    const restarted = [peer({ since: next + DAY })];
    expect(watchedDrillMiss(watch, restarted, next + DAY + HOUR)).toBeUndefined();
    expect(watchedDrillMiss(watch, restarted, next + DAY + HOUR, next)).toMatchObject({ due: next, end });
    // A start before the held start does not end the line. A start at the held start or later ends it.
    expect(watchedDrillMiss(watch, [peer({ drills: { [WEEKLY.id]: SATURDAY } })], next + 7 * DAY + 7 * HOUR, next)).toMatchObject({ due: next });
    expect(watchedDrillMiss(watch, [peer({ drills: { [WEEKLY.id]: next + 7 * DAY } })], next + 7 * DAY + 7 * HOUR, next)).toBeUndefined();
  });

  it("counts from the next start out of the quiet window of the person", () => {
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "12:00" };
    const copies = [peer({ drills: { [WEEKLY.id]: SATURDAY + HOUR } })];
    expect(watchedDrillMiss({ ...watch, quiet }, copies, end + DRILL_WATCH_GRACE)).toMatchObject({ due: next + HOUR, end });
  });

  it("reads each peer for a drill of the copy of rank 0, and only the named copy for a drill with a list", () => {
    const copies = [peer({ copy: "b", read: read(end + HOUR), drills: {} }), peer({ copy: "c", read: read(end + HOUR), drills: { [WEEKLY.id]: next + HOUR } })];
    expect(watchedDrillMiss({ drill: WEEKLY }, copies, end + HOUR)).toBeUndefined();
    expect(watchedDrillMiss({ drill: WEEKLY, copy: "b" }, copies, end + HOUR)).toMatchObject({ due: SATURDAY, why: "unseen" });
    // A watch of a copy that is not a peer has no read, and it waits for no start.
    expect(watchedDrillMiss({ drill: WEEKLY, copy: "d" }, copies, end + HOUR)).toBeUndefined();
    expect(watchedDrillReportAt({ drill: WEEKLY, copy: "d" }, copies)).toBeUndefined();
  });
});

describe("drillInCopy", () => {
  it("starts a drill only in the copy of rank 0, or in each copy of its list", () => {
    expect(drillInCopy(WEEKLY, "home", 0)).toBe(true);
    expect(drillInCopy(WEEKLY, "cloud", 1)).toBe(false);
    const both: DrillConfig = { ...WEEKLY, copies: ["home", "cloud"] };
    expect(drillInCopy(both, "cloud", 1)).toBe(true);
    expect(drillInCopy({ ...WEEKLY, copies: ["cloud"] }, "home", 0)).toBe(false);
    expect(drillInCopy({ ...WEEKLY, copies: [] }, "home", 0)).toBe(false);
  });
});

describe("drillProblems", () => {
  it("finds no problem in a good drill", () => {
    expect(drillProblems(WEEKLY, [channel("poll")])).toEqual([]);
  });

  it("finds a drill with no start out of the quiet window of the person, and a near drill is good", () => {
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    const late = "The drill push-weekly has no start in the weeks from 2026-01-05 and 2026-07-06: each time of its window is in the quiet window of the person, or too near to it.";
    // A window in the quiet window has no start.
    expect(drillProblems({ ...WEEKLY, window: { zone: ZONE, start: "23:00", end: "05:00", days: [6] } }, [channel("poll")], quiet)).toEqual([late]);
    // The time of the acknowledgment of each start ends in the quiet window.
    expect(drillProblems({ ...WEEKLY, window: { zone: ZONE, start: "21:45", end: "22:00", days: [6] } }, [channel("poll")], quiet)).toEqual([late]);
    // A start at 21:30 or before gives the full time of the acknowledgment. The flips are good drills.
    expect(drillProblems({ ...WEEKLY, window: { zone: ZONE, start: "21:30", end: "22:00", days: [6] } }, [channel("poll")], quiet)).toEqual([]);
    expect(drillProblems({ ...WEEKLY, window: { zone: ZONE, start: "21:45", end: "22:00", days: [6] } }, [channel("poll")])).toEqual([]);
    expect(drillProblems({ ...WEEKLY, ackWithin: 15 * MINUTE, window: { zone: ZONE, start: "21:45", end: "22:00", days: [6] } }, [channel("poll")], quiet)).toEqual([]);
  });

  it("finds a drill with a start in one season only, when the window and the quiet window have two zones", () => {
    // The quiet window starts at 22:00 in New York: 03:00 UTC in January, and 02:00 UTC in July.
    const quiet: QuietWindow = { zone: "America/New_York", start: "22:00", end: "08:00" };
    const utc = (start: string, end: string): DrillConfig => ({ ...WEEKLY, window: { zone: "UTC", start, end, days: [6] } });
    expect(drillProblems(utc("02:00", "02:30"), [channel("poll")], quiet)).toEqual([
      "The drill push-weekly has no start in the weeks from 2026-07-06: each time of its window is in the quiet window of the person, or too near to it.",
    ]);
    // The flip: a window from 01:00 UTC ends its time of the acknowledgment before 02:00 UTC.
    expect(drillProblems(utc("01:00", "01:30"), [channel("poll")], quiet)).toEqual([]);
  });

  it("finds an empty list of copies and a copy that the list names two times", () => {
    expect(drillProblems({ ...WEEKLY, copies: [] }, [channel("poll")])).toEqual(["The drill push-weekly has an empty list of copies. No copy starts it."]);
    expect(drillProblems({ ...WEEKLY, copies: ["home", "cloud", "home"] }, [channel("poll")])).toEqual(["The drill push-weekly names the copy home two times."]);
    expect(drillProblems({ ...WEEKLY, copies: ["home"] }, [channel("poll")])).toEqual([]);
  });

  it("finds bad times, a bad window, an unknown channel and a channel with no acknowledgment", () => {
    expect(drillProblems({ ...WEEKLY, ackWithin: 0, every: Number.NaN, window: { zone: "Mars/Olympus", start: "11:00", end: "17:00" } }, [])).toEqual([
      "The drill push-weekly has the time of the acknowledgment 0. It is a finite number above 0.",
      "The drill push-weekly has the least time between two starts NaN. It is above the time of the acknowledgment.",
      expect.stringMatching(/^The drill push-weekly: the window: /u),
      "The drill push-weekly uses the channel pushover, and the instance has no such channel.",
    ]);
    expect(drillProblems({ ...WEEKLY, every: 30 * MINUTE }, [channel("none")])).toEqual([
      "The drill push-weekly has the least time between two starts 1800000. It is above the time of the acknowledgment.",
      "The drill push-weekly uses the channel pushover, and the channel does not tell of an acknowledgment. The drill cannot pass.",
    ]);
  });
});
