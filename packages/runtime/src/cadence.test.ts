/**
 * The property of the cadence of the retirement (AL-109). The fold of the live runtime and the rebuild of the start give
 * the same state, and the same times of entry, at each prefix of a random log. The live runtime retires on the event
 * time, thus no wall clock decides a retirement. The logs also have `retired` events of an older build.
 */
import { reportId, type Delivery, type EntryTimes, type Expectation, type ObservationId, type PersonId, type ChannelId, type Report, type ReportId, type SourceId } from "@mark1russell7/alerts";
import { seedsFrom } from "@mark1russell7/rigor-generators";
import { runModel, step, type Step } from "@mark1russell7/rigor-testkit/model";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entryIndex, type EntryIndex } from "./entries.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, sharedItem } from "./exchange.ts";
import { EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const API = "api" as SourceId;
const OTHER = "other" as SourceId;
const PERSON = "person-1" as PersonId;
const PUSHOVER = "pushover" as ChannelId;
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
// The keys of the pool of reports. A key of the pool has one sent time, thus each copy of it has one id.
const POOL = ["w0", "w1", "w2", "f0"];

/** One report of a county of Kansas. The key `f0` is a flood watch, and each other key is a tornado warning. */
function report(key: string, received: number, sent = T0, extra: Partial<Report> = {}): Report {
  const flood = key.startsWith("f");
  return {
    id: reportId({ source: API, key, sent }),
    source: API,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: flood ? { code: "met.flood", label: "Flood Watch" } : { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: flood ? "moderate" : "extreme",
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
    ...extra,
  };
}

const idOf = (key: string): ReportId => report(key, T0).id;
const delivery = (key: string, incident: ReportId, at: number): Delivery => ({ key, incident, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at });
const imported = (event: RuntimeEvent): RuntimeEvent => {
  const item = sharedItem(event, "b");
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return importOf(item);
};

/** The live path of `openRuntime`: the fold of each event, then the entry index, with each prune after the event of its retirement. */
interface Live {
  state: RuntimeState;
  readonly entries: EntryIndex;
}

/** The log, and the clock of the copy that writes it. */
interface Log {
  readonly events: RuntimeEvent[];
  time: number;
  count: number;
}

function append(live: Live, log: Log, event: RuntimeEvent, context: FoldContext): void {
  const pruned: Pick<RuntimeState["merge"], "reports">[] = [];
  live.state = fold(live.state, event, context, (merge) => pruned.push(merge));
  live.entries.add(event);
  for (const merge of pruned) live.entries.prune(merge);
  log.events.push(event);
}

// The parameters of one step: the time to the event, the type of the event, a key of the pool and a small number.
const STEP = fc.record({
  after: fc.constantFrom(0, MINUTE, 10 * MINUTE, HOUR, 3 * HOUR, 7 * HOUR, DAY, 3 * DAY),
  choice: fc.integer({ min: 0, max: 15 }),
  key: fc.constantFrom(...POOL),
  other: fc.boolean(),
  n: fc.integer({ min: 0, max: 7 }),
});

// The event of a step, at the time of the log after the step.
function eventOf({ choice, key, other, n }: fc.RecordValue<typeof STEP>, log: Log): RuntimeEvent {
  const at = log.time;
  const index = (log.count += 1);
  const id = idOf(key);
  const ownOrImported = (event: RuntimeEvent): RuntimeEvent => (other ? imported(event) : event);
  switch (choice) {
    case 0:
    case 1:
      return ownOrImported({ ...envelope("fetch", `fetch:${index}`, at), record: { source: API, at, took: 100, fresh: 1, fatal: 0 }, reports: [report(key, at)], problems: [] });
    case 2: {
      // A new update of a report of the pool: a new key and a new sent time, thus a new id.
      const update = report(`u${index}`, at, at, { op: "update", references: [key] });
      return ownOrImported({ ...envelope("fetch", `fetch:${index}`, at), record: { source: API, at, took: 100, fresh: 1, fatal: 0 }, reports: [update], problems: [] });
    }
    case 3:
      return ownOrImported({ ...envelope("delivery", `delivery:k${index}`, at), delivery: delivery(`k${index}`, id, at) });
    case 4:
      return ownOrImported({ ...envelope(n % 2 === 0 ? "ended" : "back", `end:${index}`, at), source: API, reports: [id] });
    case 5:
      return { ...envelope("escalation", `escalation:${index}`, at), start: { incident: id, level: "life-safety", person: PERSON, at } };
    case 6:
      return ownOrImported({ ...envelope("escalation-end", `escalation-end:${index}`, at), end: { incident: id, person: PERSON, at } });
    case 7:
      return ownOrImported({ ...envelope("cancelled", `cancelled:${index}`, at), delivery: `k${index - n}` });
    case 8:
      return { ...envelope("clock", `clock:${index}`, at), size: [-5 * MINUTE, 5 * MINUTE, HOUR][n % 3]! };
    case 9: {
      // A retired event of an older build, with some reports of the pool.
      const reports = POOL.filter((_, place) => ((n >> place) & 1) === 1).map(idOf).sort();
      return { ...envelope("retired", `retired:${index}`, at), reports, until: at + (n + 1) * DAY, cancelled: [`k${index - n}`] };
    }
    case 10:
      return { ...envelope("mode", `mode:${index}`, at), source: API, mode: other ? "live" : "observe", reason: "a test" };
    case 11:
      return { ...envelope("hold", `hold:${index}`, at), hold: { incident: id, level: "life-safety", person: PERSON, episode: 0, at } };
    case 12:
      return {
        ...envelope("suppressed", `suppressed:${index}`, at),
        suppression: { key: `s${index}`, incident: id, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, episode: 0, at, reason: "same-level" },
      };
    case 13:
      return { ...envelope("exchange", `exchange:${index}`, at), peer: "b", log: "log-b", next: index };
    default:
      return { ...envelope("started", `started:${index}`, at), run: `run-${index}` };
  }
}

function stepsOf(context: FoldContext): fc.Arbitrary<Step<Live, Log>> {
  return STEP.map((drawn) =>
    step(`${drawn.choice}:${drawn.key}:${drawn.after}:${drawn.other ? "b" : "a"}:${drawn.n}`, (live, log) => {
      log.time += drawn.after;
      const event = eventOf(drawn, log);
      // A step of the clock moves the clock of the copy.
      if (event.type === "clock") log.time += event.size;
      append(live, log, event, context);
    }),
  );
}

// The times of entry of each report and end mark of a state.
function timesOf(state: RuntimeState, times: EntryTimes): unknown {
  return { reports: state.merge.reports.map((one) => [one.id, times.report(one)]), marks: state.merge.ends.map((one) => [one.report, one.at, times.mark(one)]) };
}

// The rebuild of the start: the index gets each event before the rebuild reads it, and each prune at its retirement.
function replay(events: readonly RuntimeEvent[], context: FoldContext): { readonly state: RuntimeState; readonly entries: EntryIndex } {
  const entries = entryIndex();
  function* read(): Generator<RuntimeEvent> {
    for (const event of events) {
      entries.add(event);
      yield event;
    }
  }
  return { state: rebuild(read(), context, (merge) => entries.prune(merge)), entries };
}

const EXPECTATION: Expectation = { id: "e1", from: API, to: OTHER, when: { kinds: ["met.flood"] } };
const CONTEXTS: readonly (readonly [string, FoldContext])[] = [
  ["the defaults", { sources: [], retention: {} }],
  ["a short retention and an expectation", { sources: [], retention: { horizon: DAY, quiet: 3 * HOUR, life: 2 * DAY, every: HOUR }, expectations: [EXPECTATION] }],
  ["no retention", { sources: [] }],
];

describe("the live fold and the rebuild of each prefix (AL-109)", () => {
  for (const [name, context] of CONTEXTS) {
    it.each(SEEDS)(`give the same state and the same times of entry, with ${name} (seed %i)`, (seed) => {
      let retirements = 0;
      runModel<Live, Log>({
        create: () => ({ sut: { state: EMPTY_RUNTIME, entries: entryIndex() }, model: { events: [], time: T0, count: 0 } }),
        steps: stepsOf(context),
        check: (live, log) => {
          const again = replay(log.events, context);
          expect(again.state).toEqual(live.state);
          expect(again.entries.size).toBe(live.entries.size);
          expect(timesOf(again.state, again.entries.times(again.state.own.merge))).toEqual(timesOf(live.state, live.entries.times(live.state.own.merge)));
          retirements += live.state.own.merge.retired.length;
        },
        maxSteps: 60,
        numRuns: 25,
        parameters: { seed },
      });
      // The logs are long enough that some reports retire.
      if (context.retention !== undefined) expect(retirements).toBeGreaterThan(0);
    });
  }
});
