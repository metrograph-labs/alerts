import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { reportId, type ChannelId, type ChannelProcedures, type ChannelQuota, type Expectation, LOOP_BLOCK_WINDOW, type LoopBlock, type FetchOutcome, type FetchSignal, type Observation, type ObservationId, type PlaceId, type Report, type SourceDescriptor, type SourceId, type SourceProcedures, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { openFoldSnapshot, type FoldSnapshot } from "@mark1russell7/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { balanceWatch, type BalanceReading } from "./balance.ts";
import { limitWatch, type UseReading } from "./use.ts";
import { FOLD_TYPES, type RuntimeEvent } from "./events.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type Pass, type RuntimeOptions } from "./runtime.ts";
import type { StartRead } from "./start-snapshot.ts";
import { rebuild, type RuntimeState } from "./state.ts";
import type { ViewConfig } from "./view.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const API = "api" as SourceId;
const WEA = "wea" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

// The second source carries each warning of the first source that has the parameter WEAHandling.
const EXPECT: Expectation = { id: "api-to-wea", from: API, to: WEA, when: { statuses: ["actual"], parameters: ["WEAHandling"] } };

const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [EXPECT], delay: { quantile: 0.9, level: 0.9 } };

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "alerts-runtime-"));
  folders.push(made);
  return made;
}

function descriptor(id: SourceId, interval: number, maxQuiet?: number): SourceDescriptor {
  return {
    id,
    title: `The source ${id}`,
    origins: ["nws"],
    dependsOn: [`provider:${id}`],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval,
    slowAfter: 10_000,
    ...(maxQuiet === undefined ? {} : { maxQuiet }),
    auth: "none",
  };
}

function report(source: SourceId, key: string, issued: number, observation: Observation): Report {
  return {
    id: reportId({ source, key, sent: issued }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: key }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: issued,
    received: observation.fetched,
    expires: issued + 45 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: source === API ? { WEAHandling: ["Imminent Threat"] } : {},
  };
}

function observation(source: SourceId, key: string, fetched: number, body: unknown): Observation {
  return { id: `${source}:${key}` as ObservationId, source, fetched, contentType: "application/json", body: JSON.stringify(body), transport: { latency: 0 } };
}

// The map of the fake sources. A body with `broken` gives a fatal problem and no report.
function map({ observation: seen }: { readonly observation: Observation }) {
  const body = JSON.parse(seen.body) as { readonly key: string; readonly issued: number; readonly broken?: boolean };
  if (body.broken === true) return { reports: [], problems: [{ path: "properties", message: "The body has no properties.", fatal: true }] };
  return { reports: [report(seen.source, body.key, body.issued, seen)], problems: [] };
}

/** One warning of a world: its time on the API, its time on WEA (absent: WEA does not carry it), and a body that the map cannot read. */
interface Warning {
  readonly key: string;
  readonly issued: number;
  readonly carried?: number;
  readonly broken: boolean;
}

function warningsOf(seed: number): Warning[] {
  const r = random(seed).fork("warnings");
  const list: Warning[] = [];
  let at = T0;
  for (let n = 0; n < 14; n++) {
    at += r.int(1, 9) * MINUTE + r.int(0, 59) * 1000;
    const carried = r.chance(0.8) ? at + r.int(10, 400) * 1000 : undefined;
    list.push({ key: `w${n}`, issued: at, ...(carried === undefined ? {} : { carried }), broken: r.chance(0.1) });
  }
  return list;
}

/**
 * This function makes a fake source of a world. Its outcome is a function of the seed and the time of the
 * fetch only. Thus a run after a restart gets the same outcome at the same time.
 */
function worldSource(id: SourceId, interval: number, seed: number, warnings: readonly Warning[], clock: WallClock, maxQuiet?: number): SourceProcedures {
  const timeOf = (warning: Warning) => (id === API ? warning.issued : warning.carried);
  return {
    describe: () => descriptor(id, interval, maxQuiet),
    async fetch({ cursor }): Promise<FetchOutcome> {
      const at = clock.now();
      const r = random(`${seed}:${id}:${at}`);
      if (r.chance(0.15)) return { ok: false, failure: { kind: "server", message: "The fake server failed." } };
      // Each fetch gives the warnings of the last 30 minutes, thus most of its observations repeat.
      const observations = warnings
        .filter((warning) => {
          const time = timeOf(warning);
          return time !== undefined && time <= at && time > at - 30 * MINUTE;
        })
        .map((warning) => observation(id, warning.key, at, { key: warning.key, issued: warning.issued, broken: warning.broken }));
      return { ok: true, observations, complete: true, cursor: { seen: String(at), before: cursor?.["seen"] ?? "" } };
    },
    map,
  };
}

// The events of the work of a run. The start of each run is not work.
const isWork = (event: RuntimeEvent): boolean => event.type !== "started";

/** The process stops at an event of the log: the write of the event does not end. */
class Crash extends Error {}

// A log that stops the process before the event at the position `at`. After the stop, each write throws, as in a process that is gone.
function crashing(inner: RuntimeLog, at: number): RuntimeLog {
  let accepted = 0;
  let gone = false;
  return {
    read: (types, after) => inner.read(types, after),
    has: (id) => inner.has(id),
    get: (id) => inner.get(id),
    entries: (options) => inner.entries(options),
    count: () => inner.count(),
    counts: () => inner.counts(),
    head: () => inner.head(),
    close: () => inner.close(),
    appendAll(events, accept) {
      if (gone) throw new Crash("The process is gone.");
      return inner.appendAll(events, (event) => {
        if (accepted === at) {
          gone = true;
          throw new Crash(`The process stopped at the event ${event.id}.`);
        }
        accepted += 1;
        accept(event);
      });
    },
  };
}

interface WorldRun {
  readonly state: RuntimeState;
  readonly config: ViewConfig;
  readonly events: readonly RuntimeEvent[];
  readonly passes: readonly Pass[];
  readonly restarts: number;
  /** The read of the log at each open of a runtime. */
  readonly starts: readonly StartRead[];
}

// The count of the passes between two writes of the snapshot of the start in a world with a store of the snapshot.
const SNAPSHOT_PASSES = 10;

/**
 * This function runs a world for two hours. With `cutAt`, the process stops at that event, and a new runtime opens the file again.
 * With `snapshot`, each runtime reads the snapshot of the start at its open, and it writes it after each `SNAPSHOT_PASSES` passes.
 */
async function runWorld(seed: number, path: string, cutAt?: number, snapshot?: FoldSnapshot): Promise<WorldRun> {
  const warnings = warningsOf(seed);
  const clock = fakeWallClock(T0);
  const sources = [worldSource(API, MINUTE, seed, warnings, clock), worldSource(WEA, 2 * MINUTE, seed, warnings, clock, 20 * MINUTE)];
  const options = (log: RuntimeLog, run: string): RuntimeOptions => ({ log, clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, ...(snapshot === undefined ? {} : { startSnapshot: snapshot }) });
  const end = T0 + 120 * MINUTE;
  let log = openRuntimeLog(path);
  let runtime = openRuntime(options(cutAt === undefined ? log : crashing(log, cutAt), "run-0"));
  let restarts = 0;
  const passes: Pass[] = [];
  const starts: StartRead[] = [runtime.start];
  while (clock.now() < end) {
    let pass: Pass;
    try {
      pass = await runtime.pass();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      // The restart is at the same time: the clock does not move while the process is down.
      log.close();
      log = openRuntimeLog(path);
      restarts += 1;
      runtime = openRuntime(options(log, `run-${restarts}`));
      starts.push(runtime.start);
      continue;
    }
    passes.push(pass);
    if (snapshot !== undefined && passes.length % SNAPSHOT_PASSES === 0) await runtime.writeStartSnapshot();
    await clock.advance(Math.max(1, Math.min(pass.wakeAt ?? end, end) - clock.now()));
  }
  const events = [...log.read()];
  log.close();
  return { state: runtime.state(), config: runtime.config, events, passes, restarts, starts };
}

describe("a restart of the runtime", () => {
  it("rebuilds from the log the state of a run with no cut, for a cut at a random event", async () => {
    let systemReports = 0;
    let failures = 0;
    let fatal = 0;
    let carried = 0;
    for (const seed of SEEDS) {
      const label = `seed ${seed} (SEED=${seed} repeats it)`;
      const place = folder();
      const whole = await runWorld(seed, join(place, "whole.sqlite"));
      // The fold of each event equals the rebuild of the whole log.
      expect(rebuild(whole.events, whole.config), label).toEqual(whole.state);

      const cutAt = random(seed).fork("cut").int(1, whole.events.length - 1);
      const cut = await runWorld(seed, join(place, "cut.sqlite"), cutAt);
      expect(cut.restarts, label).toBe(1);
      expect(cut.state, `${label}, cut at the event ${cutAt}`).toEqual(whole.state);
      expect(rebuild(cut.events, cut.config), label).toEqual(cut.state);
      // A restart adds its start to the log, and nothing else: each fetch and each system step is the same.
      expect(cut.events.filter(isWork), label).toEqual(whole.events.filter(isWork));

      systemReports += whole.state.lines.count;
      failures += whole.events.filter((event) => event.type === "fetch" && event.record.failure !== undefined).length;
      fatal += whole.events.filter((event) => event.type === "fetch" && event.record.fatal > 0).length;
      carried += whole.state.merge.reports.filter((entry) => entry.source === WEA).length;
    }
    // The worlds hold each part of the fold: failed fetches, fatal problems, carriages and system reports.
    expect(failures).toBeGreaterThan(0);
    expect(fatal).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(0);
    expect(systemReports).toBeGreaterThan(0);
  }, 120_000);
});

describe("a restart from the snapshot of the start (AL-105)", () => {
  it("reads the snapshot, folds only the events after it, and gives the state of a run with no cut", async () => {
    for (const seed of SEEDS) {
      const label = `seed ${seed} (SEED=${seed} repeats it)`;
      const place = folder();
      const whole = await runWorld(seed, join(place, "whole.sqlite"));
      // A cut in the second half of the log: the first runtime wrote some snapshots before it.
      const cutAt = random(seed).fork("snapshot cut").int(Math.floor(whole.events.length / 2), whole.events.length - 1);
      const store = openFoldSnapshot(join(place, "snapshot.sqlite"));
      try {
        const cut = await runWorld(seed, join(place, "cut.sqlite"), cutAt, store);
        expect(cut.restarts, label).toBe(1);
        // The first start had no snapshot. The restart read one, and it folded only a part of the log.
        expect(cut.starts[0], label).toEqual({ events: 0 });
        const restart = cut.starts[1];
        expect(restart?.snapshot, label).toBeDefined();
        expect(restart?.fault, label).toBeUndefined();
        expect(restart?.events ?? Infinity, label).toBeLessThan(cutAt);
        expect(cut.state, `${label}, cut at the event ${cutAt}`).toEqual(whole.state);
        expect(rebuild(cut.events, cut.config), label).toEqual(cut.state);
      } finally {
        store.close();
      }
    }
  }, 120_000);

  it("folds the whole log when the snapshot has another key, and writes no snapshot with no store", async () => {
    const place = folder();
    const path = join(place, "runtime.sqlite");
    const store = openFoldSnapshot(join(place, "snapshot.sqlite"));
    const clock = fakeWallClock(T0);
    const options = (log: RuntimeLog, extra: Partial<RuntimeOptions> = {}, withStore = true): RuntimeOptions => ({ log, clock, sources: [], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", ...(withStore ? { startSnapshot: store } : {}), ...extra });
    // The count of the events of the fold in the log.
    const folded = (log: RuntimeLog): number => [...log.read(FOLD_TYPES)].length;
    try {
      let log = openRuntimeLog(path);
      const first = openRuntime(options(log));
      await first.pass();
      await clock.advance(MINUTE);
      await first.pass();
      expect(await first.writeStartSnapshot()).toBeGreaterThan(0);
      expect(first.eventsAfterSnapshot()).toBe(0);
      const state = first.state();
      log.close();

      log = openRuntimeLog(path);
      const head = log.head();
      // The same configuration: the start reads the snapshot at the last event, and it folds no event. Each open adds its start event.
      const same = openRuntime(options(log));
      expect(same.start).toEqual({ events: 0, snapshot: { seq: head, id: expect.any(String) } });
      expect(rebuild(log.read(FOLD_TYPES), same.config)).toEqual(same.state());
      expect(rebuild(log.read(FOLD_TYPES, head), same.config, undefined, state)).toEqual(same.state());
      // A different retention gives a different key: the start folds the whole log.
      let count = folded(log);
      const other = openRuntime(options(log, { retention: { horizon: 24 * 60 * MINUTE } }));
      expect(other.start).toEqual({ events: count });
      // No store: the start folds the whole log, and a write throws.
      count = folded(log);
      const none = openRuntime(options(log, {}, false));
      expect(none.start).toEqual({ events: count });
      await expect(none.writeStartSnapshot()).rejects.toThrow("no store");
      expect(none.eventsAfterSnapshot()).toBe(log.head());
      log.close();
    } finally {
      store.close();
    }
  });

  it("writes one cut of the state when passes add events in the pauses of the write (AL-115)", async () => {
    const place = folder();
    const path = join(place, "runtime.sqlite");
    const store = openFoldSnapshot(join(place, "snapshot.sqlite"));
    const clock = fakeWallClock(T0);
    const seed = SEEDS[0]!;
    const sources = [worldSource(API, MINUTE, seed, warningsOf(seed), clock)];
    const options = (log: RuntimeLog): RuntimeOptions => ({ log, clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", startSnapshot: store });
    try {
      let log = openRuntimeLog(path);
      const runtime = openRuntime(options(log));
      for (let at = 0; at < 20; at += 1) {
        await runtime.pass();
        await clock.advance(MINUTE);
      }
      const head = log.head();
      let pauses = 0;
      // Each pause of the write does one more pass. Thus the log and the state change in the write.
      const pause = async (): Promise<void> => {
        pauses += 1;
        await clock.advance(MINUTE);
        await runtime.pass();
      };
      const writing = runtime.writeStartSnapshot({ rows: 3, pause });
      // One write at a time: a second write in the write rejects, and the first write continues.
      await expect(runtime.writeStartSnapshot()).rejects.toThrow("in progress");
      expect(await writing).toBeGreaterThan(0);
      expect(pauses).toBeGreaterThan(2);
      expect(log.head()).toBeGreaterThan(head);
      expect(runtime.eventsAfterSnapshot()).toBe(log.head() - head);
      await runtime.close();
      log.close();

      // The snapshot has the mark at the start of the write. The next start folds the events after it, and it gets the state of the whole log.
      log = openRuntimeLog(path);
      const again = openRuntime(options(log));
      expect(again.start.snapshot?.seq).toBe(head);
      expect(again.start.events).toBeGreaterThan(0);
      expect(again.state()).toEqual(rebuild(log.read(FOLD_TYPES), again.config));
      await again.close();
      log.close();
    } finally {
      store.close();
    }
  });

  it("waits for a write of the snapshot in progress at its close (AL-115)", async () => {
    const place = folder();
    const log = openRuntimeLog(join(place, "runtime.sqlite"));
    const store = openFoldSnapshot(join(place, "snapshot.sqlite"));
    const clock = fakeWallClock(T0);
    try {
      const runtime = openRuntime({ log, clock, sources: [], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", startSnapshot: store });
      await runtime.pass();
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const writing = runtime.writeStartSnapshot({ rows: 1, pause: () => held });
      let closed = false;
      const closing = runtime.close().then(() => (closed = true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed).toBe(false);
      release();
      expect(await writing).toBeGreaterThan(0);
      await closing;
      expect(closed).toBe(true);
      // A write after the close has no store, thus it rejects.
      await expect(runtime.writeStartSnapshot()).rejects.toThrow("closed");
    } finally {
      store.close();
      log.close();
    }
  });
});

describe("one pass of the runtime", () => {
  // A source with a fetch of the test.
  function scripted(id: SourceId, fetch: SourceProcedures["fetch"]): SourceProcedures {
    return { describe: () => descriptor(id, MINUTE), fetch, map };
  }

  function open(sources: readonly SourceProcedures[], extra: Partial<RuntimeOptions> = {}) {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", ...extra });
      return { clock, log, runtime };
    } catch (error) {
      log.close();
      throw error;
    }
  }

  it("keeps each open line of a quota when the read of the quotas throws, and ends the lines when the quotas have no stage", async () => {
    let read = (): readonly ChannelQuota[] => [{ channel: "pushover" as ChannelId, limit: 100, reserve: 10, used: 95 }];
    // With no source, the pass also opens a line of the coverage. The test reads only the lines of the quota.
    const quotaReports = (pass: Pass) => pass.view.step.reports.filter((report) => report.kind.code.startsWith("system.quota.")).map((report) => [report.op, report.kind.code]);
    const { runtime, log } = open([], { quotas: () => read() });
    expect(quotaReports(await runtime.pass())).toEqual([
      ["alert", "system.quota.low"],
      ["alert", "system.quota.reserve"],
    ]);
    read = () => {
      throw new Error("The disk is full.");
    };
    expect(quotaReports(await runtime.pass())).toEqual([]);
    expect(Object.keys(runtime.state().lines.open).filter((name) => name.startsWith("quota/"))).toEqual(["quota/pushover/low", "quota/pushover/reserve"]);
    read = () => [];
    expect(quotaReports(await runtime.pass())).toEqual([
      ["cancel", "system.quota.low"],
      ["cancel", "system.quota.reserve"],
    ]);
    log.close();
  });

  it("writes each new block of the event loop into the log, opens its line, and wakes at the end of its window (AL-88)", async () => {
    let blocks: readonly LoopBlock[] = [];
    const loopReports = (pass: Pass) => pass.view.step.reports.filter((report) => report.kind.code === "system.loop.block").map((report) => report.op);
    const { clock, runtime, log } = open([], { blocks: () => blocks });
    expect(loopReports(await runtime.pass())).toEqual([]);
    blocks = [{ at: clock.now() - 3_000, size: 2_400 }];
    const first = await runtime.pass();
    expect(loopReports(first)).toEqual(["alert"]);
    expect(first.view.step.reports.find((report) => report.kind.code === "system.loop.block")?.headline).toBe("The event loop of the runtime was blocked for 2.4 s.");
    expect(runtime.state().blocks).toEqual(blocks);
    expect(first.wakeAt).toBeLessThanOrEqual(blocks[0]!.at + LOOP_BLOCK_WINDOW);
    // The next pass gets the same block again. The log has it, thus the pass writes nothing.
    expect(loopReports(await runtime.pass())).toEqual([]);
    expect([...log.read(["loop"])].map((event) => event.time)).toEqual([blocks[0]!.at]);
    // A read that throws writes no block, and the pass goes on.
    blocks = [];
    const failing = (): readonly LoopBlock[] => {
      throw new Error("The watch stopped.");
    };
    const second = open([], { blocks: failing });
    expect(loopReports(await second.runtime.pass())).toEqual([]);
    second.log.close();
    await clock.advance(LOOP_BLOCK_WINDOW);
    expect(loopReports(await runtime.pass())).toEqual(["cancel"]);
    expect(rebuild(log.read(), { sources: [] }).blocks).toEqual(runtime.state().blocks);
    log.close();
  });

  it("checks each balance watch in each pass, gives its lines, and wakes for the next read and for its unread line (AL-42)", async () => {
    let answer: BalanceReading = { ok: true, balance: 2, currency: "USD" };
    let reads = 0;
    const read = async (): Promise<BalanceReading> => {
      reads += 1;
      return answer;
    };
    const watch = balanceWatch({ provider: "provider:twilio", title: "Twilio", channels: ["twilio-call" as ChannelId], floors: [5], read, every: 60_000, retry: 60_000, maxAge: 150_000 });
    const balanceReports = (pass: Pass) => pass.view.step.reports.filter((report) => report.kind.code.startsWith("system.balance.")).map((report) => [report.op, report.kind.code]);
    const { clock, runtime, log } = open([], { balances: [watch] });
    const first = await runtime.pass();
    expect(balanceReports(first)).toEqual([["alert", "system.balance.low"]]);
    expect(first.wakeAt).toBe(T0 + 60_000);
    answer = { ok: false, message: "The network is down." };
    await clock.advance(60_000);
    expect(balanceReports(await runtime.pass())).toEqual([]);
    await clock.advance(60_000);
    const failing = await runtime.pass();
    // The unread line starts at the maximum age after the last read, before the next retry.
    expect(failing.wakeAt).toBe(T0 + 150_000);
    await clock.advance(30_000);
    expect(balanceReports(await runtime.pass())).toEqual([["alert", "system.balance.unread"]]);
    answer = { ok: true, balance: 20, currency: "USD" };
    await clock.advance(30_000);
    expect(balanceReports(await runtime.pass())).toEqual([
      ["cancel", "system.balance.low"],
      ["cancel", "system.balance.unread"],
    ]);
    expect(reads).toBe(4);
    expect(() => open([], { balances: [watch, watch] })).toThrow("the same provider");
    log.close();
  });

  it("checks each watch of a limit in each pass, gives one line for each level, and wakes for its first read (AL-111)", async () => {
    let answer: UseReading = { ok: true, month: "2026-11", used: 8, limit: 10, currency: "USD", levels: [0.5, 0.8, 1], level: 0.8 };
    let reads = 0;
    const read = async (): Promise<UseReading> => {
      reads += 1;
      return answer;
    };
    const watch = limitWatch({ id: "github:example/actions", provider: "provider:github", title: "GitHub Actions", read, delay: 60_000, every: 60_000 });
    const useReports = (pass: Pass) => pass.view.step.reports.filter((report) => report.kind.code.startsWith("system.use.")).map((report) => [report.op, report.parameters["level"]?.[0]]);
    const { clock, runtime, log } = open([], { uses: [watch] });
    const first = await runtime.pass();
    // The first pass does not read. It wakes at the first read.
    expect(useReports(first)).toEqual([]);
    expect(first.wakeAt).toBe(T0 + 60_000);
    await clock.advance(60_000);
    expect(useReports(await runtime.pass())).toEqual([
      ["alert", "0.5"],
      ["alert", "0.8"],
    ]);
    answer = { ...answer, used: 9 };
    await clock.advance(60_000);
    expect(useReports(await runtime.pass())).toEqual([]);
    expect(reads).toBe(2);
    expect(() => open([], { uses: [watch, watch] })).toThrow("the same id");
    log.close();
  });

  it("records a timeout when a fetch takes longer than its limit, and ends the pass", async () => {
    const { clock, runtime, log } = open([scripted(API, () => new Promise<FetchOutcome>(() => undefined))], { fetchLimit: () => 5_000 });
    const running = runtime.pass();
    await clock.advance(5_000);
    const pass = await running;
    expect(pass.fetched).toEqual([API]);
    expect(runtime.state().health[API]?.lastFailure?.failure.kind).toBe("timeout");
    log.close();
  });

  // The fetches of the log, by source and outcome.
  const fetchesOf = (log: RuntimeLog): string[] =>
    [...log.read()].flatMap((event) => (event.type === "fetch" ? [`${event.record.source} ${event.record.failure?.kind ?? "ok"}`] : []));

  it("aborts the signal of a fetch at its limit, and the outcome stays one timeout of the source (AL-39)", async () => {
    let seen: FetchSignal | undefined;
    const hanging = scripted(API, (_input, signal) => {
      seen = signal;
      return new Promise<FetchOutcome>(() => undefined);
    });
    const { clock, runtime, log } = open([hanging], { fetchLimit: () => 5_000 });
    const running = runtime.pass();
    await clock.advance(4_999);
    expect(seen?.aborted).toBe(false);
    await clock.advance(1);
    await running;
    // A request of the fetch that waits behind the park of its host now ends, and it never goes.
    expect(seen?.aborted).toBe(true);
    expect(fetchesOf(log)).toEqual([`${API} timeout`]);
    log.close();
  });

  it("aborts each fetch at the stop, writes no fetch for it, and fetches the source again at the next pass (AL-39)", async () => {
    const seen: (FetchSignal | undefined)[] = [];
    const source = scripted(API, (_input, signal) => {
      seen.push(signal);
      if (seen.length > 1) return Promise.resolve({ ok: true, observations: [], complete: true });
      // A fetch in the manner of polite-crawler: it throws the reason of the signal at the abort.
      return new Promise<FetchOutcome>((_resolve, reject) => {
        if (signal?.aborted === true) reject(signal.reason as Error);
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    });
    const { clock, runtime, log } = open([source], { fetchLimit: () => 5_000 });
    const stop = new AbortController();
    const running = runtime.pass(stop.signal);
    await clock.advance(1_000);
    expect(seen[0]?.aborted).toBe(false);
    stop.abort(new Error("The runtime stops."));
    const pass = await running;
    // No fetch runs on after the stop. The stop is not a fault of the source, thus its health has no failure.
    expect(seen[0]?.aborted).toBe(true);
    expect(pass.fetched).toEqual([API]);
    expect(fetchesOf(log)).toEqual([]);
    expect(runtime.state().health[API]?.lastFailure).toBeUndefined();
    // The log has no fetch of the source, thus the next pass fetches it at once.
    expect((await runtime.pass()).fetched).toEqual([API]);
    expect(fetchesOf(log)).toEqual([`${API} ok`]);
    expect(seen[1]?.aborted).toBe(true);
    log.close();
  });

  it("gives an aborted signal to each fetch of a pass that starts after the stop (AL-39)", async () => {
    let seen: FetchSignal | undefined;
    const source = scripted(API, (_input, signal) => {
      seen = signal;
      return signal?.aborted === true ? Promise.reject(signal.reason as Error) : Promise.resolve({ ok: true, observations: [], complete: true });
    });
    const { runtime, log } = open([source]);
    const stop = new AbortController();
    stop.abort(new Error("The runtime stops."));
    await runtime.pass(stop.signal);
    expect(seen?.aborted).toBe(true);
    expect(fetchesOf(log)).toEqual([]);
    log.close();
  });

  it("records a fetch that throws as a failure, and fetches the other sources", async () => {
    const good = scripted(WEA, async () => ({ ok: true, observations: [observation(WEA, "w1", T0, { key: "w1", issued: T0 })], complete: true }));
    const { runtime, log } = open([scripted(API, () => Promise.reject(new Error("The adapter has a defect."))), good]);
    const pass = await runtime.pass();
    expect(pass.fetched).toEqual([API, WEA]);
    expect(runtime.state().health[API]?.lastFailure?.failure).toEqual({ kind: "network", message: "The fetch threw: The adapter has a defect." });
    expect(runtime.state().merge.reports.map((entry) => entry.key)).toEqual(["w1"]);
    log.close();
  });

  it("keeps one event for an observation that repeats, and counts it as new one time", async () => {
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const { clock, runtime, log } = open([scripted(API, async () => ({ ok: true, observations: [seen, seen], complete: true }))]);
    await runtime.pass();
    await clock.advance(MINUTE);
    await runtime.pass();
    const fetches = [...log.read()].flatMap((event) => (event.type === "fetch" ? [event.record.fresh] : []));
    expect(fetches).toEqual([1, 0]);
    expect([...log.read()].filter((event) => event.type === "observation")).toHaveLength(1);
    log.close();
  });

  it("records a map that throws as a fatal problem", async () => {
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const source: SourceProcedures = {
      describe: () => descriptor(API, MINUTE),
      fetch: async () => ({ ok: true, observations: [seen], complete: true }),
      map: () => {
        throw new Error("The map has a defect.");
      },
    };
    const { runtime, log } = open([source]);
    await runtime.pass();
    const event = [...log.read()].find((entry) => entry.type === "fetch");
    expect(event?.type === "fetch" ? [event.record.fatal, event.problems] : undefined).toEqual([1, [{ path: "", message: "The map threw: The map has a defect.", fatal: true }]]);
    log.close();
  });

  it("counts the lossy problems of a fetch, and not the notes", async () => {
    const seen = [observation(API, "w1", T0, { key: "w1", issued: T0 }), observation(API, "w2", T0, { key: "w2", issued: T0 })];
    const source: SourceProcedures = {
      describe: () => descriptor(API, MINUTE),
      fetch: async () => ({ ok: true, observations: seen, complete: true }),
      map: ({ observation: one }) => ({
        ...map({ observation: one }),
        problems: [
          { path: "properties.severity", message: "an unknown value", fatal: false, lossy: true },
          { path: "properties.colour", message: "an unknown field", fatal: false },
        ],
      }),
    };
    const { runtime, log } = open([source]);
    await runtime.pass();
    const event = [...log.read()].find((entry) => entry.type === "fetch");
    expect(event?.type === "fetch" ? [event.record.fatal, event.record.lossy, event.problems.length] : undefined).toEqual([0, 2, 4]);
    log.close();
  });

  it("keeps the state of the log when a write fails, and does the work again in the next pass", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "fetch")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const source = scripted(API, async () => ({ ok: true, observations: [seen], complete: true }));
    const runtime = openRuntime({ log: flaky, clock, sources: [source], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0" });
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    expect(runtime.state()).toEqual(rebuild(inner.read(), runtime.config));
    const pass = await runtime.pass();
    expect(pass.fetched).toEqual([API]);
    expect(runtime.state().merge.reports.map((entry) => entry.key)).toEqual(["w1"]);
    inner.close();
  });

  it("gives each source the watch of that source", async () => {
    const got: [SourceId, Watch][] = [];
    const record = (id: SourceId) => scripted(id, async (input) => (got.push([id, input.watch]), { ok: true, observations: [], complete: true }));
    // Only the second source gets the position: a public point in Wichita KS.
    const watches: Record<string, Watch> = { [API]: { places: [KANSAS] }, [WEA]: { places: [{ ...KANSAS, at: [-97.34, 37.69] }], kinds: ["met"] } };
    const { runtime, log } = open([record(API), record(WEA)], { watch: (source) => watches[source.id] ?? { places: [] } });
    await runtime.pass();
    expect(got).toEqual([
      [API, watches[API]],
      [WEA, watches[WEA]],
    ]);
    log.close();
  });

  it("gives each pass to the hook, with the time of the next pass", async () => {
    const got: Pass[] = [];
    const { runtime, log } = open([scripted(API, async () => ({ ok: true, observations: [], complete: true }))], { onPass: (pass) => void got.push(pass) });
    const pass = await runtime.pass();
    expect(got).toEqual([pass]);
    expect(pass.wakeAt).toBe(T0 + MINUTE);
    log.close();
  });

  it("gives the hook each new report of a fetch one time, and a fault of the hook does not stop the pass (AL-132)", async () => {
    let page = 0;
    // Each fetch gives new observations. The second fetch gives the report w-1 again, in a new observation, and w-2.
    const fetch = async (): Promise<FetchOutcome> => {
      page += 1;
      const warnings = page === 1 ? [{ key: "w-1", issued: T0 - MINUTE }] : [{ key: "w-1", issued: T0 - MINUTE }, { key: "w-2", issued: T0 }];
      return { ok: true, observations: warnings.map((warning) => observation(API, `${warning.key}:${String(page)}`, T0, warning)), complete: true };
    };
    const got: string[][] = [];
    const { clock, runtime, log } = open([scripted(API, fetch)], { onReports: (reports) => void got.push(reports.map((report) => report.key)) });
    await runtime.pass();
    await clock.advance(MINUTE);
    await runtime.pass();
    expect(got).toEqual([["w-1"], ["w-2"]]);
    log.close();
    page = 0;
    const failing = open([scripted(API, fetch)], {
      onReports: () => {
        throw new Error("The meter failed.");
      },
    });
    const pass = await failing.runtime.pass();
    expect(pass.fetched).toEqual([API]);
    expect(failing.runtime.state().merge.reports.filter((report) => report.source === API).map((report) => report.key)).toEqual(["w-1"]);
    failing.log.close();
  });

  it("gives a wake after the pass when a source comes due during the fetches of the pass, and fetches it in the next pass", async () => {
    const clock = fakeWallClock(T0);
    const fast = async (): Promise<FetchOutcome> => ({ ok: true, observations: [], complete: true });
    let slowFor = 0;
    // The fetch of API takes `slowFor` on the clock. WEA has a longer interval, thus it comes due in a slow fetch of API.
    const api: SourceProcedures = { describe: () => descriptor(API, MINUTE), fetch: async () => (await clock.advance(slowFor), fast()), map };
    const wea: SourceProcedures = { describe: () => descriptor(WEA, MINUTE + 10_000), fetch: fast, map };
    const { runtime, log } = open([api, wea], { clock });
    const first = await runtime.pass();
    expect([first.fetched, first.wakeAt]).toEqual([[API, WEA], T0 + MINUTE]);
    await clock.advance(MINUTE);
    slowFor = 15_000;
    // The pass starts at T0 + 60 s and fetches API until T0 + 75 s. WEA comes due at T0 + 70 s.
    const second = await runtime.pass();
    expect([second.fetched, second.at, second.wakeAt]).toEqual([[API], T0 + 75_000, T0 + 75_001]);
    await clock.advance(1);
    slowFor = 0;
    expect((await runtime.pass()).fetched).toEqual([WEA]);
    log.close();
  });

  it("gives a wake after the pass when a balance read comes due during the fetches of the pass (AL-42)", async () => {
    const clock = fakeWallClock(T0);
    let slowFor = 0;
    const api: SourceProcedures = { describe: () => descriptor(API, MINUTE), fetch: async () => (await clock.advance(slowFor), { ok: true, observations: [], complete: true }), map };
    let reads = 0;
    const read = async (): Promise<BalanceReading> => ((reads += 1), { ok: true, balance: 20, currency: "USD" });
    const watch = balanceWatch({ provider: "provider:twilio", title: "Twilio", channels: ["twilio-call" as ChannelId], floors: [5], read, every: MINUTE + 10_000 });
    const { runtime, log } = open([api], { clock, balances: [watch] });
    expect((await runtime.pass()).wakeAt).toBe(T0 + MINUTE);
    await clock.advance(MINUTE);
    slowFor = 15_000;
    // The pass starts at T0 + 60 s, before the read is due, and fetches API until T0 + 75 s. The read comes due at T0 + 70 s.
    const second = await runtime.pass();
    expect([reads, second.at, second.wakeAt]).toEqual([1, T0 + 75_000, T0 + 75_001]);
    await clock.advance(1);
    slowFor = 0;
    await runtime.pass();
    expect(reads).toBe(2);
    log.close();
  });

  it("gives a wake after the pass when the probe of a channel comes due during the fetches of the pass (AL-75)", async () => {
    const clock = fakeWallClock(T0);
    let slowFor = 0;
    let probes = 0;
    const api: SourceProcedures = { describe: () => descriptor(API, 50_000), fetch: async () => (await clock.advance(slowFor), { ok: true, observations: [], complete: true }), map };
    // A made-up channel. Its first probe is one minute after the first pass.
    const push: ChannelProcedures = {
      describe: () => ({ id: "push" as ChannelId, title: "The push channel", dependsOn: [], services: ["domain:push.example.com"], api: ["domain:push.example.com"], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 }),
      send: async () => ({ ok: true, receipt: {}, accepted: clock.now() }),
      status: async () => ({ state: "delivered", at: clock.now() }),
      cancel: async () => undefined,
      probe: async () => ((probes += 1), { ok: true, at: clock.now() }),
    };
    const { runtime, log } = open([api], { clock, delivery: { recipients: [], pollEvery: 30_000, retry: 15_000, callLimit: 10_000, flightLimit: 40_000, channels: [push] } });
    expect((await runtime.pass()).wakeAt).toBe(T0 + 50_000);
    await clock.advance(50_000);
    slowFor = 15_000;
    // The pass starts at T0 + 50 s, before the probe is due, and fetches API until T0 + 65 s. The probe comes due at T0 + 60 s.
    const second = await runtime.pass();
    expect([probes, second.at, second.wakeAt]).toEqual([0, T0 + 65_000, T0 + 65_001]);
    await clock.advance(1);
    slowFor = 0;
    await runtime.pass();
    expect(probes).toBe(1);
    log.close();
  });

  it("gives a wake after the pass when a fetch runs to its limit of one interval", async () => {
    const clock = fakeWallClock(T0);
    // The fetch never ends. The runtime stops the wait at the limit, one interval, which is the next fetch of the source.
    const stuck: SourceProcedures = { describe: () => descriptor(API, MINUTE), fetch: () => new Promise<FetchOutcome>(() => undefined), map };
    const { runtime, log } = open([stuck], { clock });
    const work = runtime.pass();
    await clock.advance(MINUTE);
    const pass = await work;
    expect([pass.at, pass.wakeAt]).toEqual([T0 + MINUTE, T0 + MINUTE + 1]);
    log.close();
  });

  it("gives each pass a wake after it, over seeded fetch times up to two intervals", async () => {
    for (const seed of SEEDS) {
      const r = random(seed).fork("slow-fetches");
      const clock = fakeWallClock(T0);
      const intervals = [MINUTE, MINUTE + r.int(1, 30) * 1000, 2 * MINUTE + r.int(1, 30) * 1000];
      const ids = [API, WEA, "iem" as SourceId];
      const sources = ids.map(
        (id, at): SourceProcedures => ({
          describe: () => descriptor(id, intervals[at]!),
          // Each fetch takes 0 to 2 intervals. A fetch over its interval stops at the limit.
          fetch: async () => (await clock.advance(r.int(0, 2 * intervals[at]!)), { ok: true, observations: [], complete: true }),
          map,
        }),
      );
      const { runtime, log } = open(sources, { clock });
      for (let step = 0; step < 40; step++) {
        const pass = await runtime.pass();
        expect(pass.wakeAt! > pass.at, `seed ${seed}, pass ${step}`).toBe(true);
        await clock.advance(Math.max(0, pass.wakeAt! - clock.now()));
      }
      log.close();
    }
  });

  it("refuses two sources with the same id", () => {
    const source = scripted(API, async () => ({ ok: true, observations: [], complete: true }));
    expect(() => open([source, source])).toThrow("Two sources have the id api.");
  });

  it("closes each source with a close one time, also after a close that throws, and refuses a pass after the close", async () => {
    const closes: string[] = [];
    const empty: SourceProcedures["fetch"] = async () => ({ ok: true, observations: [], complete: true });
    const failing: SourceProcedures = { ...scripted(API, empty), close: () => Promise.reject(new Error("The session did not end.")) };
    const stream: SourceProcedures = { ...scripted(WEA, empty), close: async () => void closes.push("wea") };
    const plain = scripted("plain" as SourceId, empty);
    const { log, runtime } = open([failing, stream, plain]);
    try {
      await runtime.pass();
      const first = runtime.close();
      expect(runtime.close()).toBe(first);
      await expect(first).resolves.toBeUndefined();
      expect(closes).toEqual(["wea"]);
      await expect(runtime.pass()).rejects.toThrow("The runtime is closed: its sources have no session.");
      expect(closes).toEqual(["wea"]);
    } finally {
      log.close();
    }
  });
});
