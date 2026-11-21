/**
 * This module holds the worker of the exchange of the copies (AL-16). The design is in the section "The exchange" of
 * `docs/CONTRACTS.md`.
 *
 * - The worker reads the log of each other copy, one page after the other, and adds the shared events to the log of this copy.
 * - Each read that passes gives the watch of its copy: the difference of the two clocks and the hash of the configuration.
 * - The transport of a read is a parameter, `ExchangeCall`. Thus a test gives two runtimes and a call in memory.
 * - The worker keeps the watches in memory only. After a restart, the watch of each copy starts again.
 */
import type { Clock, WallClock } from "@mark1russell7/algebra/clock";
import { copyStages, type CopyPeer, type CopyRead, type CopyWatch, type Duration, type Instant } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import { workerLoop, type WorkerLoop } from "@mark1russell7/service";
import { errorMessage } from "@mark1russell7/text";
import { CLOCK_SKEW_LIMIT, COPY_MAX_AGE, EXCHANGE_EVERY, EXCHANGE_LIMIT, EXCHANGE_ROUND_PAGES } from "./copy.ts";
import { EXCHANGE_PAGE, parsePage, type ExchangePage, type ReceivedPage } from "./exchange.ts";
import { limited } from "./limit.ts";
import type { CopyChecks, Runtime } from "./runtime.ts";

/** The input of the procedure `alerts.log.entries`. */
export interface EntriesInput {
  /** The position of the log after which the page starts. */
  readonly after: number;
  /** The most entries of the log that the page examines. The default and the maximum are `EXCHANGE_PAGE`. */
  readonly limit?: number;
}

/** The output of the procedure `alerts.log.entries`. */
export interface EntriesOutput {
  readonly page: ExchangePage;
  /** The time of the copy after it made the page, on the clock of its runtime. */
  readonly time: Instant;
  /** The hash of the configuration of the copy. */
  readonly configHash: string;
  /**
   * The last start of each drill of the copy, by the id of the drill (AL-43). The watch of each other copy reads them. A
   * copy of an older build gives none.
   */
  readonly drills?: Readonly<Record<string, Instant>>;
  /**
   * This value tells if the copy is steady: the passes of its start span `LOUD_STEADY` or more (AL-108). The watch of each
   * other copy reads it. A copy of an older build gives none.
   */
  readonly steady?: boolean;
}

/** The output of the procedure `alerts.log.entries` after its checks on the side of the reader. */
export interface ReceivedEntries {
  readonly page: ReceivedPage;
  readonly time: Instant;
  readonly configHash: string;
  /** The starts of the drills of the answer. An answer with no starts, or with starts that are not valid, gives none. */
  readonly drills?: Readonly<Record<string, Instant>>;
  /** This value tells if the copy is steady. An answer with no value, or with a value that is not a boolean, gives none. */
  readonly steady?: boolean;
}

/** The parts of a runtime that serve the procedure `alerts.log.entries`. */
export interface EntriesSource {
  readonly runtime: Pick<Runtime, "share">;
  /** The clock of the runtime. */
  readonly clock: WallClock;
  /** The hash of the configuration of the runtime. */
  readonly configHash: string;
  /** This function gives the last start of each drill of the runtime. Without it, the answer gives no starts. */
  readonly drills?: () => Readonly<Record<string, Instant>>;
  /** This function tells if the runtime is steady. Without it, the answer tells nothing. */
  readonly steady?: () => boolean;
}

/** The longest hash of a configuration that a reader accepts. */
const HASH_LENGTH = 200;

/**
 * This function gives the output of the procedure `alerts.log.entries`: the page of the shared events after `after`.
 *
 * @throws Error when the position or the limit is not valid. The message holds no value of the input.
 */
export function serveEntries(source: EntriesSource, input: EntriesInput): EntriesOutput {
  const { after, limit } = input;
  if (!(Number.isSafeInteger(after) && after >= 0)) throw new Error("The position after is not a whole number of 0 or more.");
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= EXCHANGE_PAGE)) throw new Error(`The limit is not a whole number from 1 to ${EXCHANGE_PAGE}.`);
  const page = source.runtime.share(after, limit);
  return {
    page,
    time: source.clock.now(),
    configHash: source.configHash,
    ...(source.drills === undefined ? {} : { drills: source.drills() }),
    ...(source.steady === undefined ? {} : { steady: source.steady() }),
  };
}

/** This function checks the output of the procedure `alerts.log.entries` on the side of the reader. A problem holds no value. */
export function parseEntries(value: unknown): Result<ReceivedEntries, readonly string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err(["The answer is not an object."]);
  const { page, time, configHash, drills, steady } = value as Readonly<Record<string, unknown>>;
  const problems: string[] = [];
  if (!(typeof time === "number" && Number.isFinite(time))) problems.push("The time of the answer is not a finite number.");
  if (!(typeof configHash === "string" && configHash.length > 0 && configHash.length <= HASH_LENGTH)) problems.push(`The hash of the configuration is not a text of 1 to ${HASH_LENGTH} characters.`);
  const parsed = parsePage(page);
  if (parsed.tag === "err") problems.push(...parsed.error);
  if (problems.length > 0 || parsed.tag === "err") return err(problems);
  const starts = drillStarts(drills);
  // A steady value that is not a boolean gives none, and the read still passes, as with the starts of the drills.
  return ok({ page: parsed.value, time: time as Instant, configHash: configHash as string, ...(starts === undefined ? {} : { drills: starts }), ...(typeof steady === "boolean" ? { steady } : {}) });
}

// The longest id of a drill, as the schema of the configuration has it.
const DRILL_ID_LENGTH = 32;

// The starts of the drills of an answer. A field that is not valid gives none, and the read still passes: the watch of the
// drills then tells that it has no read (AL-43). The pages of the log stay the test of the exchange.
function drillStarts(value: unknown): Readonly<Record<string, Instant>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  const valid = entries.every(([id, at]) => id.length > 0 && id.length <= DRILL_ID_LENGTH && typeof at === "number" && Number.isFinite(at));
  return valid ? (Object.fromEntries(entries) as Readonly<Record<string, Instant>>) : undefined;
}

/**
 * The transport of one read of another copy: the call of the procedure `alerts.log.entries` of the copy. The value is
 * the output as it came on the wire. The worker checks it. A call stops at the abort of the signal.
 */
export type ExchangeCall = (peer: CopyPeer, input: EntriesInput, signal: AbortSignal) => Promise<unknown>;

/** The options of `exchangeWorker`. */
export interface ExchangeWorkerOptions {
  /** The parts of the runtime of this copy that the worker uses. */
  readonly runtime: Pick<Runtime, "position" | "take">;
  /** The other copies: the peers of `copy.json`. */
  readonly peers: readonly CopyPeer[];
  readonly call: ExchangeCall;
  /** The clock of the runtime. The times of the watches are on it. */
  readonly clock: WallClock;
  /** The hash of the configuration of this copy. */
  readonly configHash: string;
  /** The time limit of one read. The default is `EXCHANGE_LIMIT`. */
  readonly limit?: Duration;
  /** The longest time with no read that passed. The default is `COPY_MAX_AGE`. */
  readonly maxAge?: Duration;
  /** The largest difference of the two clocks with no stage `skew`. The default is `CLOCK_SKEW_LIMIT`. */
  readonly skewLimit?: Duration;
  /** The most pages of one copy in one round. The default is `EXCHANGE_ROUND_PAGES`. */
  readonly pages?: number;
  /** The most entries that one page examines. Without it, the other copy gives `EXCHANGE_PAGE` entries. */
  readonly entries?: number;
}

/** The result of one round of the worker. */
export interface ExchangeRound {
  /** The count of the imports of the round. */
  readonly imports: number;
  /** This value tells if a copy has entries after the last page of the round. Then the next round starts at once. */
  readonly more: boolean;
  /** This value tells if the round changed the log or a stage of a copy. Then the next pass starts soon. */
  readonly changed: boolean;
  /** The problems of the pages, each with the id of its copy. A problem holds no value of an event. */
  readonly problems: readonly string[];
  /** The ids of the imports with the id of a different event of the log. The log kept its event. */
  readonly conflicts: readonly string[];
}

/** The worker of the exchange. It gives the runtime its watches of the copies, as `CopyChecks`. */
export interface ExchangeWorker extends CopyChecks {
  /** The longest time of one round: the time limit of each page of a copy. The copies go at the same time. */
  readonly bound: Duration;
  /**
   * This method reads each other copy until the copy has no more entries, or for `pages` pages. It does not throw. A
   * round during a round gives the round in flight. The signal `stop` aborts each read.
   */
  round(stop?: AbortSignal): Promise<ExchangeRound>;
  /** This method gives the message of the last read of a copy when it failed. */
  failure(copy: string): string | undefined;
}

// The result of the reads of one copy in one round.
interface CopyResult {
  readonly imports: number;
  readonly more: boolean;
  readonly problems: readonly string[];
  readonly conflicts: readonly string[];
}

type Answer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/**
 * This function makes the worker of the exchange.
 *
 * @throws Error when two peers have the same id, or when a time or a count is not valid.
 */
export function exchangeWorker(options: ExchangeWorkerOptions): ExchangeWorker {
  const { runtime, peers, clock, configHash } = options;
  const limit = options.limit ?? EXCHANGE_LIMIT;
  const maxAge = options.maxAge ?? COPY_MAX_AGE;
  const skewLimit = options.skewLimit ?? CLOCK_SKEW_LIMIT;
  const pages = options.pages ?? EXCHANGE_ROUND_PAGES;
  for (const [name, value] of Object.entries({ limit, maxAge, skewLimit, pages, ...(options.entries === undefined ? {} : { entries: options.entries }) })) {
    if (!(Number.isSafeInteger(value) && value > 0)) throw new Error(`The value ${name} of the exchange worker is not a whole number above 0.`);
  }
  const ids = peers.map((peer) => peer.id);
  if (new Set(ids).size !== ids.length) throw new Error("Two peers of the exchange worker have the same id.");

  let since: Instant = clock.now();
  const reads = new Map<string, CopyRead>();
  // The starts of the drills of the last read that passed, by the id of the copy. They are on the clock of that copy.
  const starts = new Map<string, Readonly<Record<string, Instant>>>();
  // The first read that passed and told that the copy is not steady, after its last steady read, by the id of the copy (AL-108).
  const unsteady = new Map<string, Instant>();
  const failures = new Map<string, string>();
  // Each shift moves the times into a new frame. A read with a shift during its call has times of two frames.
  let frames = 0;
  let running: Promise<ExchangeRound> | undefined;
  let firstEnd: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    firstEnd = resolve;
  });
  if (peers.length === 0) firstEnd();
  let ready: Promise<void> | undefined;

  const watches = (): CopyWatch[] =>
    peers.map((peer) => {
      const read = reads.get(peer.id);
      const drills = starts.get(peer.id);
      const unsteadySince = unsteady.get(peer.id);
      return { copy: peer.id, skewLimit, maxAge, since, ...(read === undefined ? {} : { read }), ...(drills === undefined ? {} : { drills }), ...(unsteadySince === undefined ? {} : { unsteadySince }) };
    });
  // A new start of a drill of a copy changes the watch of the drills, thus it is a change of the round.
  const stagesAt = (at: Instant): string => JSON.stringify(watches().map((watch) => [copyStages(watch, at), watch.drills ?? null]));

  const call = async (peer: CopyPeer, after: number, stop: AbortSignal | undefined): Promise<Answer | undefined> => {
    if (stop?.aborted === true) return undefined;
    const own = new AbortController();
    let stopped = false;
    // A stop ends the read at once, also when the transport misses an abort that came before its call.
    let halt: (answer: Answer) => void = () => undefined;
    const halted = new Promise<Answer>((resolve) => {
      halt = resolve;
    });
    const onStop = (): void => {
      stopped = true;
      own.abort(stop?.reason);
      halt({ ok: false, message: `The stop ended the read of the copy ${peer.id}.` });
    };
    stop?.addEventListener("abort", onStop, { once: true });
    const input: EntriesInput = { after, ...(options.entries === undefined ? {} : { limit: options.entries }) };
    const work = Promise.resolve().then(() => options.call(peer, input, own.signal)).then((value): Answer => ({ ok: true, value }));
    const late = (): Answer => ({ ok: false, message: `The read of the copy ${peer.id} took longer than ${limit} ms.` });
    const thrown = (error: unknown): Answer => ({ ok: false, message: `The read of the copy ${peer.id} failed: ${errorMessage(error)}` });
    const answer = await limited(Promise.race([work, halted]), limit, clock, late, thrown);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error("The read of the copy ended."));
    // A read that the stop ended is not a fault of the other copy.
    return stopped ? undefined : answer;
  };

  const readCopy = async (peer: CopyPeer, stop: AbortSignal | undefined): Promise<CopyResult> => {
    let imports = 0;
    const problems: string[] = [];
    const conflicts: string[] = [];
    const result = (more: boolean): CopyResult => ({ imports, more, problems, conflicts });
    for (let page = 0; page < pages; page += 1) {
      const after = runtime.position(peer.id);
      const frame = frames;
      const started = clock.now();
      const answer = await call(peer, after, stop);
      if (answer === undefined) return result(false);
      const ended = clock.now();
      if (!answer.ok) {
        failures.set(peer.id, answer.message);
        return result(false);
      }
      const parsed = parseEntries(answer.value);
      if (parsed.tag === "err") {
        failures.set(peer.id, `The answer of the copy ${peer.id} is not valid: ${parsed.error.join(" ")}`);
        return result(false);
      }
      const entries = parsed.value;
      if (entries.page.copy !== peer.id) {
        failures.set(peer.id, `The page of the copy ${peer.id} names another copy.`);
        return result(false);
      }
      let take: ReturnType<Runtime["take"]>;
      try {
        take = runtime.take(entries.page);
      } catch (error) {
        failures.set(peer.id, `The import of a page of the copy ${peer.id} failed: ${errorMessage(error)}`);
        return result(false);
      }
      imports += take.imports;
      problems.push(...take.problems.map((problem) => `${peer.id}: ${problem}`));
      conflicts.push(...take.conflicts);
      failures.delete(peer.id);
      // The middle of the call is the best guess of the time of the answer. A shift during the call mixes two frames,
      // thus the read keeps its imports and gives no times. The next read gives them.
      if (frames === frame) {
        const at = Math.round(started + (ended - started) / 2);
        reads.set(peer.id, { at, skew: entries.time - at, sameConfig: entries.configHash === configHash });
        if (entries.drills === undefined) starts.delete(peer.id);
        else starts.set(peer.id, entries.drills);
        // A copy of an older build tells nothing. Thus only an answer that tells `false` keeps the copy unsteady.
        if (entries.steady !== false) unsteady.delete(peer.id);
        else if (!unsteady.has(peer.id)) unsteady.set(peer.id, at);
      }
      if (take.next >= entries.page.head || take.next === after) return result(false);
    }
    return result(true);
  };

  return {
    bound: limit * pages,
    round(stop) {
      running ??= (async (): Promise<ExchangeRound> => {
        const before = stagesAt(clock.now());
        const results = await Promise.all(peers.map((peer) => readCopy(peer, stop)));
        const imports = results.reduce((sum, one) => sum + one.imports, 0);
        return {
          imports,
          more: results.some((one) => one.more),
          changed: imports > 0 || stagesAt(clock.now()) !== before,
          problems: results.flatMap((one) => one.problems),
          conflicts: results.flatMap((one) => one.conflicts),
        };
      })().finally(() => {
        running = undefined;
        firstEnd();
      });
      return running;
    },
    watches,
    shift(size) {
      // The skew is the time of the other copy minus `at`. Thus a move of `at` moves the skew back by the same size.
      since += size;
      for (const [copy, read] of reads) reads.set(copy, { ...read, at: read.at + size, skew: read.skew - size });
      for (const [copy, at] of unsteady) unsteady.set(copy, at + size);
      frames += 1;
    },
    ready() {
      ready ??= new Promise<void>((resolve) => {
        const cancel = clock.after(limit, resolve);
        void first.then(() => {
          cancel();
          resolve();
        });
      });
      return ready;
    },
    failure: (copy) => failures.get(copy),
  };
}

const ms = (value: number) => ({ value, unit: "ms" });

/** The options of `exchangeLoop`. */
export interface ExchangeLoopOptions {
  readonly worker: Pick<ExchangeWorker, "round" | "bound">;
  /** The monotonic clock of the service: the clock of the lifecycle. */
  readonly clock: Clock;
  /** The sleep between two rounds. The default is `EXCHANGE_EVERY`. */
  readonly every?: Duration;
  /** This function receives each round. The runtime wakes its loop here when the round changed something. */
  readonly onRound?: (round: ExchangeRound) => void;
  /** This function receives each failed round. A round does not throw, thus only a fault of `onRound` comes here. */
  readonly onError?: (error: unknown, failures: number) => void;
  /** This function gives the random numbers of the jitter of a wait, from 0 up to 1. */
  readonly random?: () => number;
}

/**
 * This function makes the loop of the worker: a worker loop of `@mark1russell7/service` with one lane. It sleeps
 * `every` after each round. After a round with more entries, the next round starts at once.
 */
export function exchangeLoop(options: ExchangeLoopOptions): WorkerLoop {
  const every = options.every ?? EXCHANGE_EVERY;
  return workerLoop(
    {
      worker_sleep: ms(every),
      unit_processing_time: ms(options.worker.bound),
      retry_base: ms(every),
      retry_cap: ms(every),
      // The close does not wait for a round. The abort ends each read, and a take after the close of the log throws.
      // Then the round ends with a failure of the copy.
      close_bound: ms(0),
      concurrency: { value: 1, unit: "count" },
    },
    {
      clock: options.clock,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      iteration: async ({ signal }) => {
        const round = await options.worker.round(signal);
        options.onRound?.(round);
        return round.more ? "more" : undefined;
      },
    },
  );
}
