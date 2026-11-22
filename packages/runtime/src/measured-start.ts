/**
 * This module opens the runtime of a home folder as the start of `main.ts` does, for a measure of the start (AL-102).
 * The measure is the memory and the time of the start as the log grows. A CI job takes it in a fresh process.
 *
 * - The start opens the same files. They are the log, the stores of shapes and of readings, the copy of the transit
 *   catalog, the counts of the quotas and the priors. The start rebuilds the state from the log in the same way.
 * - The start has no network. Each fetch of a source and each send of a channel fails at once, and no request leaves
 *   the process. A failed fetch writes its event to the log, as in a live start.
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
import { nodeHostPorts } from "@mark1russell7/service/host";
import type { FoldKey, FoldMark, FoldRow, FoldSnapshot, MarkLog } from "@mark1russell7/sqlite";
import { SqliteHostStateStore } from "polite-crawler";
import { quotaGate, type Transport } from "polite-crawler/api";
import { CONFIG_FILE, envSecrets } from "./config.ts";
import { holdHome } from "./home-lock.ts";
import { instanceCheck, openInstance, type Instance } from "./instance.ts";
import { openCheckedRuntimeLog } from "./log.ts";
import { loadPriors } from "./priors.ts";
import { openReadingStore, READINGS_FILE } from "./readings.ts";
import { checkStart, privateFiles, readStartTexts } from "./reload.ts";
import type { Pass } from "./runtime.ts";
import { openStartSnapshot, START_SNAPSHOT_FILE, type OpenedStartSnapshot } from "./start-snapshot.ts";
import { openTransitCache, TRANSIT_FILE } from "./transit.ts";

/** The fake keys of a measure with no option `keys`: the token of the Pushover application and one Pushover user key. */
export const MEASURE_KEYS: Readonly<Record<string, string>> = { PUSHOVER_APP_TOKEN: "t".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) };

/** The message of each fetch and each send of a measured start. */
export const NO_NETWORK = "A measured start has no network.";

/** The options of a measured start. */
export interface MeasuredOptions {
  /**
   * The fake keys of the start, by name. The configuration of the home folder names its keys. Default: `MEASURE_KEYS`.
   * Give no real key: the start sends nothing, and a real key has no use in it.
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
   * With `startSnapshot`, the measure times each write of the snapshot (AL-115). It builds all the rows first, and then it
   * gives them to the store. Thus the record has the time of the rows apart from the time of SQLite. Default: false.
   */
  readonly timeSnapshot?: boolean;
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
  /** The time of the write of SQLite, in milliseconds: one transaction that replaces the old rows. */
  readonly writeMs: number;
  /** The CPU time of the process in the whole write, user plus system, in milliseconds. */
  readonly cpuMs: number;
}

/** A runtime of a measured start. */
export interface MeasuredRuntime {
  /** The instance of the start. A measure reads its state and its runtime here. */
  readonly instance: Instance;
  /**
   * The value of `performance.now()` at the end of `openInstance`, in milliseconds from the start of the process. After this
   * point, a live start does only small steps, and then its probe `/readiness` passes. The ready window of the supervisor
   * counts from the start of the process to that probe. Thus this value is the measure of a start against the window.
   */
  readonly opened: number;
  /**
   * The first pass. At the end of this pass, a live start is good: it writes its start time and its last good set.
   * The file `host/start-times.json` holds the time to this point, not the time to `opened`.
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

// The store with a record of each write. The rows come from a generator of the runtime, thus the build of the rows is apart
// from the transaction only in this store. The read and the clear do not change.
function timedSnapshot(store: FoldSnapshot, writes: SnapshotWriteTime[]): FoldSnapshot {
  return {
    read<T>(key: FoldKey, log: MarkLog, work: (mark: FoldMark, rows: Iterable<FoldRow>) => T): T | undefined {
      return store.read(key, log, work);
    },
    clear: () => store.clear(),
    write(key, mark, rows) {
      const at = performance.now();
      const cpu = process.cpuUsage();
      const list = [...rows];
      const built = performance.now();
      const count = store.write(key, mark, list);
      const used = process.cpuUsage(cpu);
      const chars = list.reduce((sum, row) => sum + row.part.length + row.value.length, 0);
      writes.push({ at, rows: list.length, chars, rowsMs: built - at, writeMs: performance.now() - built, cpuMs: (used.user + used.system) / 1000 });
      return count;
    },
  };
}

/**
 * This function opens the runtime of the home folder `home` with no network and no key, and it resolves after the first
 * pass. It throws when the private files of the folder do not pass the check, or when a live runtime holds the folder.
 */
export async function openMeasuredRuntime(home: string, options: MeasuredOptions = {}): Promise<MeasuredRuntime> {
  const report = options.report ?? ((): void => undefined);
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
    const snapshot: OpenedStartSnapshot = options.startSnapshot === true ? openStartSnapshot(join(home, START_SNAPSHOT_FILE)) : {};
    if (snapshot.fault !== undefined) report(`The file ${START_SNAPSHOT_FILE} did not open (${snapshot.fault}).`);
    if (recovered !== undefined) snapshot.store?.clear();
    const shapes = openShapeCache(join(home, SHAPES_FILE));
    const readings = openReadingStore(join(home, READINGS_FILE));
    const transit = openTransitCache(join(home, TRANSIT_FILE), (problem) => report(`The copy of the transit catalog is not used: ${problem}.`));
    const priors = loadPriors(report);
    // The stores of shapes and of the transit catalog start their work after the first pass, as in a live start.
    let ready = false;
    const snapshotWrites: SnapshotWriteTime[] = [];
    const store = snapshot.store === undefined || options.timeSnapshot !== true ? snapshot.store : timedSnapshot(snapshot.store, snapshotWrites);
    const instance = openInstance({
      config: checked.value.parsed,
      secret: envSecrets(checked.value.keys),
      log,
      ...(priors === undefined ? {} : { priors }),
      clock: realClock,
      wall,
      transport: offline,
      pushover: noSend,
      pushoverQuota: quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", store: quotas, now: () => wall.now() }),
      pushoverReserveNotices: quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", store: quotas, now: () => wall.now() }),
      run: randomUUID(),
      shapes,
      readings,
      transit,
      startGood: () => ready,
      ...(store === undefined ? {} : { startSnapshot: store }),
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
