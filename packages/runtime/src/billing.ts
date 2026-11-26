/**
 * The billing read of the host of another copy (AL-70).
 *
 * An account can stop the billing of a host at a spend limit. Then the host stops, and the other copy sees only a copy
 * that is down. The field `billing` of a peer in `copy.json` names a command that prints the billing of the host as JSON.
 *
 * - The watch starts the command only when the copy reaches the stage `unread`: one read in each down time of the copy.
 * - A failed read tries again after `BILLING_RETRY`, then after two times as long, up to `BILLING_RETRY_CAP`.
 * - A read that passes for the copy ends the down time. The next down time reads again.
 * - The runtime starts each program with no shell, through `runCommand` of `@procedures/shell`.
 * - The check of a pass starts the read and does not wait for it. Thus the alarm of the down copy goes out at once, and
 *   the billing state comes after it as an update of the same line.
 * - A message of a failed read holds no argument and no output of the command.
 * - The watch keeps no record. After a restart, the next down time reads again.
 */
import type { WallClock } from "@mark1russell7/algebra/clock";
import { copyStages, type CopyBilling, type CopyBillingConfig, type CopyBillingState, type CopyPeer, type CopyWatch, type Duration, type Instant, type ReadHealth } from "@mark1russell7/alerts";
import { fieldOf } from "@mark1russell7/optional/read";
import { commandRunner, DRIFT_OUTPUT_BYTES, type CommandOutput, type DriftRunner } from "./drift.ts";
import { limited } from "./limit.ts";
import type { CopyChecks } from "./runtime.ts";
import type { ReadWatch } from "./schedule.ts";

const MINUTE = 60_000;

/** The longest time of one billing read. */
export const BILLING_LIMIT: Duration = MINUTE;

/** The time after the first failed read before the next read. Each next failure doubles the time. */
export const BILLING_RETRY: Duration = 5 * MINUTE;

/** The longest time between two reads after a failure. */
export const BILLING_RETRY_CAP: Duration = 60 * MINUTE;

/** The result of one billing read. A failed read has the state `unread` and a message with no output. */
export type BillingReading = { readonly state: Exclude<CopyBillingState, "unread"> } | { readonly state: "unread"; readonly message: string };

/**
 * This function gives the billing state from the output of the command of a billing read.
 *
 * - A program that did not start, a time out, a long output or an exit code other than 0 gives `unread`.
 * - The output is one JSON value. The field is a path of names with dots between them. A missing field gives `unread`.
 * - A value that is not a text, a number or a boolean gives `unread`.
 * - A value in `stoppedWhen` gives `stopped`. Each other value gives `on`.
 */
export function billingOf(config: CopyBillingConfig, output: CommandOutput): BillingReading {
  if (output.notStarted === true) return { state: "unread", message: "The program of the billing read did not start." };
  if (output.timedOut === true) return { state: "unread", message: "The billing read took longer than its limit." };
  if (output.truncated === true) return { state: "unread", message: `The output of the billing read is longer than ${String(DRIFT_OUTPUT_BYTES)} bytes.` };
  if (output.exitCode !== 0) return { state: "unread", message: `The billing read gave the exit code ${String(output.exitCode)}.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    return { state: "unread", message: "The output of the billing read is not valid JSON." };
  }
  const value = config.field.split(".").reduce<unknown>((record, key) => fieldOf(record, key), parsed);
  if (value === undefined) return { state: "unread", message: "The output of the billing read has no value at its field." };
  if (!(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
    return { state: "unread", message: "The value at the field of the billing read is not a text, a number or a boolean." };
  }
  return { state: config.stoppedWhen.includes(value) ? "stopped" : "on" };
}

/** This function gives the wait after the failed read number `failures` (from 1). The wait is the retry, doubled for each failure, up to the cap. */
export function billingRetryAfter(failures: number, retry: Duration = BILLING_RETRY, cap: Duration = BILLING_RETRY_CAP): Duration {
  return Math.min(retry * 2 ** Math.max(0, Math.min(failures - 1, 30)), cap);
}

/** The options of the billing watch. */
export interface BillingWatchOptions {
  /** The other copies: the peers of `copy.json`. The watch reads only the peers with the field `billing`. */
  readonly peers: readonly CopyPeer[];
  /** The watches of the other copies: the worker of the exchange. */
  readonly copies: Pick<CopyChecks, "watches">;
  /** The runner of the commands. The default is `commandRunner` of `drift.ts`. A test gives a fake. */
  readonly run?: DriftRunner;
  /** The longest time of one read. The default is `BILLING_LIMIT`. */
  readonly limit?: Duration;
  /** The time after the first failed read. The default is `BILLING_RETRY`. */
  readonly retry?: Duration;
  /** The longest time between two reads after a failure. The default is `BILLING_RETRY_CAP`. */
  readonly retryCap?: Duration;
  /** This function receives the end of each read that this watch keeps. The runtime wakes its loop here, thus the update goes out soon. */
  readonly onRead?: () => void;
}

/** The billing watch of the hosts of the other copies. */
export interface BillingWatch extends ReadWatch {
  /** This method gives the watches of the other copies, each with its billing read of this down time. */
  watches(): readonly CopyWatch[];
  /** This method gives the message of the last read of the copy `copy` when it failed. */
  failure(copy: string): string | undefined;
  /** This method gives the health of the reads of each copy with a billing read. It holds no state and no message. */
  health(): readonly ReadHealth[];
  /** This method gives a promise that ends when each read in flight ends. */
  settled(): Promise<void>;
}

// The reads of one copy in its down time.
interface BillingEntry {
  readonly copy: string;
  readonly config: CopyBillingConfig;
  // The number of the down time. A read of an earlier down time does not change the entry.
  episode: number;
  down: boolean;
  billing: CopyBilling | undefined;
  failures: number;
  failure: string | undefined;
  next: Instant | undefined;
  running: { readonly job: Promise<void>; startedAt: Instant } | undefined;
  passedAt: Instant | undefined;
}

/**
 * This function makes the billing watch of the hosts of the other copies.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0.
 */
export function billingWatch(options: BillingWatchOptions): BillingWatch {
  const limit = options.limit ?? BILLING_LIMIT;
  const retry = options.retry ?? BILLING_RETRY;
  const retryCap = options.retryCap ?? BILLING_RETRY_CAP;
  const run = options.run ?? commandRunner;
  for (const [name, value] of Object.entries({ limit, retry, retryCap })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the billing watch is not a whole count of milliseconds above 0.`);
  }
  const entries: BillingEntry[] = options.peers.flatMap((peer) =>
    peer.billing === undefined ? [] : [{ copy: peer.id, config: peer.billing, episode: 0, down: false, billing: undefined, failures: 0, failure: undefined, next: undefined, running: undefined, passedAt: undefined }],
  );
  const byCopy = new Map(entries.map((entry) => [entry.copy, entry]));
  let checked = false;

  const read = async (entry: BillingEntry, clock: WallClock, stop: AbortSignal | undefined): Promise<void> => {
    const episode = entry.episode;
    const own = new AbortController();
    const onStop = (): void => own.abort(stop?.reason);
    stop?.addEventListener("abort", onStop, { once: true });
    const work = Promise.resolve().then(() => run(entry.config.argv, own.signal, limit)).then((output) => billingOf(entry.config, output));
    const late = (): BillingReading => ({ state: "unread", message: `The billing read took longer than ${String(limit)} ms.` });
    const thrown = (): BillingReading => ({ state: "unread", message: "The billing read failed to run." });
    const reading = await limited(work, limit, clock, late, thrown);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error("The billing read ended."));
    // A read that the stop ended is not a fault of the provider. A read of an ended down time changes nothing.
    if (stop?.aborted === true || entry.episode !== episode) return;
    const at = clock.now();
    entry.billing = { state: reading.state, at };
    if (reading.state === "unread") {
      entry.failures += 1;
      entry.failure = reading.message;
      entry.next = at + billingRetryAfter(entry.failures, retry, retryCap);
    } else {
      entry.failures = 0;
      entry.failure = undefined;
      entry.next = undefined;
      entry.passedAt = at;
    }
    options.onRead?.();
  };

  // A down time needs a read until one read passes. A failed read waits for its retry.
  const nextOf = (entry: BillingEntry): Instant | undefined => {
    if (!entry.down) return undefined;
    if (entry.running !== undefined) return entry.running.startedAt + limit;
    if (entry.billing !== undefined && entry.billing.state !== "unread") return undefined;
    return entry.next;
  };

  return {
    // A read runs after the end of the pass. Thus it stops only at the end of `life`, not of the pass (AL-139).
    check(clock, _stop, life) {
      checked = true;
      const now = clock.now();
      const watches = options.copies.watches();
      for (const entry of entries) {
        const watch = watches.find((one) => one.copy === entry.copy);
        const down = watch !== undefined && copyStages(watch, now).includes("unread");
        if (!down) {
          // The end of a down time drops its reads. A read in flight ends with no change.
          if (entry.down) Object.assign(entry, { episode: entry.episode + 1, down: false, billing: undefined, failures: 0, failure: undefined, next: undefined });
          continue;
        }
        entry.down = true;
        if (entry.running !== undefined || (entry.billing !== undefined && entry.billing.state !== "unread")) continue;
        if (entry.next !== undefined && now < entry.next) continue;
        const job = read(entry, clock, life).finally(() => {
          entry.running = undefined;
        });
        entry.running = { job, startedAt: now };
      }
      // The pass does not wait for a read. Thus the alarm of the down copy goes out in this pass.
      return Promise.resolve();
    },
    nextReadAt() {
      if (!checked) return undefined;
      const times = entries.flatMap((entry) => nextOf(entry) ?? []);
      return times.length === 0 ? undefined : Math.min(...times);
    },
    watches() {
      return options.copies.watches().map((watch) => {
        const billing = byCopy.get(watch.copy)?.billing;
        return billing === undefined ? watch : { ...watch, billing };
      });
    },
    failure: (copy) => byCopy.get(copy)?.failure,
    health: () => entries.map((entry) => ({ what: `billing of ${entry.copy}`, at: entry.passedAt ?? null, failed: entry.failure !== undefined, next: nextOf(entry) ?? null })),
    settled: () => Promise.all(entries.map((entry) => entry.running?.job)).then(() => undefined),
    shift(size) {
      for (const entry of entries) {
        if (entry.next !== undefined) entry.next += size;
        if (entry.running !== undefined) entry.running.startedAt += size;
        if (entry.billing !== undefined) entry.billing = { ...entry.billing, at: entry.billing.at + size };
        if (entry.passedAt !== undefined) entry.passedAt += size;
      }
    },
  };
}
