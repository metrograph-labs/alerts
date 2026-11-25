/**
 * This module opens the runtime of a home folder as the start of `main.ts` does, for a measure of the start (AL-102).
 * The measure is the memory and the time of the start as the log grows. A CI job takes it in a fresh process.
 *
 * - The start opens the same files. They are the log, the stores of shapes and of readings, the copy of the transit
 *   catalog, the counts of the quotas and the priors. The start rebuilds the state from the log in the same way.
 * - The start has no network. Each fetch of a source and each send of a channel fails at once, and no request leaves
 *   the process. A failed fetch writes its event to the log, as in a live start.
 * - With the option `services`, the fetches and the sends go to fakes on `127.0.0.1` (AL-131). The lab of the capacity
 *   models starts the fakes. No request goes to another host.
 * - The start reads no key. The keys of the measure are fake keys that the caller gives. The start reads no
 *   `secrets.env` and no `copy.json`. Thus the runtime is the only copy, with no exchange and no heartbeat.
 * - The start takes the lock of the home folder. Thus a measure stops when a live runtime holds the folder.
 *
 * Give a scratch copy of a home folder, because the passes append events to its log. A measured start has two points,
 * as a live start has. At `opened`, the probe `/readiness` of a live start passes. At the end of the first pass, the start is good.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock, type WallClock } from "@mark1russell7/algebra/clock";
import type { GcPause } from "@mark1russell7/lag/node";
import { nodeHostPorts } from "@mark1russell7/service/host";
import type { ChunkOptions, FoldKey, FoldMark, FoldRow, FoldSnapshot, MarkLog } from "@mark1russell7/sqlite";
import type { Meter } from "@opentelemetry/api";
import { SqliteHostStateStore } from "polite-crawler";
import { fetchTransport, quotaGate, type Transport } from "polite-crawler/api";
import { CONFIG_FILE, envSecrets } from "./config.ts";
import { holdHome } from "./home-lock.ts";
import { instanceCheck, openInstance, type Instance } from "./instance.ts";
import { openCheckedRuntimeLog, type RuntimeLog } from "./log.ts";
import { loadPriors } from "./priors.ts";
import { openReadingStore, READINGS_FILE } from "./readings.ts";
import { checkStart, privateFiles, readStartTexts } from "./reload.ts";
import type { Pass } from "./runtime.ts";
import { openStartSnapshots, START_SNAPSHOTS_FOLDER, type OpenedStartSnapshot } from "./start-snapshot.ts";
import { openTransitCache, TRANSIT_FILE } from "./transit.ts";

/** The fake keys of a measure with no option `keys`: the token of the Pushover application and one Pushover user key. */
export const MEASURE_KEYS: Readonly<Record<string, string>> = { PUSHOVER_APP_TOKEN: "t".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) };

/** The message of each fetch and each send of a measured start. */
export const NO_NETWORK = "A measured start has no network.";

/**
 * The header of each request to a fake: the instant of the wall clock of the measured start, in milliseconds. The wall clock of
 * a measure starts at the end of a seeded log, not at the time of the platform. Thus a fake gives its answers at this instant.
 */
export const MEASURE_NOW_HEADER = "x-measure-now";

/** The hosts of the URL of a fake. */
const FAKE_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * The base URLs of the fakes of the outside services of a measured start (AL-131). Each URL is an HTTP URL on `127.0.0.1` or
 * `localhost`. A request to `https://<host><path>` goes to `<base>/<host><path>`, with the header `MEASURE_NOW_HEADER`.
 */
export interface MeasuredServices {
  /** The fake of the feeds. Each fetch of a source goes to it. */
  readonly feeds?: string;
  /** The fake of the channels. Each send of the Pushover channel goes to it. */
  readonly channels?: string;
}

/**
 * This function reads the base URL of a fake, with no `/` at the end. The text of an error holds no URL.
 *
 * @throws RangeError when the text is not an HTTP URL on `127.0.0.1` or `localhost`.
 */
export function fakeBase(text: string, what: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError(`The base URL of the fake of the ${what} is not a URL.`);
  }
  if (url.protocol !== "http:" || !FAKE_HOSTS.has(url.hostname) || url.search !== "" || url.hash !== "") {
    throw new RangeError(`The base URL of the fake of the ${what} is not an HTTP URL on 127.0.0.1 or localhost, with no query.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** This function gives the URL of a request at a fake: the base, then the host, the path and the query of the request. */
export function fakeUrl(base: string, url: string): string {
  const target = new URL(url);
  return `${base}/${target.host}${target.pathname}${target.search}`;
}

/** The User-Agent of the transport to the fake of the feeds. Each source also sends its own User-Agent. */
const MEASURE_USER_AGENT = "alerts-measure";

/**
 * This transport sends each fetch of a source to the fake of the feeds. The pace of polite-crawler stays the pace of each
 * host of a source, because the requester of the source keeps its own host. Only the transport changes the URL.
 */
function fakeTransport(base: string, wall: WallClock): Transport {
  const inner = fetchTransport({ userAgent: MEASURE_USER_AGENT });
  return (exchange, signal) => inner({ ...exchange, url: fakeUrl(base, exchange.url), headers: { ...exchange.headers, [MEASURE_NOW_HEADER]: String(Math.round(wall.now())) } }, signal);
}

/** This fetch sends each request of the Pushover channel to the fake of the channels. */
function fakeSend(base: string, wall: WallClock): PushoverChannelOptions["fetch"] {
  return (url, init) => fetch(fakeUrl(base, url), { ...init, headers: { ...init.headers, [MEASURE_NOW_HEADER]: String(Math.round(wall.now())) } });
}

/** The options of a measured start. */
export interface MeasuredOptions {
  /**
   * The fake keys of the start, by name. The configuration of the home folder names its keys. Default: `MEASURE_KEYS`.
   * Give no real key. The start sends nothing to a real service, thus a real key has no use in it.
   */
  readonly keys?: Readonly<Record<string, string>>;
  /** This function gets each line that a live start writes to its output. Default: no output. */
  readonly report?: (line: string) => void;
  /**
   * The wall clock of the start. Each part of the runtime reads its instant, as with the option `wall` of `openInstance`.
   * Default: the wall clock of the platform. For a seeded log, give `wallClock({ start })` with the time of its last event.
   */
  readonly wall?: WallClock;
  /**
   * The start reads and writes the snapshot of the start in the home folder, as a live start does (AL-105). Default: false.
   * Then the start folds the whole log, and it writes no snapshot.
   */
  readonly startSnapshot?: boolean;
  /**
   * With `startSnapshot`, the measure times each write of the snapshot (AL-115). The record has the time of the build of the
   * rows apart from the time of SQLite. It also has the longest time between two pauses of the write. Default: false.
   */
  readonly timeSnapshot?: boolean;
  /**
   * With `timeSnapshot`, this function gets the record of each write of the snapshot at the end of that write (CAP-65). The
   * list `snapshotWrites` gets the same record. The lab of the capacity models writes one line for each record. Default: no function.
   */
  readonly onSnapshotWrite?: (write: SnapshotWriteTime) => void;
  /** The option `startSnapshotFloor` of `openInstance`. Default: `START_SNAPSHOT_FLOOR`. A measure with a small log gives 1. */
  readonly snapshotFloor?: number;
  /**
   * The option `transitLimit` of `openInstance`: the most transit feeds of the start. Default: `MAX_TRANSIT_FEEDS`. The lab of
   * the capacity models gives the count of the feeds of its seed, to measure the cost of each polled source (AL-126).
   */
  readonly transitLimit?: number;
  /** The option `meter` of `openInstance`: the meter of the live metrics (AL-132). The lab of the capacity models reads them. */
  readonly meter?: Meter;
  /**
   * The base URLs of the fakes of the outside services (AL-131). Default: no fakes, and the start has no network. With `feeds`,
   * each fetch of a source goes to the fake of the feeds. With `channels`, each send of the Pushover channel goes to the fake
   * of the channels. Each request has the header `MEASURE_NOW_HEADER`.
   */
  readonly services?: MeasuredServices;
}

/** The record of one write of the snapshot of the start, with the option `timeSnapshot`. */
export interface SnapshotWriteTime {
  /** The value of `performance.now()` at the start of the write, in milliseconds. */
  readonly at: number;
  /** The count of rows. */
  readonly rows: number;
  /** The count of UTF-16 code units in the parts and the values of the rows. */
  readonly chars: number;
  /** The time of the build of the rows, in milliseconds. The build makes the JSON text of each row. */
  readonly rowsMs: number;
  /** The time of the store in the write apart from the build of the rows, in milliseconds, with no pause. Most of it is SQLite. */
  readonly writeMs: number;
  /** The CPU time of the process from the start to the end of the write, user plus system, in milliseconds. Other work in the pauses adds to it. */
  readonly cpuMs: number;
  /** The time from the start to the end of the write, with the pauses, in milliseconds. */
  readonly wallMs: number;
  /** The longest time between two pauses of the write, in milliseconds: the longest block of the event loop in the write. */
  readonly longestMs: number;
  /**
   * The most CPU time of the thread of the event loop in one part of the write, in milliseconds (AL-122). This is the work of
   * the part. A wait of the thread for the disk or for the computer does not add to it. Linux gives the time in microseconds.
   */
  readonly longestCpuMs: number;
  /** The wait of the longest part, in milliseconds: its time with no CPU time of the thread. The thread waits for the disk or for the computer. */
  readonly longestWaitMs: number;
  /** The count of the parts of the write between two pauses. */
  readonly chunks: number;
  /** Each part of the write between two pauses, in order (AL-174). A gate takes the pauses of the garbage collector out of each part. */
  readonly parts: readonly WritePart[];
}

/** One part of a snapshot write between two pauses (AL-174). */
export interface WritePart {
  /** The start of the part, on the clock of `performance.now()`. */
  readonly at: number;
  /** The time of the part, in milliseconds. */
  readonly ms: number;
  /** The CPU time of the thread of the event loop in the part, in milliseconds. */
  readonly cpuMs: number;
}

/**
 * This function gives the most work of the thread in one part of a write (AL-174). The work of a part is its CPU time apart
 * from the pauses of the garbage collector in it. One pause of the collector is not work of the write, and it is not the same in each
 * run. A pause across an edge of a part counts with its part inside. The work of a part is 0 or more.
 */
export function longestPartWork(parts: readonly WritePart[], pauses: readonly GcPause[]): { readonly workMs: number; readonly gcMs: number } {
  let workMs = 0;
  let gcMs = 0;
  for (const part of parts) {
    const end = part.at + part.ms;
    let inside = 0;
    for (const pause of pauses) inside += Math.max(0, Math.min(end, pause.startTime + pause.duration) - Math.max(part.at, pause.startTime));
    const work = Math.max(0, part.cpuMs - inside);
    if (work > workMs) workMs = work;
    if (inside > gcMs) gcMs = inside;
  }
  return { workMs, gcMs };
}

/** A runtime of a measured start. */
export interface MeasuredRuntime {
  /** The instance of the start. A measure reads its state and its runtime here. */
  readonly instance: Instance;
  /** The log of the instance. A measure counts its events and its transactions here (AL-168). */
  readonly log: RuntimeLog;
  /**
   * The value of `performance.now()` at the end of `openInstance`, in milliseconds from the start of the process. After this
   * point, a live start does only small steps, and then its probe `/readiness` passes. The ready window of the supervisor
   * counts from the start of the process to that probe. Thus this value is the measure of a start against the window.
   */
  readonly opened: number;
  /**
   * The first pass. At the end of this pass, a live start is good: it writes its last good set. The supervisor measures each
   * start from its spawn to the first pass of `/readiness`, in the file `host/runtime.ready.json`.
   */
  readonly first: Pass;
  /** The record of each write of the snapshot, in order. It is empty without the options `startSnapshot` and `timeSnapshot`. */
  readonly snapshotWrites: readonly SnapshotWriteTime[];
  /** This function does one more pass, as the loop of a live runtime does after the start. */
  pass(): Promise<Pass>;
  /** This function closes the runtime, the stores and the log, and then it frees the lock of the home folder. */
  close(): Promise<void>;
}

/** This transport refuses each fetch of a source. */
const offline: Transport = () => Promise.reject(new Error(NO_NETWORK));

/** This fetch refuses each send of a channel. */
const noSend: PushoverChannelOptions["fetch"] = () => Promise.reject(new TypeError(NO_NETWORK));

// The default pause of `writeInChunks`: one timer of 0 ms.
const oneTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The store with a record of each write. The rows come from a generator of the runtime. This store times each step of the
// generator, and each part of the write between two pauses. The read and the clear do not change.
function timedSnapshot(store: FoldSnapshot, writes: SnapshotWriteTime[], onWrite?: (write: SnapshotWriteTime) => void): FoldSnapshot {
  const timed = (rows: Iterable<FoldRow>, written: (record: Omit<SnapshotWriteTime, "at" | "cpuMs" | "wallMs">) => void, chunked: { readonly pause?: () => Promise<void> } = {}) => {
    const counts = { rows: 0, chars: 0, rowsMs: 0, busyMs: 0, longestMs: 0, longestCpuMs: 0, longestWaitMs: 0, chunks: 1 };
    const parts: WritePart[] = [];
    let segment = performance.now();
    let segmentCpu = process.threadCpuUsage();
    function* each(): Generator<FoldRow> {
      const iterator = rows[Symbol.iterator]();
      for (;;) {
        const before = performance.now();
        const step = iterator.next();
        counts.rowsMs += performance.now() - before;
        if (step.done === true) return;
        counts.rows += 1;
        counts.chars += step.value.part.length + step.value.value.length;
        yield step.value;
      }
    }
    const end = (): void => {
      const ms = performance.now() - segment;
      const used = process.threadCpuUsage(segmentCpu);
      const cpuMs = (used.user + used.system) / 1000;
      parts.push({ at: segment, ms, cpuMs });
      counts.busyMs += ms;
      if (ms > counts.longestMs) {
        counts.longestMs = ms;
        counts.longestWaitMs = Math.max(0, ms - cpuMs);
      }
      counts.longestCpuMs = Math.max(counts.longestCpuMs, cpuMs);
    };
    const pause = async (): Promise<void> => {
      end();
      await (chunked.pause ?? oneTimer)();
      counts.chunks += 1;
      segment = performance.now();
      segmentCpu = process.threadCpuUsage();
    };
    const done = (): void => {
      end();
      written({ rows: counts.rows, chars: counts.chars, rowsMs: counts.rowsMs, writeMs: counts.busyMs - counts.rowsMs, longestMs: counts.longestMs, longestCpuMs: counts.longestCpuMs, longestWaitMs: counts.longestWaitMs, chunks: counts.chunks, parts });
    };
    return { rows: each(), pause, done };
  };
  const record = (at: number, cpu: NodeJS.CpuUsage) => (part: Omit<SnapshotWriteTime, "at" | "cpuMs" | "wallMs">): void => {
    const used = process.cpuUsage(cpu);
    const write: SnapshotWriteTime = { at, ...part, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - at };
    writes.push(write);
    onWrite?.(write);
  };
  return {
    read<T>(key: FoldKey, log: MarkLog, work: (mark: FoldMark, rows: Iterable<FoldRow>) => T): T | undefined {
      return store.read(key, log, work);
    },
    clear: () => store.clear(),
    write(key, mark, rows) {
      const one = timed(rows, record(performance.now(), process.cpuUsage()));
      const count = store.write(key, mark, one.rows);
      one.done();
      return count;
    },
    async writeInChunks(key: FoldKey, mark: FoldMark, rows: Iterable<FoldRow>, options: ChunkOptions = {}): Promise<number> {
      const one = timed(rows, record(performance.now(), process.cpuUsage()), options);
      const count = await store.writeInChunks(key, mark, one.rows, { ...options, pause: one.pause });
      one.done();
      return count;
    },
  };
}

/**
 * This function opens the runtime of the home folder `home` with no key, and it resolves after the first pass. The start has
 * no network, or only the fakes of the option `services`. It throws when the private files of the folder do not pass the
 * check, or when a live runtime holds the folder.
 *
 * @throws RangeError when a base URL of `services` is not an HTTP URL on `127.0.0.1` or `localhost`. Then the start takes no lock.
 */
export async function openMeasuredRuntime(home: string, options: MeasuredOptions = {}): Promise<MeasuredRuntime> {
  const report = options.report ?? ((): void => undefined);
  const feeds = options.services?.feeds === undefined ? undefined : fakeBase(options.services.feeds, "feeds");
  const channels = options.services?.channels === undefined ? undefined : fakeBase(options.services.channels, "channels");
  const held = await holdHome(home, nodeHostPorts());
  try {
    // The texts of a start, with the fake keys in place of secrets.env and with no copy.json. The check is the check of main.ts.
    const keys = options.keys ?? MEASURE_KEYS;
    const files = privateFiles(home, join(home, CONFIG_FILE));
    const read = await readStartTexts(files);
    const secretsText = Object.entries(keys)
      .map(([name, value]) => `${name}=${value}\n`)
      .join("");
    const checked = checkStart({ ...read, secrets: { text: secretsText }, copy: { code: "ENOENT" } }, instanceCheck);
    if (checked.tag === "err") throw new Error(`The private files of the measure do not pass the check:\n- ${checked.error.join("\n- ")}`);
    const wall = options.wall ?? wallClock();
    const quotas = new SqliteHostStateStore(join(home, "quotas.sqlite"));
    const { log, recovered } = openCheckedRuntimeLog(join(home, "runtime.sqlite"), { now: () => wall.now() });
    if (recovered !== undefined) report(`The log file was broken. The new log kept ${String(recovered.added)} events and lost ${String(recovered.lost)}.`);
    const snapshot: OpenedStartSnapshot = options.startSnapshot === true ? openStartSnapshots(home) : {};
    if (snapshot.fault !== undefined) report(`The folder ${START_SNAPSHOTS_FOLDER} did not open (${snapshot.fault}).`);
    if (recovered !== undefined) snapshot.store?.clear();
    const shapes = openShapeCache(join(home, SHAPES_FILE));
    const readings = openReadingStore(join(home, READINGS_FILE));
    const transit = openTransitCache(join(home, TRANSIT_FILE), (problem) => report(`The copy of the transit catalog is not used: ${problem}.`));
    const priors = loadPriors(report);
    // The stores of shapes and of the transit catalog start their work after the first pass, as in a live start.
    let ready = false;
    const snapshotWrites: SnapshotWriteTime[] = [];
    const store = snapshot.store === undefined || options.timeSnapshot !== true ? snapshot.store : timedSnapshot(snapshot.store, snapshotWrites, options.onSnapshotWrite);
    const instance = openInstance({
      config: checked.value.parsed,
      secret: envSecrets(checked.value.keys),
      log,
      ...(priors === undefined ? {} : { priors }),
      clock: realClock,
      wall,
      transport: feeds === undefined ? offline : fakeTransport(feeds, wall),
      pushover: channels === undefined ? noSend : fakeSend(channels, wall),
      // The fake of the channels is a fake of Pushover. The webhook of a measured start sends nothing.
      webhook: noSend,
      pushoverQuota: quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", store: quotas, now: () => wall.now() }),
      pushoverReserveNotices: quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", store: quotas, now: () => wall.now() }),
      run: randomUUID(),
      shapes,
      readings,
      transit,
      startGood: () => ready,
      ...(store === undefined ? {} : { startSnapshot: store }),
      ...(options.snapshotFloor === undefined ? {} : { startSnapshotFloor: options.snapshotFloor }),
      ...(options.transitLimit === undefined ? {} : { transitLimit: options.transitLimit }),
      ...(options.meter === undefined ? {} : { meter: options.meter }),
      onStartSnapshotFault: (error) => report(`A write of the snapshot of the start failed: ${error instanceof Error ? error.name : typeof error}.`),
      onError: (error, failures) => report(`A pass failed (${String(failures)} in sequence): ${error instanceof Error ? error.name : typeof error}.`),
    });
    // A live start reads the log and folds its state in openInstance. Its probe /readiness passes soon after this point.
    const opened = performance.now();
    const first = await instance.runtime.pass();
    ready = true;
    let closed = false;
    return {
      instance,
      log,
      opened,
      first,
      snapshotWrites,
      pass: () => instance.runtime.pass(),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await instance.runtime.close();
          await instance.shapes.close();
          await instance.transit?.close();
          quotas.close();
          readings.close();
          snapshot.store?.close();
          log.close();
        } finally {
          await held.lock.release();
        }
      },
    };
  } catch (error) {
    await held.lock.release();
    throw error;
  }
}
