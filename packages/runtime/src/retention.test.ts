import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  DEFAULT_LINK_POLICY,
  downChannels,
  drillVerdict,
  exhaustions,
  heldPersons,
  incidents,
  limitRoutes,
  linkRule,
  OBSERVE_WINDOW,
  QUIET_HORIZON,
  RETENTION_HORIZON,
  reportId,
  route,
  SEND_LIMIT_MAX_WINDOW,
  SYSTEM_SOURCE,
  THROTTLE_MAX_WINDOW,
  throttleRoutes,
  TOMBSTONE_LIFE,
  type ChannelDescriptor,
  type ChannelId,
  type Delivery,
  type DrillConfig,
  type Level,
  type Observation,
  type ObservationId,
  type PersonId,
  type PlaceId,
  type Recipient,
  type Report,
  type ReportId,
  type Route,
  type SendLimits,
  type SourceId,
  type SourceProcedures,
  type Throttle,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { drillRunOf } from "./drills.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, sharedItem } from "./exchange.ts";
import { openRuntimeLog } from "./log.ts";
import { cutIncidents, observeStep, type ObserveParts } from "./observe.ts";
import { ENTRY_KEEP, quietKeeps, retention, retiredEvent, RETIRE_EVERY } from "./retention.ts";
import { openRuntime } from "./runtime.ts";
import { cancelledKeys, EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person-1" as PersonId;
const CONTEXT: FoldContext = { sources: [] };
/** The context of a fold that retires on the cadence of the event time, with the defaults of the retention (AL-109). */
const RETAIN: FoldContext = { sources: [], retention: {} };
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
/** A person who watches the place in Kansas, with one push for a life-safety warning. The address is fake. */
const RECIPIENT: Recipient = {
  watch: { person: PERSON, places: [KANSAS.id], rules: [] },
  policies: [{ level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 20 * MINUTE }],
  addresses: { pushover: { user: "fake-user" } },
};
/** A push channel that the escalation polls for an acknowledgment. */
const POLLED: ChannelDescriptor = { id: PUSHOVER, title: "Pushover", dependsOn: ["provider:pushover"], uses: ["internet", "power"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 250, maxBody: 1024 };
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

/** One tornado warning for a county of Kansas, sent at `sent`, that a copy received at `received`. `part` changes its fields. */
function report(key: string, received: number, sent = T0, part: Partial<Report> = {}): Report {
  return {
    id: reportId({ source: API, key, sent }),
    source: API,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent,
    received,
    expires: sent + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
    ...part,
  };
}

const W1 = report("w1", T0).id;
const W2 = report("w2", T0).id;

const delivery = (key: string, incident: ReportId, at: number): Delivery => ({ key, incident, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at });
const started = (run: string, time: number): RuntimeEvent => ({ ...envelope("started", `started:${run}`, time), run });
const fetched = (id: string, time: number, reports: readonly Report[]): RuntimeEvent => ({
  ...envelope("fetch", id, time),
  record: { source: API, at: time, took: 100, fresh: reports.length, fatal: 0 },
  reports,
  problems: [],
});
const delivered = (key: string, incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("delivery", `delivery:${key}`, time), delivery: delivery(key, incident, time) });
const cancelled = (key: string, time: number): RuntimeEvent => ({ ...envelope("cancelled", `cancelled:${key}`, time), delivery: key });
const escalation = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation", `escalation:${incident}`, time), start: { incident, level: "life-safety", person: PERSON, at: time } });
const endOf = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation-end", `escalation-end:${incident}:${PERSON}:0`, time), end: { incident, person: PERSON, at: time } });
const ended = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("ended", `ended:${API}:${time}`, time), source: API, reports });
const stepped = (n: number, time: number, size: number): RuntimeEvent => ({ ...envelope("clock", `clock:${n}`, time), size });
const retired = (time: number, reports: readonly ReportId[], until: number, keys: readonly string[] = []): RuntimeEvent => ({
  ...envelope("retired", `retired:${time}`, time),
  reports: [...reports].sort(),
  until,
  cancelled: [...keys].sort(),
});

/** The import of a shared event of the copy `b`. */
function imported(event: RuntimeEvent): RuntimeEvent {
  const item = sharedItem(event, "b");
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return importOf(item);
}

const foldAll = (events: readonly RuntimeEvent[]): RuntimeState => events.reduce((state, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME);
const ids = (reports: readonly { readonly id: ReportId }[]): ReportId[] => reports.map((one) => one.id).sort();

// Each part of a report with a live tombstone of the own side is out of each merge state, and the imported side has no tombstone.
function expectNoRetiredPart(state: RuntimeState): void {
  const gone = new Set(state.own.merge.retired.map((tombstone) => tombstone.report));
  for (const merge of [state.merge, state.own.merge, state.imported.merge]) {
    expect(merge.reports.filter((one) => gone.has(one.id))).toEqual([]);
    expect(merge.deliveries.filter((one) => gone.has(one.incident))).toEqual([]);
    expect(merge.acks.filter((one) => gone.has(one.incident))).toEqual([]);
    expect(merge.ends.filter((one) => gone.has(one.report))).toEqual([]);
  }
  expect(state.imported.merge.retired).toEqual([]);
  // A key with a live tombstone is not a cancel of the state.
  const keys = new Set(state.cancelTombstones.map((tombstone) => tombstone.key));
  expect(state.cancelled.filter((key) => keys.has(key))).toEqual([]);
  // Each time of entry is the time of a key of cancelled.
  expect(Object.keys(state.cancelledSince).filter((key) => !state.cancelled.includes(key))).toEqual([]);
}

describe("the fold of a retirement (AL-47)", () => {
  const until = T0 + 8 * DAY + TOMBSTONE_LIFE;
  const events: RuntimeEvent[] = [
    started("run-a", T0),
    fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
    imported(fetched("fetch:1", T0 + 2 * SECOND, [report("w1", T0 + 2 * SECOND), report("w2", T0 + 2 * SECOND)])),
    escalation(W1, T0 + 3 * SECOND),
    delivered("k1", W1, T0 + 3 * SECOND),
    imported(delivered("k2", W2, T0 + 4 * SECOND)),
    cancelled("k1", T0 + 5 * SECOND),
    endOf(W1, T0 + 6 * SECOND),
    imported(endOf(W2, T0 + 7 * SECOND)),
    stepped(1, T0 + 8 * SECOND + 5 * MINUTE, 5 * MINUTE),
    retired(T0 + 8 * DAY, [W1], until, ["k1"]),
    // A late copy of each part of the retired incident: a fetch of this copy, and the shared events of the other copy.
    fetched("fetch:2", T0 + 8 * DAY + HOUR, [report("w1", T0 + 8 * DAY + HOUR)]),
    imported(fetched("fetch:2", T0 + 8 * DAY + HOUR, [report("w1", T0 + 8 * DAY + HOUR)])),
    imported(delivered("k3", W1, T0 + 8 * DAY + HOUR)),
    imported(ended(T0 + 8 * DAY + HOUR, [W1])),
    imported(endOf(W1, T0 + 8 * DAY + 2 * HOUR)),
    // The second retirement drops the first tombstone, because its time is after the end of the tombstone.
    retired(until + HOUR, [W2], until + HOUR + TOMBSTONE_LIFE),
    fetched("fetch:3", until + 2 * HOUR, [report("w1", until + 2 * HOUR)]),
  ];
  const at = (count: number): RuntimeState => foldAll(events.slice(0, count));
  const firstRetirement = events.findIndex((event) => event.type === "retired") + 1;

  it("gives the state of the rebuild after each event", () => {
    for (let count = 1; count <= events.length; count += 1) expect(at(count)).toEqual(rebuild(events.slice(0, count), CONTEXT));
  });

  it("removes each part of the retired incident from each side, and keeps the other incident", () => {
    const state = at(firstRetirement);
    expect(ids(state.merge.reports)).toEqual([W2]);
    expect(state.own.merge.reports).toEqual([]);
    expect(ids(state.imported.merge.reports)).toEqual([W2]);
    expect(state.merge.deliveries.map((one) => one.key)).toEqual(["k2"]);
    expect(state.own.merge.retired).toEqual([{ report: W1, until }]);
    expectNoRetiredPart(state);
  });

  it("drops the escalation starts, the escalation ends and the cancelled keys of the retired incident", () => {
    const before = at(firstRetirement - 1);
    expect(before.starts.map((start) => start.incident)).toEqual([W1]);
    expect(before.cancelled).toEqual(["k1"]);
    const state = at(firstRetirement);
    expect(state.starts).toEqual([]);
    expect(state.cancelled).toEqual([]);
    expect(state.escalationEnds.map((end) => end.incident)).toEqual([W2]);
  });

  it("keeps a late copy of a retired report out, from this copy and by import from the other copy", () => {
    const state = at(firstRetirement + 5);
    expect(ids(state.merge.reports)).toEqual([W2]);
    expect(state.merge.deliveries.map((one) => one.key)).toEqual(["k2"]);
    expect(state.merge.ends).toEqual([]);
    expect(state.escalationEnds.map((end) => end.incident)).toEqual([W2]);
    expectNoRetiredPart(state);
  });

  it("drops a tombstone at a later retirement after its end, and then a new copy of the report comes back", () => {
    const pruned = at(events.length - 1);
    expect(pruned.own.merge.retired).toEqual([{ report: W2, until: until + HOUR + TOMBSTONE_LIFE }]);
    expect(pruned.merge.reports).toEqual([]);
    const state = at(events.length);
    expect(ids(state.merge.reports)).toEqual([W1]);
  });

  it("keeps an old cancel of a retired incident out after a recovery and a new read of the other copy, until the next retirement", () => {
    // The recovery sets each read position to 0. Thus the next read imports each old event of the other copy again.
    const recovery: RuntimeEvent = { ...envelope("recovered", "recovered:q-1", T0 + 8 * DAY + HOUR), quarantine: "q-1", fault: "corrupt", read: 9, added: 9, lost: 0, whole: true, problems: [] };
    const again = [recovery, imported(cancelled("k1", T0 + 5 * SECOND)), imported(cancelled("k9", T0 + 5 * SECOND)), cancelled("k1", T0 + 8 * DAY + 2 * HOUR)];
    const log = [...events.slice(0, firstRetirement), ...again];
    const state = foldAll(log);
    expect(state.cancelTombstones).toEqual([{ key: "k1", until }]);
    expect(state.cancelled).toEqual(["k9"]);
    expect(rebuild(log, CONTEXT)).toEqual(state);
    // The retirement after the end drops the key tombstone, as it drops the tombstone of the report. Then the key can come back.
    const later = foldAll([...log, retired(until + HOUR, [W2], until + HOUR + TOMBSTONE_LIFE), imported(cancelled("k1", T0 + 5 * SECOND))]);
    expect(later.cancelTombstones).toEqual([]);
    expect(later.cancelled).toEqual(["k1", "k9"]);
  });

  it("gives each cancelled key its own time of entry, and a step of the clock moves it", () => {
    // The cancel of k1 is at T0 + 5 s. The step of 5 minutes after it moves its time of entry.
    expect(at(firstRetirement - 1).cancelledSince).toEqual({ k1: T0 + 5 * SECOND + 5 * MINUTE });
    expect(at(firstRetirement).cancelledSince).toEqual({});
  });

  it("moves each tombstone at a step of the clock, as each own instant", () => {
    const state = foldAll([...events.slice(0, firstRetirement), stepped(2, T0 + 9 * DAY, -2 * MINUTE)]);
    expect(state.own.merge.retired).toEqual([{ report: W1, until: until - 2 * MINUTE }]);
    expect(state.cancelTombstones).toEqual([{ key: "k1", until: until - 2 * MINUTE }]);
    expect(rebuild([...events.slice(0, firstRetirement), stepped(2, T0 + 9 * DAY, -2 * MINUTE)], CONTEXT)).toEqual(state);
  });
});

// The events of one moment of a random log: one event, or the events of a drill start with its run report.
type Moment = (r: Random, index: number, time: number) => readonly RuntimeEvent[];

// The options of a random log: the count of the moments, the time between two moments, and the events of each moment.
interface LogShape {
  readonly count: number;
  readonly gap: (r: Random) => number;
  readonly moment: Moment;
}

// A random log of one copy with imports, steps of the clock and retirements. The default moments come from a small pool of reports.
function randomLog(r: Random, shape: LogShape = { count: 60, gap: (each) => each.int(1, 48) * HOUR, moment: poolMoments() }): RuntimeEvent[] {
  const events: RuntimeEvent[] = [started("run-a", T0)];
  let time = T0;
  for (let index = 0; index < shape.count; index += 1) {
    time += shape.gap(r);
    events.push(...shape.moment(r, index, time));
  }
  return events;
}

// The moments of a small pool of reports, thus the retirements and the late copies meet.
function poolMoments(): Moment {
  const pool = Array.from({ length: 6 }, (_, index) => `w${index}`);
  const idOf = (key: string): ReportId => report(key, T0).id;
  let steps = 0;
  return (r, index, time) => {
    const key = r.pick(pool);
    const choice = r.below(9);
    const own = r.chance(0.5);
    const event = (): RuntimeEvent => {
      switch (choice) {
        case 0:
          return fetched(`fetch:${index}`, time, [report(key, time)]);
        case 1:
          return delivered(`k${index}`, idOf(key), time);
        case 2:
          return ended(time, [idOf(key)]);
        case 3:
          return endOf(idOf(key), time);
        case 4:
          return cancelled(`k${r.below(index + 1)}`, time);
        case 5:
          steps += 1;
          return stepped(steps, time, r.pick([-5, 5, 60]) * MINUTE);
        case 6:
          return escalation(idOf(key), time);
        default: {
          const reports = pool.filter(() => r.chance(0.4)).map(idOf);
          return retired(time, reports, time + r.int(1, 120) * HOUR, [`k${r.below(index + 1)}`]);
        }
      }
    };
    const made = event();
    // Only a shared event can come by import.
    const canImport = made.type !== "clock" && made.type !== "escalation" && made.type !== "retired";
    return [canImport && !own ? imported(made) : made];
  };
}

describe("a random log with retirements", () => {
  it.each(SEEDS)("gives the state of the rebuild after each event, and keeps each retired part out (seed %i)", (seed) => {
    const events = randomLog(random(seed));
    let state = EMPTY_RUNTIME;
    let retirements = 0;
    for (let count = 1; count <= events.length; count += 1) {
      const event = events[count - 1]!;
      state = fold(state, event, CONTEXT);
      if (event.type === "retired") retirements += 1;
      expectNoRetiredPart(state);
      if (count % 10 === 0 || count === events.length) expect(state).toEqual(rebuild(events.slice(0, count), CONTEXT));
    }
    expect(retirements).toBeGreaterThan(0);
  });
});

/** The copy of the drill runs in the logs of the readers (AL-189). */
const COPY = "a";
/** Two drills of the person on the push channel. Only the run reports and the acknowledgments give their verdicts. */
const DRILLS: readonly DrillConfig[] = ["push-weekly", "push-daily"].map((id): DrillConfig => ({
  id,
  person: PERSON,
  path: { kind: "channel", channel: PUSHOVER },
  every: 6 * DAY,
  window: { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] },
  ackWithin: 30 * MINUTE,
}));
/** The shapes of the reports of the readers: a life-safety warning, an urgent wind warning and a wind advisory, each with its level. */
const SHAPES: readonly { readonly level: Level; readonly part: Partial<Report> }[] = [
  { level: "life-safety", part: {} },
  { level: "urgent", part: { kind: { code: "met.wind", label: "High Wind Warning" }, severity: "severe", urgency: "immediate", headline: "High Wind Warning" } },
  { level: "notice", part: { kind: { code: "met.wind", label: "Wind Advisory" }, severity: "moderate", urgency: "future", headline: "Wind Advisory" } },
];
/** A person who watches the place in Kansas, with two pushes at each level. The address is fake. */
const WATCHER: Recipient = {
  watch: { person: PERSON, places: [KANSAS.id], rules: [] },
  policies: SHAPES.map(({ level }) => ({ level, steps: [{ channel: PUSHOVER, at: 0 }, { channel: PUSHOVER, at: 10 * MINUTE }], exhaustedAfter: 20 * MINUTE })),
  addresses: { pushover: { user: "fake-user" } },
};

// A report of a reader log, and the facts that the next moments read.
interface Made {
  readonly report: Report;
  readonly level: Level;
  ended: boolean;
  started: boolean;
  closed: boolean;
}

// A delivery of a reader log, and the facts that the next moments read.
interface Sent {
  readonly delivery: Delivery;
  cancelled: boolean;
  acked: boolean;
}

/**
 * The moments of a log for the readers of the state (AL-189). Each event is an event that a copy can write. A delivery,
 * a start, a hold or a suppression goes only to a live report. An acknowledgment goes only to a delivery with a receipt and no cancel.
 */
function readerMoments(): Moment {
  const made: Made[] = [];
  const runs: { readonly made: Made; readonly key: string }[] = [];
  const sent: Sent[] = [];
  let steps = 0;
  let lines = 0;
  let observing = false;
  const start = (one: Made, level: Level, time: number): RuntimeEvent => {
    one.started = true;
    return { ...envelope("escalation", `escalation:${one.report.id}`, time), start: { incident: one.report.id, level, person: PERSON, at: time } };
  };
  const send = (one: Made, key: string, level: Level, time: number, receipt: boolean): RuntimeEvent => {
    const item: Delivery = { key, incident: one.report.id, level, person: PERSON, channel: PUSHOVER, step: 0, at: time, ...(receipt ? { receipt: { receipt: `r-${key}` } } : {}) };
    sent.push({ delivery: item, cancelled: false, acked: false });
    return { ...envelope("delivery", `delivery:${key}`, time), delivery: item };
  };
  const ack = (item: Sent, time: number): RuntimeEvent => {
    item.acked = true;
    const { incident, level, person } = item.delivery;
    return { ...envelope("acknowledgment", `ack:${item.delivery.key}`, time), acknowledgment: { incident, level, person, at: time, via: PUSHOVER } };
  };
  const cancel = (item: Sent, time: number): RuntimeEvent => {
    item.cancelled = true;
    return cancelled(item.delivery.key, time);
  };
  return (r, index, time) => {
    const own = r.chance(0.6);
    const shared = (event: RuntimeEvent): RuntimeEvent => (own ? event : imported(event));
    const live = made.filter((one) => !one.ended && (one.report.expires === undefined || one.report.expires > time));
    const pick = <T,>(list: readonly T[], then: (item: T) => readonly RuntimeEvent[]): readonly RuntimeEvent[] => (list.length === 0 ? [] : then(r.pick(list)));
    // The first moment can put the source in the observe mode. Then the observe verdict and the cut read its reports.
    if (index === 0 && r.chance(0.5)) observing = true;
    const first: RuntimeEvent[] = index === 0 && observing ? [{ ...envelope("mode", "mode:observe", time - SECOND), source: API, mode: "observe", reason: "a test" }] : [];
    const choice = r.below(17);
    const eventsOf = (): readonly RuntimeEvent[] => {
      switch (choice) {
        case 0:
        case 1: {
          const shape = r.pick(SHAPES);
          const area = r.chance(0.8) ? "KSZ083" : "TXZ205";
          const part: Partial<Report> = { ...shape.part, expires: time + r.int(1, 6) * HOUR, areas: [{ type: "code", system: "ugc", code: area }] };
          const one: Made = { report: report(`r${index}`, time, time, part), level: shape.level, ended: false, started: false, closed: false };
          made.push(one);
          return [shared(fetched(`fetch:${index}`, time, [one.report]))];
        }
        case 2:
          // The feed lists a live report again.
          return pick(live, (one) => [shared(fetched(`fetch:${index}`, time, [{ ...one.report, received: time }]))]);
        case 3:
        case 4:
          return pick(live, (one) => {
            const level: Level = r.chance(0.15) ? "digest" : one.level;
            const delivery = send(one, `k${index}`, level, time, r.chance(0.6));
            // Another copy writes its own start. Only the delivery comes by import.
            if (!own) return [imported(delivery)];
            return level === "digest" || one.started ? [delivery] : [start(one, level, time), delivery];
          });
        case 5:
          return pick(
            sent.filter((item) => item.delivery.receipt !== undefined && !item.cancelled && !item.acked),
            (item) => [shared(ack(item, time))],
          );
        case 6:
          return pick(
            sent.filter((item) => !item.cancelled),
            (item) => [shared(cancel(item, time))],
          );
        case 7:
          return pick(
            live.filter((one) => !one.started),
            (one) => [start(one, one.level, time)],
          );
        case 8:
          return pick(
            made.filter((one) => one.started && !one.closed),
            (one) => {
              one.closed = true;
              return [shared(endOf(one.report.id, time))];
            },
          );
        case 9:
          return pick(
            live.filter((one) => one.level !== "life-safety"),
            (one) => [{ ...envelope("hold", `hold:${index}`, time), hold: { incident: one.report.id, level: one.level, person: PERSON, episode: 0, at: time } }],
          );
        case 10:
          return pick(
            live.filter((one) => one.level !== "life-safety"),
            (one) => [
              {
                ...envelope("suppressed", `suppressed:s${index}`, time),
                suppression: { key: `s${index}`, incident: one.report.id, level: one.level, person: PERSON, channel: PUSHOVER, step: 0, episode: 0, at: time, reason: "same-level", over: "life-safety" },
              },
            ],
          );
        case 11:
          // A source ends a report while the feed lists it, or soon after its expiry.
          return pick(
            made.filter((one) => !one.ended && (one.report.expires === undefined || one.report.expires + HOUR > time)),
            (one) => {
              one.ended = true;
              return [shared(ended(time, [one.report.id]))];
            },
          );
        case 12:
          steps += 1;
          return [stepped(steps, time, r.pick([-5, 5, 60]) * MINUTE)];
        case 13: {
          // A drill starts, and its run report goes to the person with a receipt. The person acknowledges some runs at once.
          const drill = r.pick(DRILLS);
          const { expires: _expires, ...run } = report(`run${index}`, time + SECOND, time + SECOND, {
            kind: { code: "system.drill.run", label: "Drill run" },
            status: "system",
            onset: time,
            areas: [],
            headline: `Drill ${drill.id}`,
            parameters: { drill: [drill.id], copy: [COPY] },
          });
          const one: Made = { report: run, level: "life-safety", ended: false, started: false, closed: false };
          made.push(one);
          runs.push({ made: one, key: `k${index}` });
          const events: RuntimeEvent[] = [{ ...envelope("drill", `drill:${COPY}:${drill.id}:${String(time)}`, time), drill: drill.id, copy: COPY }, fetched(`fetch:${index}`, time + SECOND, [run])];
          if (r.chance(0.5)) events.push(start(one, "life-safety", time + 2 * SECOND));
          events.push(send(one, `k${index}`, "life-safety", time + 2 * SECOND, true));
          if (r.chance(0.6)) events.push(ack(sent.at(-1)!, time + 3 * SECOND));
          return events;
        }
        case 14:
          // The line of a run ends, and its alert gets its cancel. Then only the drill keeps its incident.
          return pick(
            runs.filter((one) => !one.made.ended),
            (one) => {
              one.made.ended = true;
              const item = sent.find((each) => each.delivery.key === one.key)!;
              return [ended(time, [one.made.report.id]), ...(item.cancelled ? [] : [cancel(item, time + SECOND)])];
            },
          );
        case 15:
          return observing ? [{ ...envelope("mode", `mode:live:${index}`, time), source: API, mode: "live", reason: "a test" }] : [];
        default: {
          // A line of a down channel of the copy opens or closes.
          lines += 1;
          const key = `channel/${COPY}/pushover#${String(lines)}`;
          const observation: Observation = { id: `system:${key}` as ObservationId, source: SYSTEM_SOURCE, fetched: time, contentType: "application/json", body: JSON.stringify({ facts: { copy: COPY, channel: "pushover" } }), transport: { latency: 0 } };
          const part: Partial<Report> = { id: reportId({ source: SYSTEM_SOURCE, key, sent: time }), source: SYSTEM_SOURCE, status: "system", op: lines % 2 === 1 ? "alert" : "cancel", kind: { code: "system.channel", label: "Channel down" }, areas: [], observation: observation.id };
          return [{ ...envelope("system", `system:${key}`, time), reports: [report(key, time, time, part)], observations: [observation] }];
        }
      }
    };
    return [...first, ...eventsOf()];
  };
}

describe("a retirement changes no verdict and sends nothing (AL-189)", () => {
  // The times are short, thus each log has many retirements. The send limit and the throttle have their longest windows.
  const RETIRE: FoldContext = { sources: [], retention: { horizon: DAY, quiet: 3 * HOUR, life: 2 * DAY, every: HOUR } };
  const LIMITS: SendLimits = { window: SEND_LIMIT_MAX_WINDOW, notice: 2, urgent: 3 };
  const THROTTLE: Throttle = { window: THROTTLE_MAX_WINDOW, key: "channel", streams: "system", exempt: ["life-safety"] };
  const link = linkRule(DEFAULT_LINK_POLICY);
  const parts: ObserveParts = { people: [WATCHER.watch], places: [KANSAS], limits: LIMITS };
  const gap = (r: Random): number => (r.chance(0.85) ? r.int(1, 30) * MINUTE : r.int(2, 30) * HOUR);

  // The output of each reader of the state at a time, as the pass and the delivery step read them.
  function readers(state: RuntimeState, at: number) {
    const found = incidents(state.merge, at, { link });
    const cut = cutIncidents(state, state.merge, found, parts, at);
    // The one designed loss: the cancel of an alert older than the horizon retires with its incident. Each alert of a
    // channel ends long before the horizon, thus that cancel changes nothing at the phone.
    const old = at - (RETIRE.retention?.horizon ?? 0);
    const moot = (entry: ReturnType<typeof route>[number]): boolean => !entry.incident.live && entry.plan.sends.length === 0 && entry.deliveries.every((delivery) => delivery.at <= old);
    const routes = route({ state: state.merge, incidents: cut.sent, recipients: [WATCHER], places: [KANSAS], starts: state.starts, ends: state.escalationEnds, cancelled: cancelledKeys(state), channels: [POLLED], now: at }).filter((entry) => !moot(entry));
    const limited = limitRoutes({ routes, deliveries: state.merge.deliveries, holds: state.holds, limits: LIMITS, reports: state.merge.reports, now: at });
    const throttled = throttleRoutes({ routes: limited.routes, deliveries: state.merge.deliveries, suppressions: state.suppressions, reports: state.merge.reports, throttle: THROTTLE, now: at });
    const runs = DRILLS.map((drill) => drillRunOf(state, COPY, drill));
    return {
      runs,
      verdicts: runs.map((run, index) => (run === undefined ? undefined : drillVerdict(DRILLS[index]!, run, at))),
      observe: observeStep(state, found, parts, at),
      lifeSafety: cut.lifeSafety,
      held: heldPersons(state.holds, state.merge.reports, LIMITS.window, at),
      holds: limited.holds,
      suppressions: throttled.suppressions,
      routes: throttled.routes,
      exhausted: exhaustions(throttled.routes, [POLLED], state.merge.reports),
      down: downChannels(state.lines, COPY),
    };
  }

  it.each(SEEDS)("gives the same output of each reader with and without the retirements of the fold (seed %i)", (seed) => {
    const events = randomLog(random(seed), { count: 240, gap, moment: readerMoments() });
    let kept = EMPTY_RUNTIME;
    let retiring = EMPTY_RUNTIME;
    let retirements = 0;
    // The counts of the outputs that the gate compares. A log with none of them tests nothing.
    let passed = 0;
    let sends = 0;
    for (const [index, event] of events.entries()) {
      kept = fold(kept, event, CONTEXT);
      retiring = fold(retiring, event, RETIRE, () => {
        retirements += 1;
      });
      expect(retiring.time).toBe(kept.time);
      const expected = readers(kept, kept.time);
      const actual = readers(retiring, kept.time);
      // One assertion for each reader, thus a failure names the reader.
      for (const name of Object.keys(expected) as (keyof typeof expected)[]) expect(actual[name], `the reader ${name} after the event ${String(index)}: ${event.id}`).toEqual(expected[name]);
      passed += expected.verdicts.filter((verdict) => verdict?.state === "passed").length;
      sends += expected.routes.flatMap((entry) => entry.plan.sends).length;
    }
    expect(retirements).toBeGreaterThan(0);
    expect(passed).toBeGreaterThan(0);
    expect(sends).toBeGreaterThan(0);
  });
});

describe("the retirement in the pass", () => {
  // A source that gives the same warning at each fetch: a feed that lists an old report for a long time.
  function source(clock: ReturnType<typeof fakeWallClock>): SourceProcedures {
    const observation = (at: number): Observation => ({ id: `api:w1:${String(at)}` as ObservationId, source: API, fetched: at, contentType: "application/json", body: JSON.stringify({ key: "w1" }), transport: { latency: 0 } });
    return {
      describe: () => ({
        id: API,
        title: "The source api",
        origins: ["nws"],
        dependsOn: ["provider:api"],
        uses: ["internet", "power"],
        kinds: ["met"],
        coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
        transport: "poll",
        interval: HOUR,
        slowAfter: 10_000,
        auth: "none",
      }),
      fetch: async () => ({ ok: true, observations: [observation(clock.now())], complete: true }),
      map: ({ observation: seen }) => ({ reports: [report("w1", seen.fetched)], problems: [] }),
    };
  }

  const open = (log: ReturnType<typeof openRuntimeLog>, clock: ReturnType<typeof fakeWallClock>, run: string) =>
    openRuntime({
      log,
      clock,
      sources: [source(clock)],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } },
      run,
      retention: { horizon: 2 * HOUR, life: 6 * HOUR, every: HOUR },
    });

  const retiredEntries = (log: ReturnType<typeof openRuntimeLog>): unknown[] => [...log.entries({ after: 0, types: ["retired"], limit: 100 })];

  it("retires an old incident in the fold with no retired event, keeps the next copies out, and a restart gives the same state", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(T0);
    const runtime = open(log, clock, "run-1");
    await runtime.pass();
    expect(ids(runtime.state().merge.reports)).toEqual([W1]);
    // The warning expires at T0 + 1 h. No person got it, thus the quiet horizon applies: here it is the horizon of 2 h.
    // The first event at T0 + 3 h is one interval after the last step, thus the step before it retires the incident.
    await clock.advance(3 * HOUR);
    await runtime.pass();
    expect(runtime.state().merge.reports).toEqual([]);
    expect(runtime.state().own.merge.retired).toEqual([{ report: W1, until: T0 + 9 * HOUR }]);
    expect(retiredEntries(log)).toEqual([]);
    // The feed lists the report again. The tombstone keeps it out.
    await clock.advance(HOUR);
    await runtime.pass();
    expect(runtime.state().merge.reports).toEqual([]);
    expect(rebuild(log.read(), runtime.config)).toEqual(runtime.state());
    const again = open(log, clock, "run-2");
    expect(again.state().merge).toEqual(runtime.state().merge);
    expect(again.state().retiredAt).toBe(runtime.state().retiredAt);
    log.close();
  });

  it("steps at most once in each interval of the event time", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(T0);
    const runtime = open(log, clock, "run-1");
    await runtime.pass();
    // At T0 + 3 h - 1 min, the incident is not old enough. The next pass in the interval has no step.
    await clock.advance(3 * HOUR - MINUTE);
    await runtime.pass();
    expect(runtime.state().retiredAt).toBe(T0 + 3 * HOUR - MINUTE);
    await clock.advance(2 * MINUTE);
    await runtime.pass();
    expect(ids(runtime.state().merge.reports)).toEqual([W1]);
    expect(runtime.state().retiredAt).toBe(T0 + 3 * HOUR - MINUTE);
    await clock.advance(HOUR);
    await runtime.pass();
    expect(runtime.state().merge.reports).toEqual([]);
    expect(retiredEntries(log)).toEqual([]);
    expect(rebuild(log.read(), runtime.config)).toEqual(runtime.state());
    log.close();
  });
});

describe("retention", () => {
  it("gives the defaults of the core and an interval of one hour", () => {
    expect(retention()).toEqual({ horizon: 7 * DAY, life: TOMBSTONE_LIFE, every: RETIRE_EVERY, quiet: QUIET_HORIZON, told: QUIET_HORIZON });
    expect(retention({ quiet: HOUR }).told).toBe(HOUR);
    expect(RETIRE_EVERY).toBe(HOUR);
    // A horizon that is shorter than the quiet horizon is also the quiet horizon.
    expect(retention({ horizon: 2 * HOUR }).quiet).toBe(2 * HOUR);
  });

  it("refuses a time that is not a finite number of 0 or more, an interval of 0, and a quiet horizon longer than the horizon", () => {
    expect(() => retention({ horizon: -1 })).toThrow("The horizon of the retention is -1");
    expect(() => retention({ life: Number.NaN })).toThrow("The life of the retention is NaN");
    expect(() => retention({ every: 0 })).toThrow("The interval of the retirements is 0");
    expect(() => retention({ quiet: -1 })).toThrow("The quiet horizon of the retention is -1");
    expect(() => retention({ quiet: 8 * DAY })).toThrow(`The quiet horizon of the retention is ${8 * DAY}, longer than the horizon ${7 * DAY}.`);
    expect(() => retention({ told: 8 * DAY })).toThrow(`The time told of the retention is ${8 * DAY}, longer than the horizon ${7 * DAY}.`);
  });
});

describe("the incidents that are not quiet (AL-109)", () => {
  const w1 = report("w1", T0 + SECOND);
  const base: RuntimeEvent[] = [started("run-a", T0), fetched("fetch:1", T0 + SECOND, [w1])];
  const incidentOf = (state: RuntimeState) => incidents(state.merge, T0 + 2 * HOUR, { link: linkRule(DEFAULT_LINK_POLICY) })[0]!;
  const keeps = (events: readonly RuntimeEvent[], expectations: Parameters<typeof quietKeeps>[1] = [], at = T0 + 2 * HOUR): boolean => {
    const state = foldAll([...base, ...events]);
    return quietKeeps(state, expectations, at)(incidentOf(state));
  };

  it("keeps no incident with no escalation, hold, suppression, observed source or expectation", () => {
    expect(keeps([])).toBe(false);
  });

  it("keeps an incident with an escalation start, a hold or a suppression of this copy", () => {
    expect(keeps([escalation(W1, T0 + 2 * SECOND)])).toBe(true);
    const hold: RuntimeEvent = { ...envelope("hold", "hold:1", T0 + 2 * SECOND), hold: { incident: W1, level: "life-safety", person: PERSON, episode: 0, at: T0 + 2 * SECOND } };
    expect(keeps([hold])).toBe(true);
    const suppression: RuntimeEvent = {
      ...envelope("suppressed", "suppressed:1", T0 + 2 * SECOND),
      suppression: { key: "s1", incident: W1, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, episode: 0, at: T0 + 2 * SECOND, reason: "same-level", over: "life-safety" },
    };
    expect(keeps([suppression])).toBe(true);
  });

  it("keeps an incident with an escalation start, a hold or a suppression only for ENTRY_KEEP after the entry (AL-172)", () => {
    expect(ENTRY_KEEP).toBe(DAY);
    const entry = escalation(W1, T0 + 2 * SECOND);
    expect(keeps([entry], [], T0 + 2 * SECOND + ENTRY_KEEP)).toBe(true);
    expect(keeps([entry], [], T0 + 2 * SECOND + ENTRY_KEEP + 1)).toBe(false);
  });

  it("keeps an incident with an alert that has no cancel, and not a digest (AL-172)", () => {
    expect(keeps([delivered("k1", W1, T0 + 2 * SECOND)])).toBe(true);
    expect(keeps([delivered("k1", W1, T0 + 2 * SECOND), cancelled("k1", T0 + 3 * SECOND)])).toBe(false);
    const digest: RuntimeEvent = { ...envelope("delivery", "delivery:d1", T0 + 2 * SECOND), delivery: { ...delivery("d1", W1, T0 + 2 * SECOND), level: "digest" } };
    expect(keeps([digest])).toBe(false);
  });

  it("keeps an incident with a report of a source in observe mode, and not after the source goes live", () => {
    const observe: RuntimeEvent = { ...envelope("mode", "mode:1", T0), source: API, mode: "observe", reason: "a test" };
    const live: RuntimeEvent = { ...envelope("mode", "mode:2", T0 + 2 * SECOND), source: API, mode: "live", reason: "a test" };
    expect(keeps([observe])).toBe(true);
    expect(keeps([observe, live])).toBe(false);
  });

  it("keeps an incident of a source in observe mode only for the observe window after the receipt of its report (AL-172)", () => {
    const observe: RuntimeEvent = { ...envelope("mode", "mode:1", T0), source: API, mode: "observe", reason: "a test" };
    // The verdict counts the report until the end of the window. After that, nothing reads the report.
    expect(keeps([observe], [], T0 + SECOND + OBSERVE_WINDOW)).toBe(true);
    expect(keeps([observe], [], T0 + SECOND + OBSERVE_WINDOW + 1)).toBe(false);
  });

  it("keeps an incident with a report that starts the check of an expectation", () => {
    const expectation = { id: "e1", from: API, to: "other" as SourceId, when: { kinds: ["met.tornado"] } };
    expect(keeps([], [expectation])).toBe(true);
    expect(keeps([], [{ ...expectation, when: { kinds: ["met.flood"] } }])).toBe(false);
    expect(keeps([], [{ ...expectation, from: "other" as SourceId }])).toBe(false);
  });
});

describe("the cadence of the retirement (AL-109)", () => {
  const link = linkRule(DEFAULT_LINK_POLICY);
  const foldIn = (events: readonly RuntimeEvent[], context: FoldContext = RETAIN): RuntimeState => events.reduce((state, event) => fold(state, event, context), EMPTY_RUNTIME);
  const expectRebuild = (events: readonly RuntimeEvent[], context: FoldContext = RETAIN): void => {
    for (let count = 1; count <= events.length; count += 1) expect(rebuild(events.slice(0, count), context)).toEqual(foldIn(events.slice(0, count), context));
  };

  it("retires an incident of a source in observe mode one observe window after the receipt, not at the horizon (AL-172)", () => {
    const events = [
      started("run-a", T0),
      { ...envelope("mode", "mode:1", T0), source: API, mode: "observe", reason: "a test" } as RuntimeEvent,
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      // The verdict still counts the report at the end of its window, thus it stays.
      fetched("fetch:2", T0 + SECOND + OBSERVE_WINDOW, []),
      // At the next step, nothing reads the report, and its quiet horizon is over.
      fetched("fetch:3", T0 + SECOND + OBSERVE_WINDOW + 2 * HOUR, []),
    ];
    expect(ids(foldIn(events.slice(0, 4)).merge.reports)).toEqual([W1]);
    expect(foldIn(events).merge.reports).toEqual([]);
    expectRebuild(events);
  });

  it("retires a quiet incident at the first event one interval after the last step, and the log has no retired event", () => {
    // The warning expires at T0 + 1 h, thus its quiet horizon of 6 h ends at T0 + 7 h.
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      // The step at this event is one minute early.
      fetched("fetch:2", T0 + 7 * HOUR - MINUTE, []),
      // This event is in the interval of the last step, thus it has no step.
      fetched("fetch:3", T0 + 7 * HOUR + MINUTE, []),
      fetched("fetch:4", T0 + 8 * HOUR - MINUTE, []),
    ];
    expect(ids(foldIn(events.slice(0, 4)).merge.reports)).toEqual([W1]);
    expect(foldIn(events.slice(0, 4)).retiredAt).toBe(T0 + 7 * HOUR - MINUTE);
    const state = foldIn(events);
    expect(state.merge.reports).toEqual([]);
    expect(state.own.merge.retired).toEqual([{ report: W1, until: T0 + 8 * HOUR - MINUTE + TOMBSTONE_LIFE }]);
    expect(state.retiredAt).toBe(T0 + 8 * HOUR - MINUTE);
    expectRebuild(events);
    // Without a retention in the context, the fold retires nothing.
    expect(ids(foldIn(events, CONTEXT).merge.reports)).toEqual([W1]);
    expect(foldIn(events, CONTEXT).retiredAt).toBeUndefined();
  });

  it("keeps an incident that a person got until the cancel of its alert, and then until the quiet horizon (AL-172)", () => {
    // The warning expires at T0 + 1 h. Its alert has no cancel, thus the alert can still ring.
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      delivered("k1", W1, T0 + 2 * SECOND),
      fetched("fetch:2", T0 + 2 * DAY, []),
      cancelled("k1", T0 + 2 * DAY + SECOND),
      // The cancel is done, and the quiet horizon ended long ago. The next step retires the incident.
      fetched("fetch:3", T0 + 2 * DAY + HOUR, []),
    ];
    expect(ids(foldIn(events.slice(0, 5)).merge.reports)).toEqual([W1]);
    const state = foldIn(events);
    expect(state.merge.reports).toEqual([]);
    expect(state.merge.deliveries).toEqual([]);
    expectRebuild(events);
    // With no cancel, the incident keeps the full horizon.
    const open = [...events.slice(0, 4), fetched("fetch:3", T0 + HOUR + RETENTION_HORIZON - MINUTE, []), fetched("fetch:4", T0 + 2 * HOUR + RETENTION_HORIZON, [])];
    expect(ids(foldIn(open.slice(0, 5)).merge.reports)).toEqual([W1]);
    expect(foldIn(open).merge.reports).toEqual([]);
  });

  it("retires an incident with only a digest at the quiet horizon: a digest gets no cancel (AL-172)", () => {
    const digest: RuntimeEvent = { ...envelope("delivery", "delivery:d1", T0 + 2 * SECOND), delivery: { ...delivery("d1", W1, T0 + 2 * SECOND), level: "digest" } };
    const events = [started("run-a", T0), fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]), digest, fetched("fetch:2", T0 + 7 * HOUR - MINUTE, []), fetched("fetch:3", T0 + 8 * HOUR, [])];
    expect(ids(foldIn(events.slice(0, 4)).merge.reports)).toEqual([W1]);
    expect(foldIn(events).merge.reports).toEqual([]);
    expectRebuild(events);
  });

  it("gives no new send for a copy of a told report after its retirement (AL-172)", () => {
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      delivered("k1", W1, T0 + 2 * SECOND),
      cancelled("k1", T0 + HOUR),
      fetched("fetch:2", T0 + 8 * HOUR, []),
      // The feed lists the old warning again, also with an open expiry in the future.
      fetched("fetch:3", T0 + 9 * HOUR, [report("w1", T0 + 9 * HOUR), { ...report("w1", T0 + 9 * HOUR), expires: T0 + 30 * DAY }]),
    ];
    const state = foldIn(events);
    expect(state.own.merge.retired.map((one) => one.report)).toEqual([W1]);
    expect(state.merge.reports).toEqual([]);
    const now = T0 + 9 * HOUR + SECOND;
    const found = incidents(state.merge, now, { link });
    const routes = route({ state: state.merge, incidents: found, recipients: [RECIPIENT], places: [KANSAS], starts: state.starts, ends: state.escalationEnds, cancelled: cancelledKeys(state), channels: [POLLED], now });
    expect(routes.flatMap((one) => one.plan.sends)).toEqual([]);
    expectRebuild(events);
  });

  it("opens a new incident for a new live update of a retired incident, and routes it", () => {
    // The source ends the warning at T0 + 30 min, and the warning expires at T0 + 1 h. No person got it, thus it is quiet.
    // 7 h later, the source sends an update with a new key and a new sent time, thus a new id. The feed also lists the old warning again.
    const update: Report = { ...report("u1", T0 + 8 * HOUR, T0 + 8 * HOUR), op: "update", references: ["w1"] };
    const events = [started("run-a", T0), fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]), ended(T0 + 30 * MINUTE, [W1]), fetched("fetch:2", T0 + 8 * HOUR, [report("w1", T0 + 8 * HOUR), update])];
    const state = foldIn(events);
    // The tombstone keeps out only the copy of the old warning. The update is a new part, thus it stays.
    expect(state.own.merge.retired.map((one) => one.report)).toEqual([W1]);
    expect(ids(state.merge.reports)).toEqual([update.id]);
    const now = T0 + 8 * HOUR + SECOND;
    const found = incidents(state.merge, now, { link });
    expect(found.map((incident) => ({ reports: incident.reports, live: incident.live }))).toEqual([{ reports: [update.id], live: true }]);
    const routes = route({ state: state.merge, incidents: found, recipients: [RECIPIENT], places: [KANSAS], starts: state.starts, ends: state.escalationEnds, cancelled: cancelledKeys(state), channels: [POLLED], now });
    expect(routes.map((one) => one.incident.reports)).toEqual([[update.id]]);
    expect(routes[0]!.plan.sends.length).toBeGreaterThan(0);
    expectRebuild(events);
  });

  it("keeps the copy of a report that the rebuild keeps across a step of the clock", () => {
    // Two copies of one report, received at 9 and at 10. The normal form keeps the copy with the lower text: "10" is before "9".
    // After a step of 1 ms, the times are 10 and 11, and "10" is before "11". Thus the fold and the rebuild must apply the
    // normal form before the step.
    const events = [fetched("fetch:1", 9, [report("w1", 9)]), fetched("fetch:2", 10, [report("w1", 10)]), stepped(1, 11, 1)];
    expect(foldIn(events, CONTEXT).merge.reports.map((one) => one.received)).toEqual([11]);
    expectRebuild(events, CONTEXT);
    expectRebuild(events);
  });

  it("gives the rebuild the same calls of the hook as the fold, also for an old retired event", () => {
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND), report("w2", T0 + SECOND)]),
      retired(T0 + 2 * SECOND, [W2], T0 + DAY),
      fetched("fetch:2", T0 + 8 * HOUR, []),
    ];
    const folded: string[][] = [];
    events.reduce((state, event) => fold(state, event, RETAIN, (merge) => folded.push(ids(merge.reports))), EMPTY_RUNTIME);
    const rebuilt: string[][] = [];
    rebuild(events, RETAIN, (merge) => rebuilt.push(ids(merge.reports)));
    expect(folded).toEqual([[W1], []]);
    expect(rebuilt).toEqual(folded);
  });
});

describe("the retirement of an orphan key (AL-47)", () => {
  // The told incident keeps the full horizon here, thus the key keeps its age at the retirement (AL-172).
  const options = retention({ told: RETENTION_HORIZON });
  const link = linkRule(DEFAULT_LINK_POLICY);
  // An own delivery of k1, and its cancel from the other copy.
  const first: RuntimeEvent[] = [
    started("run-a", T0),
    fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
    delivered("k1", W1, T0 + 3 * SECOND),
    imported(cancelled("k1", T0 + 4 * SECOND)),
  ];
  const foldWith = (events: readonly RuntimeEvent[], at: number): readonly RuntimeEvent[] => {
    const event = retiredEvent(foldAll(events), at, link, options);
    if (event === undefined) throw new Error(`No retirement at ${String(at)}.`);
    return [...events, event];
  };

  it("drops an old cancel that a new read of the other copy brings back, at the horizon after its entry", () => {
    // The incident retires with its key. The retirement after the life of the tombstones drops the key tombstone.
    const retiredAt = T0 + 8 * DAY;
    const once = foldWith(first, retiredAt);
    expect(once.at(-1)).toMatchObject({ reports: [W1], cancelled: ["k1"] });
    const until = retiredAt + TOMBSTONE_LIFE;
    // A recovery sets each read position to 0, thus the next read imports the old cancel again. The own delivery stays out.
    const recovery: RuntimeEvent = { ...envelope("recovered", "recovered:q-1", until + 2 * HOUR), quarantine: "q-1", fault: "corrupt", read: 4, added: 4, lost: 0, whole: true, problems: [] };
    const log = [...once, retired(until + HOUR, [], until + HOUR + TOMBSTONE_LIFE), recovery, imported(cancelled("k1", T0 + 4 * SECOND))];
    const state = foldAll(log);
    expect(state.cancelled).toEqual(["k1"]);
    expect(state.cancelledSince).toEqual({ k1: until + 2 * HOUR });
    expect(state.merge.deliveries).toEqual([]);
    // One millisecond before the horizon after its entry, the orphan stays.
    const due = until + 2 * HOUR + RETENTION_HORIZON;
    expect(retiredEvent(state, due - 1, link, options)).toBeUndefined();
    const dropped = foldWith(log, due);
    expect(dropped.at(-1)).toMatchObject({ type: "retired", reports: [], cancelled: ["k1"] });
    const after = foldAll(dropped);
    expect(after.cancelled).toEqual([]);
    expect(after.cancelTombstones).toEqual([{ key: "k1", until: due + TOMBSTONE_LIFE }]);
    expectNoRetiredPart(after);
    expect(rebuild(dropped, CONTEXT)).toEqual(after);
  });

  it("keeps an old cancel with a delivery in the merge, and a cancel with no time of entry", () => {
    // The warning expires at T0 + 1 h, thus its incident retires at the horizon after that. The key is older before then.
    const state = foldAll(first);
    expect(state.cancelledSince).toEqual({ k1: T0 + 3 * SECOND });
    expect(retiredEvent(state, T0 + 3 * SECOND + RETENTION_HORIZON + MINUTE, link, options)).toBeUndefined();
    expect(retiredEvent(state, T0 + HOUR + RETENTION_HORIZON, link, options)).toMatchObject({ reports: [W1], cancelled: ["k1"] });
    // An import before each own event has no own time, thus its key has no age.
    const early = foldAll([imported(cancelled("k6", T0))]);
    expect(early.cancelled).toEqual(["k6"]);
    expect(early.cancelledSince).toEqual({});
    expect(retiredEvent(early, T0 + 100 * DAY, link, options)).toBeUndefined();
  });

  it("keeps a retired orphan key cancelled for the routes, thus its late delivery gives no poll and no cancel", () => {
    // The cancel of k9 comes from the copy b. The copy that made the delivery stays out of reach past the horizon.
    const due = T0 + RETENTION_HORIZON;
    const orphan = foldWith([started("run-c", T0), imported(cancelled("k9", T0 + SECOND))], due);
    expect(orphan.at(-1)).toMatchObject({ reports: [], cancelled: ["k9"] });
    // Then a read brings the delivery of k9, with its receipt, in a live warning.
    const w9 = report("w9", due + MINUTE, due + MINUTE);
    const late: RuntimeEvent = { ...envelope("delivery", "delivery:k9", due + 2 * MINUTE), delivery: { ...delivery("k9", w9.id, due + 2 * MINUTE), receipt: { receipt: "r-9" } } };
    const state = foldAll([...orphan, fetched("fetch:9", due + MINUTE, [w9]), imported(late)]);
    expect(state.cancelled).toEqual([]);
    expect(state.merge.deliveries.map((one) => one.key)).toEqual(["k9"]);
    expect(cancelledKeys(state)).toEqual(new Set(["k9"]));
    const routesOf = (keys: ReadonlySet<string>, now: number): Route[] =>
      route({ state: state.merge, incidents: incidents(state.merge, now, { link }), recipients: [RECIPIENT], places: [KANSAS], starts: state.starts, ends: state.escalationEnds, cancelled: keys, channels: [POLLED], now });
    const keysOf = (routes: readonly Route[], part: (one: Route) => readonly Delivery[]): string[] => routes.flatMap((one) => part(one).map((item) => item.key));
    // With the keys of `cancelled` only, the route polls k9 while the warning is live, and cancels k9 again after it.
    const live = due + 3 * MINUTE;
    // The warning expires one hour after it was sent.
    const over = due + MINUTE + HOUR + MINUTE;
    expect(keysOf(routesOf(new Set(state.cancelled), live), (one) => one.polls)).toEqual(["k9"]);
    expect(keysOf(routesOf(new Set(state.cancelled), over), (one) => one.plan.cancels)).toEqual(["k9"]);
    // With the keys of the tombstones too, k9 gets no poll and no cancel, and the expired incident has no route.
    expect(keysOf(routesOf(cancelledKeys(state), live), (one) => one.polls)).toEqual([]);
    expect(routesOf(cancelledKeys(state), over)).toEqual([]);
  });
});
