import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  DRILL_SUBJECT,
  DRILL_WATCH_GRACE,
  EMPTY_STATE,
  NO_SYSTEM_LINES,
  drillRules,
  systemReports,
  type Acknowledgment,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type CopyWatch,
  type DeliveryStatus,
  type DrillConfig,
  type DrillWatch,
  type EscalationPolicy,
  type Message,
  type PersonId,
  type PlaceId,
  type QuietWindow,
  type Recipient,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { copyDrills, drillRunOf, drillStarts, drillStep, watchedDrills, type CopyDrill } from "./drills.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type CopyChecks, type RuntimeOptions } from "./runtime.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PUSHOVER = "pushover" as ChannelId;
const SMS = "sms" as ChannelId;
const PERSON = "person-1" as PersonId;
const COPY = "home";

// Saturday 4 April 2026, 12:00 in Chicago (17:00 UTC): in the window of the drill.
const T0 = Date.UTC(2026, 3, 4, 17, 0, 0);
const WINDOW = { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] };
const QUIET: QuietWindow = { zone: "America/Chicago", start: "22:00", end: "08:00" };
const DRILL: DrillConfig = { id: "push-weekly", person: PERSON, path: { kind: "channel", channel: PUSHOVER }, every: 6 * DAY, window: WINDOW, ackWithin: 30 * MINUTE };
const OWN: readonly CopyDrill[] = [{ drill: DRILL, quiet: QUIET }];

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: PUSHOVER, at: 0 },
    { channel: SMS, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
// The failure of a drill goes at the level notice, on each channel other than the path.
const NOTICE: EscalationPolicy = { level: "notice", steps: [{ channel: SMS, at: 0 }], exhaustedAfter: 10 * MINUTE };
// The person of the drill, with the rules that `loadConfig` gives.
const RECIPIENT: Recipient = {
  watch: { person: PERSON, places: [], rules: [], subjects: [{ system: DRILL_SUBJECT }], quiet: QUIET },
  policies: [LIFE_SAFETY, NOTICE],
  addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } },
  channelRules: drillRules(DRILL),
};

// A public place in Kansas: Sedgwick County KS. No drill has a place.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

// The run report of the drill at T0, from the system fold of the core.
const RUN = systemReports(NO_SYSTEM_LINES, { sources: [], health: [], coverage: [], threats: [], drills: [{ copy: COPY, drill: DRILL, run: { drill: DRILL.id, at: T0 } }] }, T0).reports[0]!;

function ack(fields: Partial<Acknowledgment> = {}): Acknowledgment {
  return { incident: RUN.id, level: "life-safety", person: PERSON, at: T0 + 5 * MINUTE, via: PUSHOVER, ...fields };
}

describe("the drills of a copy (AL-43)", () => {
  it("gives the drills of the copy, each with the quiet window of its person", () => {
    const cloud: DrillConfig = { ...DRILL, id: "cloud-weekly", copies: ["cloud"] };
    expect(copyDrills([DRILL, cloud], [RECIPIENT], COPY, 0)).toEqual([{ drill: DRILL, quiet: QUIET }]);
    // Without a list of copies, only the copy of rank 0 starts a drill. The list names each copy that starts it.
    expect(copyDrills([DRILL, cloud], [RECIPIENT], "cloud", 1)).toEqual([{ drill: cloud, quiet: QUIET }]);
    expect(copyDrills([DRILL], [], COPY, 0)).toEqual([{ drill: DRILL }]);
  });

  it("watches each drill that another copy starts, with the quiet window of its person", () => {
    const cloud: DrillConfig = { ...DRILL, id: "cloud-weekly", copies: ["cloud"] };
    const both: DrillConfig = { ...DRILL, id: "both-weekly", copies: [COPY, "cloud", "third"] };
    // The copy of rank 0 starts the drill with no list, thus it watches only the drills of the lists.
    expect(watchedDrills([DRILL, cloud, both], [RECIPIENT], COPY, 0)).toEqual([
      { drill: cloud, quiet: QUIET, copy: "cloud" },
      { drill: both, quiet: QUIET, copy: "cloud" },
      { drill: both, quiet: QUIET, copy: "third" },
    ]);
    // A copy of another rank watches the drill with no list, with no copy in the watch.
    expect(watchedDrills([DRILL, cloud], [], "cloud", 1)).toEqual([{ drill: DRILL }]);
  });

  it("counts only the first acknowledgment of the person on the path, of a run report after the start", () => {
    const state = (acks: readonly Acknowledgment[], drills: Readonly<Record<string, number>> = { [DRILL.id]: T0 }) => ({ drills, merge: { ...EMPTY_STATE, reports: [RUN], acks } });
    expect(drillRunOf(state([]), COPY, DRILL)).toEqual({ drill: DRILL.id, at: T0 });
    expect(drillRunOf(state([ack({ at: T0 + 9 * MINUTE }), ack()]), COPY, DRILL)).toEqual({ drill: DRILL.id, at: T0, acked: T0 + 5 * MINUTE });
    // An acknowledgment in the user interface, on another channel, of another person or of another incident tests no path.
    for (const other of [ack({ via: "ui" }), ack({ via: SMS }), ack({ person: "person-2" as PersonId }), ack({ incident: "f".repeat(64) as Acknowledgment["incident"] })]) {
      expect(drillRunOf(state([other]), COPY, DRILL)?.acked).toBeUndefined();
    }
    // The run of another copy, and a run report before the last start, are not of this run.
    expect(drillRunOf(state([ack()]), "cloud", DRILL)?.acked).toBeUndefined();
    expect(drillRunOf(state([ack()], { [DRILL.id]: T0 + MINUTE }), COPY, DRILL)?.acked).toBeUndefined();
    expect(drillRunOf(state([ack()], {}), COPY, DRILL)).toBeUndefined();
  });

  it("starts a drill in its window, and not again before the time every", () => {
    const empty = { drills: {}, steps: [] };
    expect(drillStarts(empty, OWN, COPY, T0)).toEqual([{ id: `drill:${COPY}:${DRILL.id}:${String(T0)}`, at: new Date(T0).toISOString(), type: "drill", time: T0, drill: DRILL.id, copy: COPY }]);
    // Out of the window, no drill starts. After a start, the next start is in the window of the next week.
    expect(drillStarts(empty, OWN, COPY, T0 + 6 * 60 * MINUTE)).toEqual([]);
    expect(drillStarts({ drills: { [DRILL.id]: T0 }, steps: [] }, OWN, COPY, T0 + MINUTE)).toEqual([]);
    expect(drillStarts({ drills: { [DRILL.id]: T0 }, steps: [] }, OWN, COPY, T0 + 7 * DAY).map((event) => event.drill)).toEqual([DRILL.id]);
    // After a step of the wall clock, the id has the frame tag. Thus a time that comes again gives a new id.
    expect(drillStarts({ drills: {}, steps: [{ at: T0, size: -MINUTE }] }, OWN, COPY, T0)[0]?.id).toBe(`drill:${COPY}:${DRILL.id}:${String(T0)}~1`);
  });

  it("wakes at the end of the time of the acknowledgment and at the next start, and tells of a drill with no start", () => {
    const merge = { ...EMPTY_STATE, reports: [RUN] };
    const waiting = drillStep({ drills: { [DRILL.id]: T0 }, merge }, OWN, COPY, T0 + MINUTE);
    expect(waiting.snapshots).toEqual([{ copy: COPY, drill: DRILL, run: { drill: DRILL.id, at: T0 } }]);
    expect(waiting.wakeAt).toBe(T0 + DRILL.ackWithin);
    // After the acknowledgment, the next start of the next week is the wake.
    const passed = drillStep({ drills: { [DRILL.id]: T0 }, merge: { ...merge, acks: [ack()] } }, OWN, COPY, T0 + 6 * MINUTE);
    expect(passed.wakeAt).toBe(Date.UTC(2026, 3, 11, 16, 0, 0));
    // A window in the quiet window has no start.
    const late = { ...DRILL, window: { ...WINDOW, start: "22:30", end: "23:30" } };
    expect(drillStep({ drills: {}, merge }, [{ drill: late, quiet: QUIET }], COPY, T0)).toEqual({ snapshots: [{ copy: COPY, drill: late, noStart: true }] });
  });

  it("tells of the start that the copy missed after its last run, until the next run", () => {
    const merge = { ...EMPTY_STATE, reports: [RUN], acks: [ack()] };
    const due = Date.UTC(2026, 3, 11, 16, 0, 0);
    // The window of Saturday 11 April ends at 17:00 in Chicago. In the window, the drill is due, and it is not missed.
    expect(drillStep({ drills: { [DRILL.id]: T0 }, merge }, OWN, COPY, due + 60 * MINUTE).snapshots[0]?.missed).toBeUndefined();
    const after = drillStep({ drills: { [DRILL.id]: T0 }, merge }, OWN, COPY, Date.UTC(2026, 3, 11, 22, 30, 0));
    expect(after.snapshots[0]?.missed).toBe(due);
    expect(after.wakeAt).toBe(Date.UTC(2026, 3, 18, 16, 0, 0));
    // Before the first run, the copy has no time from which to count.
    expect(drillStep({ drills: {}, merge }, OWN, COPY, Date.UTC(2026, 3, 11, 22, 30, 0)).snapshots[0]?.missed).toBeUndefined();
  });
});

interface Calls {
  readonly send: Message[];
}

function channel(id: ChannelId, ack: ChannelDescriptor["ack"], now: () => number, status?: () => DeliveryStatus): { readonly procedures: ChannelProcedures; readonly calls: Calls } {
  const calls: Calls = { send: [] };
  const procedures: ChannelProcedures = {
    describe: () => ({ id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 }),
    send: async ({ message }) => {
      calls.send.push(message);
      return { ok: true, receipt: { receipt: `${id}-${calls.send.length}` }, accepted: now() };
    },
    status: async () => status?.() ?? { state: "delivered", at: now() },
    cancel: async () => {},
  };
  return { procedures, calls };
}

function open(options: { readonly status?: () => DeliveryStatus; readonly drills?: readonly CopyDrill[]; readonly copies?: CopyChecks; readonly drillWatches?: readonly DrillWatch[]; readonly log?: RuntimeLog; readonly clock?: ReturnType<typeof fakeWallClock> } = {}) {
  const clock = options.clock ?? fakeWallClock(T0);
  const log = options.log ?? openRuntimeLog(":memory:");
  const pushover = channel(PUSHOVER, "poll", () => clock.now(), options.status);
  const sms = channel(SMS, "none", () => clock.now());
  const runtime = openRuntime({
    log,
    clock,
    sources: [],
    watch: () => ({ places: [KANSAS], kinds: ["met"] }),
    view: VIEW,
    run: `run-${clock.now()}`,
    copy: COPY,
    delivery: { recipients: [RECIPIENT], channels: [pushover.procedures, sms.procedures], pollEvery: 30 * SECOND, retry: 15 * SECOND, callLimit: 10 * SECOND, flightLimit: 40 * SECOND },
    drills: options.drills ?? OWN,
    ...(options.copies === undefined ? {} : { copies: options.copies }),
    ...(options.drillWatches === undefined ? {} : { drillWatches: options.drillWatches }),
  });
  return { clock, log, runtime, pushover: pushover.calls, sms: sms.calls };
}

// The open lines of the drills. The view of the test has a place with no source, thus a coverage line is open too.
const drillLines = (lines: { readonly open: Readonly<Record<string, unknown>> }) => Object.keys(lines.open).filter((line) => line.startsWith("drill/"));
const drillEvents = (log: RuntimeLog) => [...log.read()].filter((event) => event.type === "drill").map((event) => event.id);

describe("the drills in the passes of the runtime (AL-43)", () => {
  it("starts a due drill, sends the run only on its path, and passes it with an acknowledgment on the path", async () => {
    const { clock, log, runtime, pushover, sms } = open({ status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }) });
    const first = await runtime.pass();
    expect(drillEvents(log)).toEqual([`drill:${COPY}:${DRILL.id}:${String(T0)}`]);
    expect(pushover.send.map((message) => message.title)).toEqual([RUN.headline]);
    expect(first.wakeAt).toBeDefined();
    // The poll gives the acknowledgment, and the next pass ends the run line. The step on sms of the policy does not go.
    await clock.advance(30 * SECOND);
    await runtime.pass();
    await clock.advance(SECOND);
    await runtime.pass();
    expect(drillRunOf(runtime.state(), COPY, DRILL)?.acked).toBe(T0 + 20 * SECOND);
    expect(drillLines(runtime.state().lines)).toEqual([]);
    await clock.advance(10 * MINUTE);
    await runtime.pass();
    expect(sms.send).toEqual([]);
    expect(pushover.send.length).toBe(1);
    // A restart reads the start from the log, thus the drill does not start again in its window.
    await clock.advance(MINUTE);
    const again = open({ log, clock });
    await again.runtime.pass();
    expect(drillEvents(log).length).toBe(1);
    expect(again.pushover.send).toEqual([]);
    log.close();
  });

  it("keeps a passed run passed after the retirement of old incidents, and sends no failure (AL-187)", async () => {
    // On a live copy, the retirement one day after the escalation start removed the acknowledgment of a passed run. Then
    // the verdict gave no-ack, and the failure called the person.
    const { clock, log, runtime, pushover, sms } = open({ status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }) });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    await runtime.pass();
    await clock.advance(SECOND);
    await runtime.pass();
    expect(drillRunOf(runtime.state(), COPY, DRILL)?.acked).toBe(T0 + 20 * SECOND);
    for (let hour = 0; hour < 48; hour += 1) {
      await clock.advance(HOUR);
      await runtime.pass();
    }
    expect(runtime.state().retiredAt).toBeGreaterThan(T0 + DAY);
    expect(drillRunOf(runtime.state(), COPY, DRILL)?.acked).toBe(T0 + 20 * SECOND);
    expect(drillLines(runtime.state().lines)).toEqual([]);
    expect(sms.send).toEqual([]);
    expect(pushover.send.length).toBe(1);
    log.close();
  });

  it("passes two runs in sequence, each with its own send and its own acknowledgment on the path", async () => {
    // Each run is its own incident. A link rule that joins the runs gives the second run no send, and this test fails.
    const clock = fakeWallClock(T0);
    const { log, runtime, pushover, sms } = open({ clock, status: () => ({ state: "acknowledged", at: clock.now() }) });
    const second = Date.UTC(2026, 3, 11, 16, 0, 0);
    for (const start of [T0, second]) {
      await clock.advance(start - clock.now());
      await runtime.pass();
      await clock.advance(30 * SECOND);
      await runtime.pass();
      await clock.advance(SECOND);
      await runtime.pass();
      expect(drillRunOf(runtime.state(), COPY, DRILL)).toEqual({ drill: DRILL.id, at: start, acked: start + 30 * SECOND });
      expect(drillLines(runtime.state().lines)).toEqual([]);
    }
    expect(drillEvents(log)).toEqual([T0, second].map((start) => `drill:${COPY}:${DRILL.id}:${String(start)}`));
    expect(pushover.send.map((message) => message.title)).toEqual([RUN.headline, RUN.headline]);
    // After the time of the acknowledgment of the second run, no failure goes.
    await clock.advance(DRILL.ackWithin);
    await runtime.pass();
    expect(drillLines(runtime.state().lines)).toEqual([]);
    expect(sms.send).toEqual([]);
    log.close();
  });

  it("sends a failure on each channel other than the path when no acknowledgment comes", async () => {
    const { clock, log, runtime, pushover, sms } = open();
    await runtime.pass();
    await clock.advance(5 * MINUTE);
    await runtime.pass();
    // The step on sms of the life-safety policy does not go for a run.
    expect(sms.send).toEqual([]);
    await clock.advance(DRILL.ackWithin - 5 * MINUTE);
    const end = await runtime.pass();
    expect(drillLines(end.view.step.lines)).toEqual([`drill/${COPY}/${DRILL.id}/failed`]);
    expect(sms.send.map((message) => message.title)).toEqual(["The drill push-weekly failed: no acknowledgment came."]);
    expect(pushover.send.length).toBe(1);
    log.close();
  });

  it("sends a failure with the reason no-start for a drill with no start, and starts nothing", async () => {
    const late = { ...DRILL, window: { ...WINDOW, start: "22:30", end: "23:30" } };
    const { log, runtime, pushover, sms } = open({ drills: [{ drill: late, quiet: QUIET }] });
    await runtime.pass();
    expect(drillEvents(log)).toEqual([]);
    expect(pushover.send).toEqual([]);
    expect(sms.send.map((message) => message.title)).toEqual(["The drill push-weekly has no next start."]);
    log.close();
  });

  it("sends a failure for a start that the copy missed while it was stopped, and ends it at the next run", async () => {
    const { clock, log, runtime } = open({ status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }) });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    await runtime.pass();
    // The copy stops for the full window of Saturday 11 April, and it starts again after the window.
    await clock.advance(Date.UTC(2026, 3, 11, 22, 30, 0) - clock.now());
    const back = open({ log, clock });
    await back.runtime.pass();
    expect(drillLines(back.runtime.state().lines)).toEqual([`drill/${COPY}/${DRILL.id}/missed`]);
    expect(back.sms.send.map((message) => message.title)).toEqual(["The drill push-weekly did not start at its time."]);
    expect(back.pushover.send).toEqual([]);
    // The next run starts in the window of the next week. It ends the failure, and its run line opens.
    await clock.advance(Date.UTC(2026, 3, 18, 16, 0, 0) - clock.now());
    await back.runtime.pass();
    expect(drillEvents(log).length).toBe(2);
    expect(drillLines(back.runtime.state().lines)).toEqual([`drill/${COPY}/${DRILL.id}`]);
    expect(back.pushover.send.map((message) => message.title)).toEqual([RUN.headline]);
    log.close();
  });

  it("tells of a start of a drill of another copy that did not come, and wakes at its time", async () => {
    const HOUR = 60 * MINUTE;
    const cloud: DrillConfig = { ...DRILL, id: "cloud-weekly", copies: ["cloud"] };
    const clock = fakeWallClock(T0);
    // The other copy answers each read, and its last start of the drill is one week before.
    const copies: CopyChecks = {
      watches: (): readonly CopyWatch[] => [{ copy: "cloud", skewLimit: MINUTE, maxAge: 5 * MINUTE, since: T0 - DAY, read: { at: clock.now(), skew: 0, sameConfig: true }, drills: { [cloud.id]: T0 - 7 * DAY } }],
      shift: () => {},
      ready: async () => {},
    };
    const { runtime } = open({ clock, drills: [], copies, drillWatches: watchedDrills([cloud], [RECIPIENT], COPY, 0) });
    // The due start is Saturday 11:00 in Chicago, one hour before T0. Its window ends at 17:00.
    const missAt = T0 + 5 * HOUR + DRILL_WATCH_GRACE;
    const watchLines = () => Object.keys(runtime.state().lines.open).filter((line) => line.startsWith("drill-watch/"));
    const first = await runtime.pass();
    expect(watchLines()).toEqual([]);
    expect(first.wakeAt).toBeLessThanOrEqual(missAt);
    await clock.advance(missAt - 1 - T0);
    await runtime.pass();
    expect(watchLines()).toEqual([]);
    await clock.advance(1);
    await runtime.pass();
    expect(watchLines()).toEqual(["drill-watch/cloud/cloud-weekly"]);
  });

  it("ends the open lines of a drill that leaves the configuration", async () => {
    const { clock, log, runtime } = open();
    await runtime.pass();
    expect(drillLines(runtime.state().lines)).toEqual([`drill/${COPY}/${DRILL.id}`]);
    await clock.advance(MINUTE);
    const gone = open({ log, clock, drills: [] });
    await gone.runtime.pass();
    expect(drillLines(gone.runtime.state().lines)).toEqual([]);
    log.close();
  });
});
