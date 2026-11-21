/**
 * AL-13, case 12: faults of the SQLite file of the log under the runtime. The runtime keeps its log in a file of
 * `openRuntimeLog`, as an instance does. The loop of the runtime goes on a fake monotonic clock. The case moves the fake
 * time in steps of `tickMs`, and it holds the fake time while a pass is in flight.
 *
 * The runtime sends a `life-safety` alert through the Pushover channel to the scripted Pushover API of
 * `@procedures/notify/testing`. The heartbeat of the runtime pings a fake check. The source has the interval of the
 * IPAWS source of an instance, thus the loop has the times of production. The arms:
 *
 * - `control`: no fault.
 * - `busy-attempt`: a second connection holds the write lock of the file from the first write of an `attempt` row, for `lockMs`.
 * - `busy-delivery`: the same lock from the first write of a `delivery` row. The API has the message, and the log does not.
 * - `busy-long`: the lock of `busy-attempt` for `longLockMs`. This time is longer than the gap of the heartbeat.
 * - `broken-at-boot`: a first life delivers the alert and stops. The case breaks one page of an index of the file. A
 *   second life opens the broken file with the open of `main.ts`.
 *
 * The gates of the arms with a lock, from the ledger of the API, the log, the pings and the monotonic time of each request:
 *
 * - `delivered`, `single` and `stopped`: the gates of case 4 (`acceptGatesOf`).
 * - `copyOnce` and `oneCopy`: each copy id has one send, and the API gets one send.
 * - `attempted`: the log has an `attempt` row for the copy of each send.
 * - `noThrow`, in `control`: no pass throws.
 * - `noSendLocked`, in `busy-attempt` and `busy-long`: no send goes in the lock.
 * - `noPingLocked`: no ping goes in the lock. Thus the outside check sees the fault.
 * - `promptAfter`: the first send after the lock, or the first `delivery` row in `busy-delivery`, comes by one `retryCap` after the lock.
 * - `pingAfter`, in `busy-long`: the first success ping comes by one heartbeat interval after the lock.
 *
 * The gates of `broken-at-boot`:
 *
 * - `bootOk`: the second life opens the file, and no pass throws.
 * - `kept`: a file of the folder of the log, other than the live file, has the bytes of the broken file.
 * - `salvaged`: the log of the second life has each event of the first life.
 * - `noPageAgain`: the second life sends no copy, because the log keeps the acknowledgment.
 * - `lossReported`: the second life writes one system report that names the quarantine.
 *
 * The case found the fault AL-50: the runtime opened a broken file with no check. Each write to the broken index threw,
 * and the log had no report of the loss. The fix of AL-50 (alerts #157) checks the file at the boot. A broken file goes
 * into quarantine, a salvage starts a new log, and a system report names the quarantine. `openForMain` has that open.
 */
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type FakeClock, fakeClock, fakeWallClock } from "@mark1russell7/algebra/clock";
import type { SourceProcedures } from "@mark1russell7/alerts";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import {
  createLoop,
  DELIVERY_TIMES,
  type DeliveryOptions,
  HEARTBEAT_EVERY,
  heartbeat,
  heartbeatGap,
  type LoopTimes,
  loopTimes,
  openRuntime,
  openCheckedRuntimeLog,
  openRuntimeLog,
  type Pass,
  type RuntimeEvent,
  type RuntimeLog,
} from "@mark1russell7/alerts-runtime";
import { IPAWS_DESCRIPTOR } from "@mark1russell7/alerts-source-ipaws";
import { checkIntegrity, openDatabase } from "@mark1russell7/sqlite";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { errorMessage } from "@mark1russell7/text";
import { type PushoverLedger, pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { deliveryFixture, FIXTURE_PLACE, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";
import { driveFakeLoop, firstFrom, passTracker } from "./fake-loop.ts";
import { type AcceptGate, acceptGatesOf, copyOf, copyOnceOf } from "./late-accept.ts";

/** The id of the case. */
export const CASE_12_ID = "al-13-case-12";

/** The id of the source of the case. */
export const CASE_12_SOURCE = "case-12";

/** The word at the start of the test values of the case. */
export const CASE_12_WORD = "casetwelve";

/** The start of each arm: the instant and the monotonic time of the first pass. */
export const CASE_12_START: number = Date.UTC(2026, 3, 1, 18);

/** The interval of the source of the case: the interval of the IPAWS source of an instance. */
export const CASE_12_INTERVAL: number = IPAWS_DESCRIPTOR.interval;

/** The times of the loop of the case. They are the times of the loop of an instance with the IPAWS source. */
export const CASE_12_LOOP: LoopTimes = loopTimes([{ interval: CASE_12_INTERVAL }], { delivery: DELIVERY_TIMES });

/** The longest time between two success pings of the heartbeat, with the loop times of the case. */
export const CASE_12_GAP: number = heartbeatGap(CASE_12_LOOP);

/** The ping URL of the fake check. No request goes to it. */
export const CASE_12_PING_URL = "https://hc-ping.test/al-13-case-12";

/** The index of the file that `broken-at-boot` breaks. Each write of an event changes it. */
export const BROKEN_INDEX = "events_type";

/** The name of the file of the log in the folder of an arm, as in the home folder of an instance. */
const LOG_FILE = "runtime.sqlite";

/** The files of the live log: the database file, its WAL file and its shared-memory file. */
const LIVE_FILES: ReadonlySet<string> = new Set([LOG_FILE, `${LOG_FILE}-wal`, `${LOG_FILE}-shm`]);

/** A report of the loss names the quarantine. */
const QUARANTINE = /quarantine/i;

/** The error of a write in the lock names the lock or the busy file. */
const BUSY = /locked|busy/i;

/** The source, the person and the test values of the case. */
const FIXTURE = deliveryFixture(CASE_12_SOURCE, CASE_12_WORD);

/** The time after which the escalation of the person ends with no acknowledgment. */
const EXHAUSTED_AFTER: number = FIXTURE.recipient.policies[0]?.exhaustedAfter ?? 0;

/** An arm of the case with a lock of the file, or with no fault. */
export type LockArm = "control" | "busy-attempt" | "busy-delivery" | "busy-long";

/** The arms with a lock, in the order of a start. The case starts `broken-at-boot` after them. */
export const LOCK_ARMS: readonly LockArm[] = ["control", "busy-attempt", "busy-delivery", "busy-long"];

/** The type of the event whose first write starts the lock. */
export type LockedType = "attempt" | "delivery";

/** The lock of an arm: the type of the event that starts it, and its time. */
export interface LockPlan {
  readonly type: LockedType;
  readonly ms: number;
}

/** A gate of an arm with a lock. */
export type LockGate = AcceptGate | "copyOnce" | "oneCopy" | "attempted" | "noThrow" | "noSendLocked" | "noPingLocked" | "promptAfter" | "pingAfter";

/** The gates of the arms with a lock, in their order. */
export const LOCK_GATES: readonly LockGate[] = ["delivered", "single", "stopped", "copyOnce", "oneCopy", "attempted", "noThrow", "noSendLocked", "noPingLocked", "promptAfter", "pingAfter"];

const BASE_GATES: readonly LockGate[] = ["delivered", "single", "stopped", "copyOnce", "oneCopy", "attempted"];

/** The gates of each arm. Only `control` has `noThrow`, because a write in the lock throws. `busy-delivery` sends in the lock. */
export const ARM_LOCK_GATES: Readonly<Record<LockArm, readonly LockGate[]>> = {
  control: [...BASE_GATES, "noThrow"],
  "busy-attempt": [...BASE_GATES, "noSendLocked", "noPingLocked", "promptAfter"],
  "busy-delivery": [...BASE_GATES, "noPingLocked", "promptAfter"],
  "busy-long": [...BASE_GATES, "noSendLocked", "noPingLocked", "promptAfter", "pingAfter"],
};

/** A gate of `broken-at-boot`. */
export type BootGate = "bootOk" | "kept" | "salvaged" | "noPageAgain" | "lossReported";

/** The gates of `broken-at-boot`, in their order. */
export const BOOT_GATES: readonly BootGate[] = ["bootOk", "kept", "salvaged", "noPageAgain", "lossReported"];

/** The settings of the case. Each time is in milliseconds. The delivery uses `DELIVERY_TIMES`, the times of production. */
export interface LogFaultSettings {
  /** The time of the lock of `busy-attempt` and `busy-delivery`. It is longer than the first wait after a failed pass. */
  readonly lockMs: number;
  /** The time of the lock of `busy-long`. It is longer than the gap of the heartbeat. */
  readonly longLockMs: number;
  /** The busy timeout of the connection of the runtime. A write in the lock waits this real time, and then it throws. */
  readonly busyTimeoutMs: number;
  /** The fake time of each step of the case. */
  readonly tickMs: number;
  /** The fake time of one arm with a lock, from its first pass. */
  readonly armMs: number;
  /** The fake time of each life of `broken-at-boot`. */
  readonly bootLifeMs: number;
  /** The count of receipts of the scripted API. */
  readonly receipts: number;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_12_SETTINGS: LogFaultSettings = {
  lockMs: 90_000,
  longLockMs: 600_000,
  busyTimeoutMs: 50,
  tickMs: 250,
  armMs: 900_000,
  bootLifeMs: 180_000,
  receipts: 12,
};

/** This function gives the lock of an arm. `control` has no lock. */
export function lockOf(arm: LockArm, settings: LogFaultSettings = CASE_12_SETTINGS): LockPlan | undefined {
  switch (arm) {
    case "control":
      return undefined;
    case "busy-attempt":
      return { type: "attempt", ms: settings.lockMs };
    case "busy-delivery":
      return { type: "delivery", ms: settings.lockMs };
    case "busy-long":
      return { type: "attempt", ms: settings.longLockMs };
  }
}

/** A text with its monotonic time, from the start of the arm. */
export interface TimedText {
  readonly at: number;
  readonly message: string;
}

/** A ping of the heartbeat: its monotonic time from the start of the arm, and its kind. */
export interface PingNote {
  readonly at: number;
  readonly kind: "success" | "fail";
}

/** The lock of an arm, as the case made it. Each time is from the start of the arm. The lock has no end when it did not end in the arm. */
export interface LockMark {
  readonly type: LockedType;
  readonly from: number;
  readonly to?: number;
}

/** The record of one arm with a lock. */
export interface LockRecord {
  readonly arm: LockArm;
  readonly seed: string;
  /** The times of the loop of the arm. */
  readonly times: LoopTimes;
  readonly lock?: LockMark;
  /** The count of the passes of the arm. */
  readonly passes: number;
  /** The monotonic time of each request that the scripted API got, by its position in the ledger. */
  readonly requests: readonly number[];
  readonly ledger: PushoverLedger;
  readonly log: LogSummary;
  /** The copy id of each `attempt` row of the log. */
  readonly attempts: readonly string[];
  /** The time of each `delivery` row of the log, from the start of the arm. */
  readonly deliveries: readonly number[];
  readonly pings: readonly PingNote[];
  /** The errors that the heartbeat gave. */
  readonly pingErrors: readonly string[];
  /** The errors that the loop got from the passes. */
  readonly loopErrors: readonly TimedText[];
  /** The text of the error of an arm that threw. */
  readonly error?: string;
}

/** One life of `broken-at-boot`. */
export interface BootLife {
  readonly run: string;
  /** The count of the requests that the scripted API got before the life. */
  readonly fromRequest: number;
  readonly passes: number;
  readonly loopErrors: readonly TimedText[];
  /** The id of each event of the log at the end of the life. */
  readonly ids: readonly string[];
  /** The text of each report of the system events that the life wrote. */
  readonly reports: readonly string[];
  /** The text of the error of a life that threw. */
  readonly error?: string;
}

/** The broken file of `broken-at-boot`, after the break. */
export interface BrokenFile {
  /** The number of the page that the case broke: the root page of `BROKEN_INDEX`. */
  readonly page: number;
  readonly pageSize: number;
  /** True when the integrity check of the file found no problem. */
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** The id of each event of the table, read with no index. */
  readonly ids: readonly string[];
}

/** The record of `broken-at-boot`. */
export interface BootRecord {
  readonly arm: "broken-at-boot";
  readonly seed: string;
  readonly first: BootLife;
  readonly broken?: BrokenFile;
  readonly second?: BootLife;
  /** The ledger and the monotonic time of each request of the two lives. */
  readonly ledger: PushoverLedger;
  readonly requests: readonly number[];
  /** What the log of the first life holds at its end. */
  readonly log: LogSummary;
  /** The path of each file of the folder of the log after the second life, from the folder. */
  readonly files: readonly string[];
  /** The path of the file with the bytes of the broken file, other than the live file. */
  readonly kept?: string;
  /** The text of the error of an arm that threw. */
  readonly error?: string;
}

/** The result of one arm with a lock. */
export interface LockResult {
  /** The gates of the arm in `ARM_LOCK_GATES`. */
  readonly gates: Readonly<Partial<Record<LockGate, boolean>>>;
  readonly problems: readonly string[];
}

/** The result of `broken-at-boot`. */
export interface BootResult {
  readonly gates: Readonly<Record<BootGate, boolean>>;
  readonly problems: readonly string[];
}

/** The verdict of the case. A case with no read does not pass. */
export interface LogFaultVerdict {
  /** True when the settings are valid, each arm completed with no error, each fault fell, and `control` passed each gate. */
  readonly read: boolean;
  readonly results: Readonly<Record<LockArm, LockResult>>;
  readonly boot: BootResult;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one start of the case, with the times of the delivery and of the loop. */
export interface LogFaultRun {
  readonly id: string;
  readonly settings: LogFaultSettings;
  readonly times: { readonly pollEvery: number; readonly retry: number; readonly callLimit: number; readonly interval: number; readonly loop: LoopTimes; readonly heartbeatGap: number };
  readonly records: readonly LockRecord[];
  readonly boot: BootRecord;
  readonly verdict: LogFaultVerdict;
}

/** This function gives the source of the case: the source of the fixture, with the interval of the IPAWS source. */
function sourceOf(): SourceProcedures {
  const inner = FIXTURE.sourceOf(CASE_12_START);
  return { ...inner, describe: () => ({ ...inner.describe(), interval: CASE_12_INTERVAL }) };
}

/** The text of a report: its headline, its description and its instruction. */
function reportText(report: { readonly headline?: string; readonly description?: string; readonly instruction?: string }): string {
  return [report.headline, report.description, report.instruction].filter((part) => part !== undefined).join(" ");
}

/** The trace of one life of the runtime: the count of its passes, the errors of its loop and the times of its loop. */
interface LifeTrace {
  passes: number;
  readonly loopErrors: TimedText[];
  times?: LoopTimes;
}

/** The parts of one life of the runtime on a fake clock. */
interface Life {
  readonly run: string;
  readonly log: RuntimeLog;
  readonly mono: FakeClock;
  readonly server: { readonly host: string; readonly port: number };
  /** The monotonic instant of the end of the life. */
  readonly until: number;
  readonly tickMs: number;
  readonly since: () => number;
  readonly onPass?: (pass: Pass) => void;
  readonly beforeTick?: () => void;
  readonly afterTick?: () => void;
}

/** This function opens a runtime on the log of the life, and it drives the loop of the runtime to the end of the life. */
async function driveLife(life: Life, trace: LifeTrace): Promise<void> {
  const { mono, since } = life;
  const wall = fakeWallClock(mono.now(), mono);
  // The channel requests the address of the Pushover API. This fetch sends each request to the scripted API.
  const channel = createPushoverChannel({ token: FIXTURE.token, fetch: pushoverFetchTo(`http://${life.server.host}:${String(life.server.port)}`), now: () => wall.now() });
  const delivery: DeliveryOptions = { recipients: [FIXTURE.recipient], channels: [channel], ...DELIVERY_TIMES };
  let wake = (): void => undefined;
  const runtime = openRuntime({
    log: life.log,
    clock: wall,
    sources: [sourceOf()],
    watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
    view: FIXTURE.view,
    run: life.run,
    delivery,
    wake: () => wake(),
    ...(life.onPass === undefined ? {} : { onPass: life.onPass }),
  });
  const flight = passTracker();
  const loop = createLoop({
    pass: (stop) => {
      trace.passes += 1;
      return flight.track(runtime.pass(stop));
    },
    clock: mono,
    wall,
    times: loopTimes(runtime.config.sources, { delivery }),
    random: () => 0,
    onError: (thrown) => {
      trace.loopErrors.push({ at: since(), message: errorMessage(thrown) });
    },
  });
  trace.times = loop.times;
  wake = () => loop.wake();
  await driveFakeLoop({
    loop,
    clock: mono,
    flight,
    tickMs: life.tickMs,
    until: life.until,
    ...(life.beforeTick === undefined ? {} : { beforeTick: life.beforeTick }),
    ...(life.afterTick === undefined ? {} : { afterTick: life.afterTick }),
  });
}

/**
 * This function gives a log that starts the lock of the plan at the first write of an event of its type. The second
 * connection `holder` takes the write lock of the file with `BEGIN IMMEDIATE`. Thus this write and each later write wait
 * for the busy timeout, and they throw.
 */
function lockingLog(log: RuntimeLog, holder: DatabaseSync, plan: LockPlan, state: { from?: number }, since: () => number): RuntimeLog {
  return {
    read: (types) => log.read(types),
    has: (id) => log.has(id),
    entries: (options) => log.entries(options),
    count: () => log.count(),
    counts: () => log.counts(),
    head: () => log.head(),
    close: () => log.close(),
    appendAll(events, accept) {
      if (state.from === undefined && events.some((event) => event.type === plan.type)) {
        holder.exec("BEGIN IMMEDIATE");
        state.from = since();
      }
      return log.appendAll(events, accept);
    },
  };
}

/** The copy id of each `attempt` row and the time of each `delivery` row of a list of events, from the start of the case. */
function rowsOf(events: readonly RuntimeEvent[]): { readonly attempts: readonly string[]; readonly deliveries: readonly number[] } {
  return {
    attempts: events.flatMap((event) => (event.type === "attempt" ? [event.copy] : [])),
    deliveries: events.flatMap((event) => (event.type === "delivery" ? [event.time - CASE_12_START] : [])),
  };
}

/** This function removes the folder of an arm. A fault of the removal does not change the record. */
function removeFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    // The folder is in the temporary folder of the system. The system removes it later.
  }
}

/**
 * This function starts one arm with a lock. The arm has a scripted API, a log file in a new folder, and a new runtime
 * with its loop and its heartbeat. A second connection to the file holds the write lock as the plan of the arm tells.
 */
export async function runLockArm(arm: LockArm, settings: LogFaultSettings = CASE_12_SETTINGS): Promise<LockRecord> {
  const seed = `${CASE_12_ID}-${arm}`;
  const plan = lockOf(arm, settings);
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const folder = mkdtempSync(join(tmpdir(), `${CASE_12_ID}-`));
  const path = join(folder, LOG_FILE);
  const mono = fakeClock(CASE_12_START);
  const since = (): number => mono.now() - CASE_12_START;
  const file = openRuntimeLog(path, { busyTimeoutMs: settings.busyTimeoutMs });
  // The second connection does not wait for a lock. The runtime holds no lock between two writes.
  const holder = openDatabase(path, { busyTimeoutMs: 0 });
  const state: { from?: number; to?: number } = {};
  const log = plan === undefined ? file : lockingLog(file, holder, plan, state, since);
  const requests: number[] = [];
  const stamp = (): void => {
    while (requests.length < server.requests.length) requests.push(since());
  };
  const pings: PingNote[] = [];
  const pingErrors: string[] = [];
  const beat = heartbeat({
    url: CASE_12_PING_URL,
    fetch: (url) => {
      pings.push({ at: since(), kind: url.endsWith("/fail") ? "fail" : "success" });
      return Promise.resolve({ status: 200 });
    },
    clock: fakeWallClock(mono.now(), mono),
    userAgent: "alerts-testkit/0 (fault suite)",
    onError: (message) => {
      pingErrors.push(message);
    },
  });
  const trace: LifeTrace = { passes: 0, loopErrors: [] };
  let error: string | undefined;
  try {
    await driveLife(
      {
        run: seed,
        log,
        mono,
        server,
        until: CASE_12_START + settings.armMs,
        tickMs: settings.tickMs,
        since,
        onPass: (pass) => beat(pass),
        // The lock ends at a step of the fake time, when no pass is in flight.
        beforeTick: () => {
          if (plan !== undefined && state.from !== undefined && state.to === undefined && since() - state.from >= plan.ms) {
            holder.exec("ROLLBACK");
            state.to = since();
          }
        },
        afterTick: stamp,
      },
      trace,
    );
  } catch (thrown) {
    error = errorMessage(thrown);
  }
  stamp();
  // A lock that did not end in the arm ends here. Its mark has no end.
  if (state.from !== undefined && state.to === undefined) holder.exec("ROLLBACK");
  holder.close();
  const events = [...file.read()];
  const summary = logSummaryOf(file);
  file.close();
  removeFolder(folder);
  const ledger = pushoverLedgerOf([...server.requests]);
  await server.close();
  const lock: LockMark | undefined =
    plan === undefined || state.from === undefined ? undefined : { type: plan.type, from: state.from, ...(state.to === undefined ? {} : { to: state.to }) };
  return {
    arm,
    seed,
    times: trace.times ?? CASE_12_LOOP,
    ...(lock === undefined ? {} : { lock }),
    passes: trace.passes,
    requests,
    ledger,
    log: summary,
    ...rowsOf(events),
    pings,
    pingErrors,
    loopErrors: trace.loopErrors,
    ...(error === undefined ? {} : { error }),
  };
}

/** The open of the log for `broken-at-boot`. `now` is the wall clock of the second life. */
export type BootOpen = (path: string, now: () => number) => RuntimeLog;

/** The open of the log in `main.ts` of the runtime: the check of AL-50, with the quarantine and the salvage of a broken file. */
export const openForMain: BootOpen = (path, now) => openCheckedRuntimeLog(path, { now }).log;

/**
 * This function breaks the file of a closed log: it writes 0 in the first byte of the root page of `BROKEN_INDEX`. That
 * byte holds the type of the page, and 0 is not a type. The table of events stays readable with no index.
 */
export function breakIndex(path: string): BrokenFile {
  const db = openDatabase(path);
  let page: number;
  let pageSize: number;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const size = db.prepare("PRAGMA page_size").get()?.["page_size"];
    const root = db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?").get(BROKEN_INDEX)?.["rootpage"];
    if (typeof size !== "number" || typeof root !== "number") throw new Error(`The file has no page size or no index ${BROKEN_INDEX}.`);
    page = root;
    pageSize = size;
  } finally {
    db.close();
  }
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Uint8Array.of(0), 0, 1, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
  const check = openDatabase(path);
  try {
    const integrity = checkIntegrity(check);
    const ids = check
      .prepare("SELECT id FROM events NOT INDEXED ORDER BY seq")
      .all()
      .map((row) => String(row["id"]));
    return { page, pageSize, ok: integrity.ok, problems: integrity.problems, ids };
  } finally {
    check.close();
  }
}

/**
 * This function starts `broken-at-boot`. The first life delivers the alert on a new log file and stops. The case breaks
 * the file. The second life opens the broken file with `open`, on the same scripted API, for `bootLifeMs`.
 */
export async function runBootArm(settings: LogFaultSettings = CASE_12_SETTINGS, open: BootOpen = openForMain): Promise<BootRecord> {
  const seed = `${CASE_12_ID}-broken-at-boot`;
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const folder = mkdtempSync(join(tmpdir(), `${CASE_12_ID}-`));
  const path = join(folder, LOG_FILE);
  // Each life has its own fake clock. A timer of the first life thus does not fire in the second life.
  let mono = fakeClock(CASE_12_START);
  const since = (): number => mono.now() - CASE_12_START;
  const requests: number[] = [];
  const stamp = (): void => {
    while (requests.length < server.requests.length) requests.push(since());
  };
  const lifeOf = async (index: number, log: RuntimeLog, before: ReadonlySet<string>): Promise<BootLife> => {
    const run = `${seed}-life-${String(index)}`;
    const fromRequest = server.requests.length;
    const trace: LifeTrace = { passes: 0, loopErrors: [] };
    let error: string | undefined;
    try {
      await driveLife({ run, log, mono, server, until: mono.now() + settings.bootLifeMs, tickMs: settings.tickMs, since, afterTick: stamp }, trace);
    } catch (thrown) {
      error = errorMessage(thrown);
    }
    stamp();
    let events: RuntimeEvent[] = [];
    try {
      events = [...log.read()];
    } catch (thrown) {
      error ??= `The read of the log failed: ${errorMessage(thrown)}`;
    }
    const reports = events.flatMap((event) => (event.type === "system" && !before.has(event.id) ? event.reports.map(reportText) : []));
    return { run, fromRequest, passes: trace.passes, loopErrors: trace.loopErrors, ids: events.map((event) => event.id), reports, ...(error === undefined ? {} : { error }) };
  };

  let first: BootLife | undefined;
  let summary: LogSummary = { deliveries: [], acknowledgments: 0, cancelled: [] };
  let broken: BrokenFile | undefined;
  let second: BootLife | undefined;
  let files: string[] = [];
  let kept: string | undefined;
  let error: string | undefined;
  try {
    const log = openRuntimeLog(path);
    let before: ReadonlySet<string> = new Set();
    try {
      first = await lifeOf(1, log, before);
      before = new Set(first.ids);
      summary = logSummaryOf(log);
    } finally {
      log.close();
    }
    broken = breakIndex(path);
    const bytes = readFileSync(path);
    mono = fakeClock(mono.now());
    let reopened: RuntimeLog | undefined;
    try {
      reopened = open(path, () => mono.now());
    } catch (thrown) {
      second = { run: `${seed}-life-2`, fromRequest: server.requests.length, passes: 0, loopErrors: [], ids: [], reports: [], error: `The open of the log threw: ${errorMessage(thrown)}` };
    }
    if (reopened !== undefined) {
      try {
        second = await lifeOf(2, reopened, before);
      } finally {
        reopened.close();
      }
    }
    files = readdirSync(folder, { encoding: "utf8", recursive: true })
      .map((name) => name.split(sep).join("/"))
      .sort();
    kept = files.find((name) => !LIVE_FILES.has(name) && statSync(join(folder, name)).isFile() && readFileSync(join(folder, name)).equals(bytes));
  } catch (thrown) {
    error = errorMessage(thrown);
  }
  stamp();
  removeFolder(folder);
  const ledger = pushoverLedgerOf([...server.requests]);
  await server.close();
  return {
    arm: "broken-at-boot",
    seed,
    first: first ?? { run: `${seed}-life-1`, fromRequest: 0, passes: 0, loopErrors: [], ids: [], reports: [], error: "The first life did not start." },
    ...(broken === undefined ? {} : { broken }),
    ...(second === undefined ? {} : { second }),
    ledger,
    requests,
    log: summary,
    files,
    ...(kept === undefined ? {} : { kept }),
    ...(error === undefined ? {} : { error }),
  };
}

/** This function starts the case: each arm with a lock, in order, and then `broken-at-boot`. It gives the records and the verdict. */
export async function runLogFaults(given: Partial<LogFaultSettings> = {}): Promise<LogFaultRun> {
  const settings: LogFaultSettings = { ...CASE_12_SETTINGS, ...given };
  const records: LockRecord[] = [];
  for (const arm of LOCK_ARMS) records.push(await runLockArm(arm, settings));
  const boot = await runBootArm(settings);
  const { pollEvery, retry, callLimit } = DELIVERY_TIMES;
  return {
    id: CASE_12_ID,
    settings,
    times: { pollEvery, retry, callLimit, interval: CASE_12_INTERVAL, loop: CASE_12_LOOP, heartbeatGap: CASE_12_GAP },
    records,
    boot,
    verdict: logFaultVerdictOf(records, boot, settings),
  };
}

/** This function gives the gates of one record in `ARM_LOCK_GATES`, and a problem for each gate that fails. */
export function lockGatesOf(record: LockRecord, settings: LogFaultSettings = CASE_12_SETTINGS): LockResult {
  const wanted = new Set(ARM_LOCK_GATES[record.arm]);
  const accept = acceptGatesOf(record);
  const { copyOnce, problems: copyProblems } = copyOnceOf(record);
  const problems: string[] = [...accept.problems, ...copyProblems];
  const { arm } = record;

  const oneCopy = record.ledger.counts.sends === 1;
  if (!oneCopy) problems.push(`${arm}: the API got ${String(record.ledger.counts.sends)} sends, not 1.`);

  const logged = new Set(record.attempts);
  const unlogged = record.ledger.messages.filter((message) => {
    const copy = copyOf(message);
    return copy === undefined || !logged.has(copy);
  });
  const attempted = record.ledger.messages.length > 0 && unlogged.length === 0;
  for (const message of unlogged) problems.push(`${arm}: the message ${message.receipt} has no attempt row of its copy in the log.`);

  const noThrow = record.loopErrors.length === 0;
  if (wanted.has("noThrow")) for (const thrown of record.loopErrors) problems.push(`${arm}: a pass threw at ${String(thrown.at)} ms: ${thrown.message}`);

  const from = record.lock?.from;
  const to = record.lock?.to;
  const sends = record.ledger.messages.map((message) => record.requests[message.position]);
  let noSendLocked = false;
  let noPingLocked = false;
  let promptAfter = false;
  let pingAfter = false;
  if (from === undefined || to === undefined) {
    if (wanted.has("noPingLocked")) problems.push(`${arm}: the lock has no start or no end. The gates of the lock fail.`);
  } else {
    const locked = (time: number | undefined): boolean => time !== undefined && time >= from && time <= to;
    const lockedSends = sends.filter(locked).length;
    noSendLocked = lockedSends === 0;
    if (wanted.has("noSendLocked") && !noSendLocked) problems.push(`${arm}: ${String(lockedSends)} sends went in the lock from ${String(from)} ms to ${String(to)} ms, not 0.`);
    const lockedPings = record.pings.filter((ping) => locked(ping.at)).length;
    noPingLocked = lockedPings === 0;
    if (wanted.has("noPingLocked") && !noPingLocked) problems.push(`${arm}: ${String(lockedPings)} pings went in the lock from ${String(from)} ms to ${String(to)} ms, not 0.`);

    const target = arm === "busy-delivery" ? firstFrom(record.deliveries, to) : firstFrom(sends, to);
    const due = to + CASE_12_LOOP.retryCap + settings.tickMs;
    promptAfter = target !== undefined && target <= due;
    if (wanted.has("promptAfter") && !promptAfter) {
      const what = arm === "busy-delivery" ? "delivery row" : "send";
      const came = target === undefined ? "did not come in the arm" : `came at ${String(target)} ms`;
      problems.push(`${arm}: the first ${what} after the lock was due by ${String(due)} ms, and it ${came}.`);
    }

    const ping = firstFrom(
      record.pings.filter((entry) => entry.kind === "success").map((entry) => entry.at),
      to,
    );
    const pingDue = to + HEARTBEAT_EVERY + settings.tickMs;
    pingAfter = ping !== undefined && ping <= pingDue;
    if (wanted.has("pingAfter") && !pingAfter) {
      problems.push(`${arm}: the first success ping after the lock was due by ${String(pingDue)} ms, and it ${ping === undefined ? "did not come in the arm" : `came at ${String(ping)} ms`}.`);
    }
  }

  const all: Readonly<Record<LockGate, boolean>> = { ...accept.gates, copyOnce, oneCopy, attempted, noThrow, noSendLocked, noPingLocked, promptAfter, pingAfter };
  const gates: Partial<Record<LockGate, boolean>> = {};
  for (const gate of ARM_LOCK_GATES[arm]) gates[gate] = all[gate];
  return { gates, problems };
}

/** This function gives the gates of `broken-at-boot`, and a problem for each gate that fails. */
export function bootGatesOf(record: BootRecord): BootResult {
  const problems: string[] = [];
  const { second } = record;

  const bootOk = second !== undefined && second.error === undefined && second.loopErrors.length === 0;
  if (second === undefined) problems.push("broken-at-boot: the second life did not start.");
  else if (second.error !== undefined) problems.push(`broken-at-boot: the second life threw: ${second.error}`);
  else if (second.loopErrors.length > 0) problems.push(`broken-at-boot: ${String(second.loopErrors.length)} passes of the second life threw. The first: ${second.loopErrors[0]?.message ?? ""}`);

  const kept = record.kept !== undefined;
  if (!kept) problems.push("broken-at-boot: no file of the folder of the log, other than the live file, has the bytes of the broken file.");

  const ids = new Set(second?.ids ?? []);
  const lost = record.first.ids.filter((id) => !ids.has(id));
  const salvaged = second !== undefined && lost.length === 0;
  if (!salvaged) problems.push(`broken-at-boot: the log of the second life does not have ${String(lost.length)} of the ${String(record.first.ids.length)} events of the first life.`);

  const again = second === undefined ? [] : record.ledger.messages.filter((message) => message.position >= second.fromRequest);
  const noPageAgain = again.length === 0;
  if (!noPageAgain) problems.push(`broken-at-boot: the second life sent ${String(again.length)} copies. The log of the first life has the acknowledgment.`);

  const losses = (second?.reports ?? []).filter((text) => QUARANTINE.test(text)).length;
  const lossReported = losses === 1;
  if (!lossReported) problems.push(`broken-at-boot: the second life wrote ${String(losses)} system reports that name the quarantine, not 1.`);

  return { gates: { bootOk, kept, salvaged, noPageAgain, lossReported }, problems };
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function logFaultSettingsProblems(settings: LogFaultSettings): string[] {
  const problems: string[] = [];
  const { pollEvery } = DELIVERY_TIMES;
  const { retryBase, retryCap } = CASE_12_LOOP;
  if (!(settings.lockMs > retryBase)) problems.push(`The lock (${String(settings.lockMs)} ms) is not longer than the first wait after a failed pass (${String(retryBase)} ms).`);
  if (!(settings.longLockMs > CASE_12_GAP)) problems.push(`The long lock (${String(settings.longLockMs)} ms) is not longer than the gap of the heartbeat (${String(CASE_12_GAP)} ms).`);
  const longest = Math.max(settings.lockMs, settings.longLockMs);
  const need = longest + retryCap + 2 * pollEvery + HEARTBEAT_EVERY;
  if (settings.armMs < need) problems.push(`The arm (${String(settings.armMs)} ms) is shorter than the longest lock, one wait, two polls and one heartbeat interval (${String(need)} ms).`);
  const live = longest + retryCap + pollEvery;
  if (!(live < EXHAUSTED_AFTER)) problems.push(`The longest lock, one wait and one poll (${String(live)} ms) are not shorter than the escalation (${String(EXHAUSTED_AFTER)} ms).`);
  if (!(settings.tickMs >= 1 && 4 * settings.tickMs <= retryBase)) problems.push(`The tick (${String(settings.tickMs)} ms) is not from 1 ms to a quarter of the first wait (${String(retryBase)} ms).`);
  if (!(Number.isInteger(settings.busyTimeoutMs) && settings.busyTimeoutMs >= 1 && settings.busyTimeoutMs <= 1000)) problems.push(`The busy timeout (${String(settings.busyTimeoutMs)} ms) is not a whole number from 1 ms to 1000 ms.`);
  const boot = 2 * pollEvery + retryCap;
  if (settings.bootLifeMs < boot) problems.push(`A life of broken-at-boot (${String(settings.bootLifeMs)} ms) is shorter than two polls and one wait (${String(boot)} ms).`);
  return problems;
}

/** This function gives the problems of one record with a lock that stop the read of the case. */
export function lockProblemsOf(record: LockRecord, settings: LogFaultSettings = CASE_12_SETTINGS): string[] {
  const problems: string[] = [];
  const { arm } = record;
  if (record.error !== undefined) problems.push(`${arm}: the arm threw: ${record.error}`);
  if (record.ledger.counts.sends >= settings.receipts) problems.push(`${arm}: ${String(record.ledger.counts.sends)} sends used each receipt of the scripted API.`);
  const { times } = record;
  if (times.passLimit !== CASE_12_LOOP.passLimit || times.retryBase !== CASE_12_LOOP.retryBase || times.retryCap !== CASE_12_LOOP.retryCap) {
    problems.push(`${arm}: the loop times of the arm (${JSON.stringify(times)}) are not the times of the case (${JSON.stringify(CASE_12_LOOP)}).`);
  }
  if (record.pings.length === 0) problems.push(`${arm}: the heartbeat gave no ping.`);
  for (const message of record.pingErrors) problems.push(`${arm}: the heartbeat gave an error: ${message}`);
  const plan = lockOf(arm, settings);
  const { lock } = record;
  if (plan === undefined) {
    if (lock !== undefined) problems.push(`${arm}: the arm has a lock, and it has none in the plan.`);
    return problems;
  }
  if (lock === undefined || lock.type !== plan.type) {
    problems.push(`${arm}: the lock of the plan (at the first ${plan.type} row) did not fall.`);
    return problems;
  }
  const to = lock.to;
  if (to === undefined) {
    problems.push(`${arm}: the lock from ${String(lock.from)} ms did not end in the arm.`);
    return problems;
  }
  const locked = record.loopErrors.filter((thrown) => thrown.at >= lock.from && thrown.at <= to);
  const firstError = locked[0];
  if (firstError === undefined) problems.push(`${arm}: no pass threw in the lock from ${String(lock.from)} ms to ${String(to)} ms.`);
  else if (!BUSY.test(firstError.message)) problems.push(`${arm}: the first error in the lock does not name a lock or a busy file: ${firstError.message}`);
  return problems;
}

/** This function gives the problems of `broken-at-boot` that stop the read of the case. */
export function bootProblemsOf(record: BootRecord): string[] {
  const problems: string[] = [];
  if (record.error !== undefined) problems.push(`broken-at-boot: the arm threw: ${record.error}`);
  const { first, broken, second } = record;
  if (first.error !== undefined) problems.push(`broken-at-boot: the first life threw: ${first.error}`);
  for (const thrown of first.loopErrors) problems.push(`broken-at-boot: a pass of the first life threw at ${String(thrown.at)} ms: ${thrown.message}`);
  const end = second?.fromRequest ?? Number.POSITIVE_INFINITY;
  const sends = record.ledger.messages.filter((message) => message.position < end).length;
  if (sends !== 1) problems.push(`broken-at-boot: the first life sent ${String(sends)} copies, not 1.`);
  if (record.log.acknowledgments === 0) problems.push("broken-at-boot: the log of the first life has no acknowledgment.");
  if (broken === undefined) {
    problems.push("broken-at-boot: the break of the file did not fall.");
    return problems;
  }
  if (broken.ok) problems.push(`broken-at-boot: the integrity check found no problem after the break of page ${String(broken.page)}.`);
  const table = new Set(broken.ids);
  if (broken.ids.length !== first.ids.length || first.ids.some((id) => !table.has(id))) {
    problems.push(`broken-at-boot: the table of the broken file has ${String(broken.ids.length)} events, and the log of the first life has ${String(first.ids.length)}. The break changed the table.`);
  }
  return problems;
}

/** This function gives the verdict of the records of a start of the case. */
export function logFaultVerdictOf(records: readonly LockRecord[], boot: BootRecord, settings: LogFaultSettings = CASE_12_SETTINGS): LogFaultVerdict {
  const problems: string[] = logFaultSettingsProblems(settings);
  const failed: string[] = [];
  const results = {} as Record<LockArm, LockResult>;
  for (const arm of LOCK_ARMS) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (of.length !== 1 || record === undefined) {
      problems.push(`${arm}: ${String(of.length)} records, not 1.`);
      const gates: Partial<Record<LockGate, boolean>> = {};
      for (const gate of ARM_LOCK_GATES[arm]) gates[gate] = false;
      results[arm] = { gates, problems: [] };
      continue;
    }
    problems.push(...lockProblemsOf(record, settings));
    const result = lockGatesOf(record, settings);
    results[arm] = result;
    // The control arm passes each gate, or the case cannot read.
    if (arm === "control") problems.push(...result.problems.map((problem) => `${problem} The control arm fails, thus the case cannot read.`));
    else failed.push(...result.problems);
  }
  problems.push(...bootProblemsOf(boot));
  const bootResult = bootGatesOf(boot);
  failed.push(...bootResult.problems);
  const read = problems.length === 0;
  const pass =
    read && LOCK_ARMS.every((arm) => ARM_LOCK_GATES[arm].every((gate) => results[arm].gates[gate] === true)) && BOOT_GATES.every((gate) => bootResult.gates[gate]);
  return { read, results, boot: bootResult, pass, problems: [...problems, ...failed] };
}
