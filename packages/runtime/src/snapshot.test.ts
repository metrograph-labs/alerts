import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  incidents,
  normalize,
  observationId,
  reportId,
  type FetchOutcome,
  type MergeState,
  type Observation,
  type ObservationId,
  type PlaceId,
  type Report,
  type ReportId,
  type SourceDescriptor,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import {
  BODY_TYPE,
  decodeFeed,
  feedBodies,
  GTFS_KIND,
  gtfsDescriptor,
  mapObservation,
  sourceIdOf,
  type FeedEntity,
  type FeedMessage,
  type GtfsFeed,
} from "@mark1russell7/alerts-source-gtfs-alerts";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./events.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";
import { snapshotStep, type SnapshotInput } from "./snapshot.ts";
import { rebuild } from "./state.ts";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIST = "list" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

function logPath(): string {
  const made = mkdtempSync(join(tmpdir(), "alerts-snapshot-"));
  folders.push(made);
  return join(made, "log.sqlite");
}

/** One row of a fake list: an event of a key, with its own observation. */
function row(key: string, fetched: number): Observation {
  return { id: `${LIST}:${key}` as ObservationId, source: LIST, fetched, contentType: "application/json", body: JSON.stringify({ key }), transport: { latency: 0 } };
}

function report(key: string, observation: Observation, extra: Partial<Report> = {}): Report {
  return {
    id: reportId({ source: LIST, key, sent: T0 }),
    source: LIST,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: `KTOP.TO.W.${key}` }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: observation.fetched,
    expires: T0 + DAY,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "KTOP",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: {},
    ...extra,
  };
}

const map = ({ observation }: { readonly observation: Observation }) => ({ reports: [report((JSON.parse(observation.body) as { key: string }).key, observation)], problems: [] });

function descriptor(listing: boolean): SourceDescriptor {
  return {
    id: LIST,
    title: "A fake list",
    origins: ["nws"],
    dependsOn: ["provider:list"],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10_000,
    auth: "none",
    ...(listing ? { listing: "snapshot" as const } : {}),
  };
}

/** One answer of the fake list: the keys of a complete list, a part of a list, or a failure. */
type Answer = { readonly keys: readonly string[]; readonly complete?: false; readonly asOf?: number } | "failure";

describe("snapshotStep", () => {
  const a = report("a", row("a", T0));
  const b = report("b", row("b", T0));
  const merge: MergeState = normalize({ reports: [a, b] });
  const step = (outcome: FetchOutcome, misses: ReadonlyMap<ReportId, number> = new Map(), state: MergeState = merge): ReturnType<typeof snapshotStep> => {
    const input: SnapshotInput = { source: LIST, started: T0 + MINUTE, ended: T0 + MINUTE + 300, outcome, merge: state, misses, limit: 2 };
    return snapshotStep(input);
  };
  const listed = (...keys: string[]): Extract<FetchOutcome, { ok: true }> => ({ ok: true, complete: true, observations: keys.map((key) => row(key, T0 + MINUTE)) });

  it("counts one miss for each live report that a complete list does not have, and ends it at the limit", () => {
    const first = step(listed("a"));
    expect(first.events).toEqual([]);
    expect([...first.misses]).toEqual([[b.id, 1]]);
    const second = step(listed("a"), first.misses);
    expect(second.events).toEqual([{ id: `ended:${LIST}:${T0 + MINUTE}`, at: new Date(T0 + MINUTE + 300).toISOString(), type: "ended", time: T0 + MINUTE + 300, source: LIST, reports: [b.id] }]);
    expect(second.misses.size).toBe(0);
  });

  it("counts nothing for a failed fetch or for a part of a list, and keeps the counts", () => {
    const misses = new Map([[b.id, 1]]);
    for (const outcome of [{ ok: false, failure: { kind: "server", message: "down" } }, { ...listed("a"), complete: false }] as const) {
      const result = step(outcome, misses);
      expect(result.events).toEqual([]);
      expect(result.misses).toBe(misses);
    }
  });

  it("starts the count again for a report that is in the list again before its end", () => {
    expect(step(listed("a", "b"), new Map([[b.id, 1]])).misses.size).toBe(0);
  });

  it("ends each report of an empty complete list, and no report of a different source", () => {
    const other = { ...report("c", row("c", T0)), source: "other" as SourceId };
    const result = step(listed(), new Map([[a.id, 1], [b.id, 1]]), normalize({ reports: [a, b, other] }));
    expect(result.events.flatMap((event) => event.reports)).toEqual([a.id, b.id].sort());
  });

  it("counts no miss for a report that is cancelled, expired or ended", () => {
    const cancel = report("x", row("x", T0), { op: "cancel" });
    const expired = report("y", row("y", T0), { expires: T0 + 1000 });
    const ended = normalize({ reports: [cancel, expired, b], ends: [{ report: b.id, at: T0, ended: true }] });
    const result = step(listed(), new Map(), ended);
    expect(result.events).toEqual([]);
    expect(result.misses.size).toBe(0);
  });

  it("gives a back event for an ended report in a complete list", () => {
    const ended = normalize({ reports: [a, b], ends: [{ report: b.id, at: T0, ended: true }] });
    const result = step(listed("a", "b"), new Map(), ended);
    expect(result.events.map((event) => [event.type, event.reports])).toEqual([["back", [b.id]]]);
  });

  describe("an old list", () => {
    // The report `c` is newer than `a` and `b`: its product came 10 minutes later.
    const c = report("c", row("c", T0 + MINUTE), { sent: T0 + 10 * MINUTE });
    const three = normalize({ reports: [a, b, c] });
    const at = (asOf: number, ...keys: string[]): FetchOutcome => ({ ...listed(...keys), asOf });

    it("counts no miss for a report that is newer than the list, and keeps its count", () => {
      const old = step(at(T0, "a", "b"), new Map([[c.id, 1]]), three);
      expect(old.events).toEqual([]);
      expect([...old.misses]).toEqual([[c.id, 1]]);
      expect([...step(at(T0, "a", "b"), new Map(), three).misses]).toEqual([]);
    });

    it("counts a miss for a report that is as old as the list or older", () => {
      expect([...step(at(T0 + 10 * MINUTE, "a", "b"), new Map(), three).misses]).toEqual([[c.id, 1]]);
      expect([...step(at(T0, "a"), new Map(), three).misses]).toEqual([[b.id, 1]]);
    });

    it("counts misses for an empty list with a time, because the time comes from each row of the nation", () => {
      const result = step(at(T0 + 10 * MINUTE), new Map([[a.id, 1]]), three);
      expect(result.events.flatMap((event) => event.reports)).toEqual([a.id]);
      expect([...result.misses].sort()).toEqual([[b.id, 1], [c.id, 1]].sort());
    });

    it("writes the time of the list in the ended event", () => {
      const [event] = step(at(T0 + 10 * MINUTE, "a", "c"), new Map([[b.id, 1]]), three).events;
      expect(event).toMatchObject({ type: "ended", reports: [b.id], asOf: T0 + 10 * MINUTE });
    });

    it("gives no back event for a list that is not newer than the list that ended the report", () => {
      const ends = (asOf?: number) => normalize({ reports: [a, b, c], ends: [{ report: b.id, at: T0, ended: true, ...(asOf === undefined ? {} : { asOf }) }] });
      const backs = (outcome: FetchOutcome, state: MergeState) => step(outcome, new Map(), state).events.filter((event) => event.type === "back");
      expect(backs(at(T0, "a", "b"), ends(T0 + 10 * MINUTE))).toEqual([]);
      expect(backs(at(T0 + 10 * MINUTE, "a", "b", "c"), ends(T0 + 10 * MINUTE))).toEqual([]);
      expect(backs(at(T0 + 11 * MINUTE, "a", "b", "c"), ends(T0 + 10 * MINUTE)).map((event) => event.reports)).toEqual([[b.id]]);
      // An end or a list with no time keeps the rule of a current list.
      expect(backs(at(T0, "a", "b"), ends()).map((event) => event.reports)).toEqual([[b.id]]);
      expect(backs(listed("a", "b"), ends(T0 + 10 * MINUTE)).map((event) => event.reports)).toEqual([[b.id]]);
    });
  });
});

describe("a snapshot source in the runtime", () => {
  /** This function gives the answers to the runtime, one fetch for each minute, and restarts the runtime before the answer at `restartAt`. */
  async function run(answers: readonly Answer[], listing: boolean, restartAt?: number) {
    const clock = fakeWallClock(T0);
    let fetches = 0;
    const source: SourceProcedures = {
      describe: () => descriptor(listing),
      async fetch() {
        const answer = answers[Math.min(fetches++, answers.length - 1)]!;
        if (answer === "failure") return { ok: false, failure: { kind: "server", message: "The fake list failed." } };
        return { ok: true, complete: answer.complete ?? true, observations: answer.keys.map((key) => row(key, clock.now())), ...(answer.asOf === undefined ? {} : { asOf: answer.asOf }) };
      },
      map,
    };
    const path = logPath();
    let log = openRuntimeLog(path);
    // The count of the write transactions: each call of `appendAll` is one transaction of the log.
    let writes = 0;
    const counted = (target: RuntimeLog): RuntimeLog =>
      new Proxy(target, { get: (object, key) => (key === "appendAll" ? (...args: Parameters<RuntimeLog["appendAll"]>) => ((writes += 1), object.appendAll(...args)) : Reflect.get(object, key)) });
    const open = (name: string) => openRuntime({ log: counted(log), clock, sources: [source], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: name });
    let runtime = open("run-0");
    const live: Record<string, boolean>[] = [];
    // The guard stops a pass that fetches nothing, so a fault fails the test and does not hang it.
    for (let guard = 0; fetches < answers.length; guard += 1) {
      if (guard >= 10 * answers.length) throw new Error(`The runtime made ${String(fetches)} of ${String(answers.length)} fetches.`);
      if (fetches === restartAt) {
        log.close();
        log = openRuntimeLog(path);
        runtime = open("run-1");
        restartAt = undefined;
      }
      const before = fetches;
      const pass = await runtime.pass();
      if (fetches > before) live.push(Object.fromEntries(pass.view.incidents.map((incident) => [incident.reports.length === 1 ? keyOf(incident.anchor) : "many", incident.live])));
      await clock.advance(MINUTE);
    }
    const events = [...log.read()];
    const state = runtime.state();
    expect(rebuild(events, runtime.config)).toEqual(state);
    log.close();
    return { events, live, state, writes };
  }
  const ids = { a: report("a", row("a", T0)).id, b: report("b", row("b", T0)).id };
  const keyOf = (id: ReportId): string => (id === ids.a ? "a" : id === ids.b ? "b" : id);
  const ends = (events: readonly RuntimeEvent[]) => events.flatMap((event) => (event.type === "ended" || event.type === "back" ? [[event.type, event.reports.map(keyOf)]] : []));

  const ANSWERS: readonly Answer[] = [
    { keys: ["a", "b"] },
    { keys: ["a"] }, // b: one miss
    { keys: ["a"], complete: false }, // a part of a list: no count
    "failure", // no count
    { keys: ["a"] }, // b: two misses, thus the end
    { keys: ["a", "b"] }, // b is back
    { keys: [] }, // a and b: one miss
  ];

  it("ends a report after two complete lists with no row of it, and makes it live when it is back", async () => {
    const { events, live } = await run(ANSWERS, true);
    expect(ends(events)).toEqual([
      ["ended", ["b"]],
      ["back", ["b"]],
    ]);
    expect(live.map((row) => row["b"])).toEqual([true, true, true, true, false, true, true]);
    expect(live.every((row) => row["a"] === true)).toBe(true);
  });

  it("writes no transaction for a complete list that ends nothing and brings nothing back", async () => {
    // The lists count one miss of `b` and then have `b` again: no end and no back event.
    const answers: readonly Answer[] = [{ keys: ["a", "b"] }, { keys: ["a"] }, { keys: ["a", "b"] }, { keys: ["a", "b"] }];
    const snapshot = await run(answers, true);
    const plain = await run(answers, false);
    expect(ends(snapshot.events)).toEqual([]);
    expect(snapshot.writes).toBe(plain.writes);
  });

  it("ends nothing for a source that is not a snapshot", async () => {
    const { events, state } = await run([...ANSWERS, { keys: [] }, { keys: [] }], false);
    expect(ends(events)).toEqual([]);
    expect(state.merge.ends).toEqual([]);
  });

  it("starts the counts at 0 after a restart, thus the end comes later and not sooner", async () => {
    const answers: readonly Answer[] = [{ keys: ["a", "b"] }, { keys: ["a"] }, { keys: ["a"] }, { keys: ["a"] }];
    expect(ends((await run(answers, true)).events)).toEqual([["ended", ["b"]]]);
    // The restart comes after the first miss. The end needs two more misses.
    const restarted = await run(answers, true, 2);
    const ended = restarted.events.filter((event) => event.type === "ended");
    expect(ended.map((event) => event.time)).toEqual([T0 + 3 * MINUTE]);
    expect(ends(restarted.events)).toEqual([["ended", ["b"]]]);
  });

  it("ends each report of a list that is empty and complete two times", async () => {
    const { events, live } = await run([{ keys: ["a", "b"] }, { keys: [] }, { keys: [] }], true);
    expect(ends(events)).toEqual([["ended", [ids.a, ids.b].sort().map(keyOf)]]);
    expect([live.at(-1)?.["a"], live.at(-1)?.["b"]]).toEqual([false, false]);
  });

  it("ends no report for an old list, and gives no back event for an old list after an end, also after a restart", async () => {
    // `a` and `b` have the product time T0. The true lists have the time T0 + 5 minutes: a newer product of a
    // different place. The old list has the time T0 - 5 minutes, before the products of `a` and `b`.
    const NEW = T0 + 5 * MINUTE;
    const OLD = T0 - 5 * MINUTE;
    const answers: readonly Answer[] = [
      { keys: ["a", "b"], asOf: NEW },
      { keys: [], asOf: OLD }, // an old list: no count
      { keys: [], asOf: OLD }, // an old list again: no count
      { keys: ["a"], asOf: NEW }, // b: one miss
      { keys: ["a"], asOf: NEW }, // b: two misses, thus the end
      { keys: ["a", "b"], asOf: NEW }, // the same time as the list of the end: no back
      { keys: ["a", "b"], asOf: OLD }, // an old list: no back
      { keys: ["a"], asOf: NEW + MINUTE }, // a newer list without b
    ];
    for (const restartAt of [undefined, 5]) {
      const { events, live } = await run(answers, true, restartAt);
      expect(ends(events)).toEqual([["ended", ["b"]]]);
      expect(events.find((event) => event.type === "ended")).toMatchObject({ time: T0 + 4 * MINUTE, asOf: NEW });
      expect(live.map((row) => row["b"])).toEqual([true, true, true, true, false, false, false, false]);
      expect(live.every((row) => row["a"] === true)).toBe(true);
    }
  });

  it("gives a back event for a list that is newer than the list of the end", async () => {
    const answers: readonly Answer[] = [{ keys: ["a", "b"], asOf: T0 }, { keys: ["a"], asOf: T0 }, { keys: ["a"], asOf: T0 }, { keys: ["a", "b"], asOf: T0 + MINUTE }];
    expect(ends((await run(answers, true)).events)).toEqual([["ended", ["b"]], ["back", ["b"]]]);
  });

  it("keeps the incidents of a report with a mark after the time of a view", async () => {
    const { state } = await run([{ keys: ["a", "b"] }, { keys: ["a"] }, { keys: ["a"] }], true);
    const [mark] = state.merge.ends;
    expect(mark).toMatchObject({ report: ids.b, ended: true });
    const liveOfB = (at: number) => incidents(state.merge, at).find((incident) => incident.reports.includes(ids.b))?.live;
    expect(liveOfB(mark!.at - 1)).toBe(true);
    expect(liveOfB(mark!.at)).toBe(false);
  });
});

describe("a transit feed that moves its ends, in the runtime (AL-75)", () => {
  const HOUR = 60 * MINUTE;
  const RUTER = decodeFeed(readFileSync(new URL("../../source-gtfs-alerts/fixtures/ruter-20261118T0358Z.pb", import.meta.url)));
  const RUTER_AT = Date.parse("2026-11-18T03:58:18Z");
  const FEED: GtfsFeed = { id: "mdb-1799", title: "Ruter", url: "https://transit.example.test/ruter", origin: "ruter", box: { west: 10.2, south: 59.6, east: 11.4, north: 60.2 } };
  // A public place: the center of Oslo.
  const OSLO: WatchedPlace = { id: "place:a" as PlaceId, codes: [], at: [10.75, 59.91], bufferKm: 0 };

  /** This function gives the feed at a time. As real feeds do, the feed moves its own time and each end that is to come. */
  function feedAt(fetched: number, text: string): FeedMessage {
    const by = (fetched - RUTER_AT) / 1000;
    const entity = (RUTER.entity ?? []).map((each) =>
      each.alert?.activePeriod === undefined
        ? each
        : { ...each, alert: { ...each.alert, activePeriod: each.alert.activePeriod.map((range) => (range.end !== undefined && range.end * 1000 >= RUTER_AT ? { ...range, end: range.end + by } : range)) } },
    );
    // An alert with a rolling end: two hours after each fetch.
    const rolling: FeedEntity = { id: "rolling", alert: { activePeriod: [{ start: Date.parse("2026-11-17T00:00:00Z") / 1000, end: Math.floor(fetched / 1000) + 7_172 }], headerText: { translation: [{ text }] } } };
    const header = RUTER.header?.timestamp === undefined ? RUTER.header : { ...RUTER.header, timestamp: RUTER.header.timestamp + by };
    return { ...RUTER, ...(header === undefined ? {} : { header }), entity: [...entity, rolling] };
  }

  it("appends no observation and no report for an alert with no change, and does not end or retire it", async () => {
    const source = sourceIdOf(FEED);
    const clock = fakeWallClock(RUTER_AT);
    let text = "Buses take a detour.";
    const procedures: SourceProcedures = {
      describe: () => gtfsDescriptor(FEED),
      // The fetch gives the bodies of the feed as the fetch of the source gives them, with no request. The tests of the source cover the request.
      async fetch() {
        const fetched = clock.now();
        const { bodies, complete, asOf } = feedBodies(FEED, feedAt(fetched, text), fetched);
        const observations = bodies.map((body): Observation => ({ id: observationId({ source, contentType: BODY_TYPE, url: FEED.url, body }), source, fetched, contentType: BODY_TYPE, body, transport: { latency: 0 } }));
        return { ok: true, observations, complete, ...(asOf === undefined ? {} : { asOf }) };
      },
      map: ({ observation }) => mapObservation(FEED, observation),
    };
    const log = openRuntimeLog(":memory:");
    const view: RuntimeOptions["view"] = { ...VIEW, places: [OSLO], kinds: [GTFS_KIND] };
    const runtime = openRuntime({ log, clock, sources: [procedures], watch: () => ({ places: [OSLO], kinds: [GTFS_KIND] }), view, run: "run-0", retention: { horizon: 2 * HOUR, life: 6 * HOUR, every: HOUR } });
    const count = (type: RuntimeEvent["type"]) => [...log.read()].filter((event) => event.type === type).length;
    const alerts = () => [...log.read()].filter((event) => event.type === "observation" && (JSON.parse(event.observation.body) as { type: string }).type === "alert").length;
    const reports = () => runtime.state().own.merge.reports.filter((report) => report.source === source);

    await runtime.pass();
    const first = reports().map((report) => report.id);
    expect(first).toHaveLength(60);
    expect(alerts()).toBe(60);
    // Five minutes later, each end moved. No alert gives a new observation, thus no report is new.
    await clock.advance(5 * MINUTE);
    await runtime.pass();
    expect(count("fetch")).toBe(2);
    expect(alerts()).toBe(60);
    expect(reports().map((report) => report.id)).toEqual(first);
    // Past the horizon of the retention, each alert is still in the feed. Nothing ends it and nothing retires it.
    await clock.advance(3 * HOUR);
    await runtime.pass();
    expect([count("fetch"), count("ended"), count("retired")]).toEqual([3, 0, 0]);
    expect(reports().map((report) => report.id)).toEqual(first);
    // A changed text is one new observation, and a new version of its key.
    text = "Buses take a detour until noon.";
    await clock.advance(5 * MINUTE);
    await runtime.pass();
    expect(alerts()).toBe(61);
    expect(reports().filter((report) => !first.includes(report.id)).map((report) => report.key)).toEqual(["rolling"]);
    log.close();
  });
});
