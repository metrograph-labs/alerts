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
 * Give a scratch copy of a home folder, because the passes append events to its log. The start is ready at the end of
 * its first pass, as a live start is.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { nodeHostPorts } from "@mark1russell7/service/host";
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
}

/** A runtime of a measured start. */
export interface MeasuredRuntime {
  /** The instance of the start. A measure reads its state and its runtime here. */
  readonly instance: Instance;
  /** The first pass. A live start is ready at the end of this pass. */
  readonly first: Pass;
  /** This function does one more pass, as the loop of a live runtime does after the start. */
  pass(): Promise<Pass>;
  /** This function closes the runtime, the stores and the log, and then it frees the lock of the home folder. */
  close(): Promise<void>;
}

/** This transport refuses each fetch of a source. */
const offline: Transport = () => Promise.reject(new Error(NO_NETWORK));

/** This fetch refuses each send of a channel. */
const noSend: PushoverChannelOptions["fetch"] = () => Promise.reject(new TypeError(NO_NETWORK));

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
    const shapes = openShapeCache(join(home, SHAPES_FILE));
    const readings = openReadingStore(join(home, READINGS_FILE));
    const transit = openTransitCache(join(home, TRANSIT_FILE), (problem) => report(`The copy of the transit catalog is not used: ${problem}.`));
    const priors = loadPriors(report);
    // The stores of shapes and of the transit catalog start their work after the first pass, as in a live start.
    let ready = false;
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
      onError: (error, failures) => report(`A pass failed (${String(failures)} in sequence): ${error instanceof Error ? error.name : typeof error}.`),
    });
    const first = await instance.runtime.pass();
    ready = true;
    let closed = false;
    return {
      instance,
      first,
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
