/**
 * The outage call of the instance: its setup from the private files, and the worker that keeps its
 * Functions on the server of Twilio current.
 *
 * - The outside check calls the entry of the Functions when the instance is down. Thus the Functions must be current before an outage.
 * - The worker deploys at the steady time of each start: `steadyWait` after the start is good (AL-112). Before that time it deploys
 *   nothing and loads no bundle, thus esbuild does not compete with the start. A start that does not get steady deploys nothing,
 *   and the Functions that Twilio has stay as they are.
 * - A change of the private files restarts the runtime. Thus a new list deploys at the steady time of the next start.
 * - A deploy reads the bundles from the file that the stage of the slot wrote. Only a missing or old file starts esbuild,
 *   and that deploy writes the file again (AL-112).
 * - Once in each day, the worker deploys again. A deploy with no change reads three lists. Thus a change on the side of Twilio heals in a day.
 * - A failed deploy goes again after a backoff. The worker runs beside the passes, so a slow build of Twilio holds no alert.
 */
import { sendCapUsd, type Duration, type Instant, type ParsedConfig, type SecretLookup, type SpendConfig } from "@mark1russell7/alerts";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  deployOutage,
  OUTAGE_MONTH_MAX,
  outageListOf,
  OUTAGE_TEXT_MESSAGE,
  TWILIO_CALL_COST_USD,
  twilioCallDescriptor,
  type BundleStore,
  type OutageList,
  type OutageMonthCap,
  type TwilioCredentials,
  type TwilioFetch,
  type TwilioServerlessDeployResult,
} from "@mark1russell7/alerts-channel-twilio";
import { delay, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import { err, ok, type Result } from "@mark1russell7/optional";
import { workerLoop, type WorkerLoop } from "@mark1russell7/service";
import { writeFileAtomic } from "@procedures/fs/files";
import { errorMessage } from "@mark1russell7/text";
import { spendEntryOf, spendQuota, spendUnits } from "./balance.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The name of the key of `secrets.env` that holds the token of the entry of the outage call. */
export const OUTAGE_TOKEN_KEY = "OUTAGE_TOKEN";

// A token of 32 or more characters of the URL alphabet. The webhook sends it in the query, so it needs no escape.
const TOKEN_FORM = /^[A-Za-z0-9_-]{32,128}$/u;

/** The setup of the outage call. Each value is private. */
export interface OutageSetup {
  readonly credentials: TwilioCredentials;
  readonly list: OutageList;
  readonly token: string;
  /** The Twilio number that makes the calls. It is the number of the call channel. */
  readonly from: string;
  /** The Twilio number that sends the texts, from the keys. Without it, the list has no text. */
  readonly textFrom?: string;
}

/** The keys of Twilio that the outage call reads: the credentials, the number of the call channel and the number of the texts. */
export interface OutageKeys {
  readonly credentials: TwilioCredentials;
  readonly from: string;
  /** The number of the text channel. The function `twilioSetup` of the instance reads it from `secrets.env`, and checks its form. */
  readonly textFrom?: string | undefined;
}

/**
 * This function gives the monthly cap of the outage call from the spend entry of Twilio. The cap is the whole calls of
 * one month in the cap of the entry, and its month starts in the time zone of the entry. The reserve is a part of the
 * cap, and the outage call can use it. A cap above `OUTAGE_MONTH_MAX` calls takes that count. A text costs no more
 * than a call, and the cap counts it as one call. The fixed costs of the entry come off the cap first. When they use
 * all of it, the cap is 0 calls.
 */
export function outageMonthCapOf(spend: Pick<SpendConfig, "monthlyUsd" | "fixed" | "timeZone">): OutageMonthCap {
  const { monthlyUsd, fixed, timeZone } = spend;
  if (!(sendCapUsd(spend) > 0)) return { maxCalls: 0, timeZone };
  const cents = spendQuota({ name: "Twilio spend", monthlyUsd, ...(fixed === undefined ? {} : { fixed }), timeZone }).limit;
  return { maxCalls: Math.min(OUTAGE_MONTH_MAX, Math.floor(cents / spendUnits(TWILIO_CALL_COST_USD))), timeZone: spend.timeZone };
}

/**
 * This function gives the setup of the outage call from the configuration and the secrets.
 *
 * - With no field `outage` in the configuration, it gives `undefined`. The instance then deploys nothing.
 * - The outage call needs the keys of Twilio and the key `OUTAGE_TOKEN`. Without them, or with a bad list, it gives the problems.
 * - The outage call needs a spend entry for Twilio. The monthly cap of its Functions comes from it.
 * - With the number of the texts in the keys, the list has the text `OUTAGE_TEXT_MESSAGE`, and the deploy gives the number to the Functions.
 *   Only a person whose number is on the opt-in list gets the text.
 *
 * A problem names keys, fields and ids, and no value.
 */
export function outageSetup(parsed: ParsedConfig, secret: SecretLookup, keys: OutageKeys | undefined): Result<OutageSetup | undefined, readonly string[]> {
  const outage = parsed.config.outage;
  if (outage === undefined) return ok(undefined);
  const problems: string[] = [];
  if (keys === undefined) problems.push("The configuration has an outage call, and the secret store has no keys of Twilio that pass the check. The Functions of the call need them.");
  const token = secret(OUTAGE_TOKEN_KEY) ?? "";
  if (token === "") problems.push(`The configuration has an outage call, and the secret store has no value for ${OUTAGE_TOKEN_KEY}, the token of its entry.`);
  else if (!TOKEN_FORM.test(token)) problems.push(`The value of ${OUTAGE_TOKEN_KEY} is not 32 to 128 letters, digits, "-" or "_".`);
  const spend = spendEntryOf(twilioCallDescriptor(), parsed.config.spend);
  if (spend === undefined) {
    problems.push("The configuration has an outage call, and no spend entry for the provider of the calls. The monthly cap of the Functions comes from it.");
    return err(problems);
  }
  const textFrom = keys?.textFrom;
  // The text goes only to a number with a record of the opt-in list. A STOP reply stops it at Twilio.
  const optIn = (number: string): boolean => parsed.optIn.some((record) => record.number === number);
  const list = outageListOf(outage, parsed.recipients, outageMonthCapOf(spend), textFrom === undefined ? {} : { textMessage: OUTAGE_TEXT_MESSAGE, optIn });
  problems.push(...list.problems);
  if (problems.length > 0 || keys === undefined) return err(problems);
  return ok({ credentials: keys.credentials, from: keys.from, list: list.list, token, ...(textFrom === undefined ? {} : { textFrom }) });
}

/** The state of the deploy of the outage call. It holds no private value, so the status of the instance can show it. */
export type OutageDeployState =
  | { readonly state: "pending" }
  | { readonly state: "current"; readonly at: Instant; readonly changed: boolean }
  | { readonly state: "failed"; readonly at: Instant; readonly stage: string; readonly failures: number };

/** The options of the worker of the deploy. */
export interface OutageDeployOptions {
  /** This function does one deploy. It stops at the abort of the signal. */
  readonly deploy: (signal: AbortSignal) => Promise<TwilioServerlessDeployResult>;
  /** The monotonic clock of the service. The sleeps, the backoffs and the bound of a deploy use it. */
  readonly clock: Clock;
  /** The clock of the times of the state. */
  readonly wall: WallClock;
  /**
   * The longest time of one deploy. At it, the worker aborts the deploy. Give the pass limit. The drain
   * of the service holds the pass limit. Thus the drain does not cut a deploy before its bound.
   */
  readonly limit: Duration;
  /** The time between two deploys that pass. The default is one day. */
  readonly every?: Duration;
  /**
   * The wait from the good start of the copy (`steady()`) to its first deploy. The default is 10 minutes. A copy that stops in
   * this wait deploys nothing.
   */
  readonly steadyWait?: Duration;
  /**
   * The wait after the first failed deploy. The wait doubles after each failure in sequence, up to `retryCap`.
   * A jitter of up to one `retryBase` adds to each wait. The default is one minute.
   */
  readonly retryBase?: Duration;
  /** The longest wait after a failed deploy. The default is one hour. */
  readonly retryCap?: Duration;
  /** This function gives the random numbers of the jitter of the backoff, from 0 up to 1. The default is `Math.random`. */
  readonly random?: () => number;
  /** This function receives one line for each deploy that changed the Functions. */
  readonly log?: (line: string) => void;
  /** This function receives each failed deploy, with the count of failures in sequence. */
  readonly onError?: (error: unknown, failures: number) => void;
}

/** The worker of the deploy, and its state. */
export interface OutageDeployWorker {
  /** The worker loop. The service declares it: `svc.worker(name, worker.knobs, worker)`. */
  readonly worker: WorkerLoop;
  /** This method gives the state of the last deploy. */
  state(): OutageDeployState;
  /**
   * This method tells the worker that the start of the copy is good. The first deploy comes `steadyWait` after the first call.
   * Before the first call, the worker deploys nothing. A second call changes nothing.
   */
  steady(): void;
}

const ms = (value: number) => ({ value, unit: "ms" });

/**
 * This function makes the worker of the deploy of the outage call. The first deploy comes `steadyWait` after the call of
 * `steady()`. A failed deploy throws in the worker, so the worker waits its backoff.
 *
 * The service starts each iteration of a worker after its startup, before the start is good. Thus an iteration before the
 * steady time ends with no deploy, and the wake at the steady time starts the first deploy.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0.
 */
export function outageDeployWorker(options: OutageDeployOptions): OutageDeployWorker {
  const every = options.every ?? DAY;
  const retryBase = options.retryBase ?? MINUTE;
  const retryCap = options.retryCap ?? HOUR;
  const steadyWait = options.steadyWait ?? 10 * MINUTE;
  for (const [name, value] of Object.entries({ limit: options.limit, every, steadyWait, retryBase, retryCap })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the deploy of the outage call is not a whole count of milliseconds above 0.`);
  }
  if (retryCap < retryBase) throw new Error("The longest wait of the deploy of the outage call is shorter than its first wait.");
  let state: OutageDeployState = { state: "pending" };
  // The time of the first deploy on the monotonic clock, from the first call of steady(). Before it, an iteration does not deploy.
  let steadyAt: number | undefined;
  let cancelWake: (() => void) | undefined;
  // The worker loop counts the failures in sequence before each iteration. This deploy is one more.
  const fail = (stage: string, message: string, before: number): never => {
    state = { state: "failed", at: options.wall.now(), stage, failures: before + 1 };
    throw new Error(`The deploy of the outage call failed at the stage ${stage}: ${message}`);
  };
  const worker = workerLoop(
    {
      worker_sleep: ms(every),
      unit_processing_time: ms(options.limit),
      retry_base: ms(retryBase),
      retry_cap: ms(retryCap),
      // The drain gives the deploy its abort. A deploy can go again, so the close waits for none.
      close_bound: ms(0),
      concurrency: { value: 1, unit: "count" },
    },
    {
      clock: options.clock,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      setup: () => undefined,
      iteration: async ({ signal, failures }) => {
        // No deploy before the steady time: the deploy loads the bundles and esbuild (AL-112). The wake of steady() ends the sleep.
        if (steadyAt === undefined || options.clock.now() < steadyAt) return undefined;
        let result: TwilioServerlessDeployResult;
        try {
          result = await options.deploy(signal);
        } catch (error) {
          // Only the bundles, a plan that breaks a rule and an abort throw. A deploy gives each failure of a request as a value.
          return fail(signal.aborted ? "abort" : "plan", errorMessage(error), failures);
        }
        if (!result.ok) return fail(result.stage, result.errors.join(" "), failures);
        state = { state: "current", at: options.wall.now(), changed: result.changed };
        if (result.changed) options.log?.("The deploy of the outage call changed the Functions. The new build is live.");
        return undefined;
      },
      teardown: () => {
        cancelWake?.();
        cancelWake = undefined;
      },
    },
  );
  const steady = (): void => {
    if (steadyAt !== undefined) return;
    steadyAt = options.clock.now() + steadyWait;
    cancelWake = options.clock.after(steadyWait, () => {
      cancelWake = undefined;
      worker.wake();
    });
  };
  return { worker, state: () => state, steady };
}

/** The effects of the deploy of the instance. */
export interface OutageDeployPorts {
  readonly fetch: TwilioFetch;
  readonly clock: Clock;
  readonly log?: (line: string) => void;
  /** The store of the file of the bundles (AL-112). Without it, each deploy makes the bundles with esbuild. */
  readonly bundles?: BundleStore;
}

/**
 * This function gives the store of the file of the bundles at `path`. A read of a missing file gives `undefined`. A write
 * makes the folder, and it replaces the file in one step. Thus a reader does not get half of a file.
 */
export function fileBundleStore(path: string): BundleStore {
  return {
    read: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as { readonly code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    write: async (text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, text);
    },
  };
}

/** This function gives the deploy of a setup: the bundles, the plan and the requests of `deployOutage`. */
export function outageDeploy(setup: OutageSetup, ports: OutageDeployPorts): (signal: AbortSignal) => Promise<TwilioServerlessDeployResult> {
  const { credentials, list, token, from, textFrom } = setup;
  return (signal) =>
    deployOutage(
      {
        fetch: ports.fetch,
        now: () => ports.clock.now(),
        sleep: (wait) => delay(ports.clock, wait, signal),
        signal,
        ...(ports.log === undefined ? {} : { log: ports.log }),
      },
      credentials,
      { list, token, from, ...(textFrom === undefined ? {} : { textFrom }) },
      { ...(ports.bundles === undefined ? {} : { store: ports.bundles }), ...(ports.log === undefined ? {} : { log: ports.log }) },
    );
}
