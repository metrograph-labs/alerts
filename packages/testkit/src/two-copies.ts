/**
 * AL-13, case 13: two copies of the system and one phone (AL-15). Each copy sends a `life-safety` alert as a push and as
 * a phone call. A phone takes one call at a time. Thus the copy with rank 1 waits the rank floor before its call. It
 * does not call when its ledger has the call of rank 0 at the due time.
 *
 * Each arm has two runtimes on one case clock: `home` with rank 0 and `cloud` with rank 1. Each runtime has the delivery
 * times of an instance, a rank delay of 0 at `life-safety`, and the rank floor of an instance (`RANK_FLOOR`). Each copy
 * serves its log on a procedures host (`exchangeHost`). The other copy reads it with `exchangeCall` through a fault proxy
 * of `@mark1russell7/rigor-proxy`. The worker and the loop of the exchange are the parts of an instance. The case clock
 * moves `speed` times faster than real time, and the clock of each proxy has its speed and its start.
 *
 * The arms:
 *
 * - `control`: the two copies see the warning at the start. The exchange has no fault.
 * - `cloud-first`: `cloud` sees the warning first. `home` sees it one exchange later, as in the worst case of the floor.
 * - `home-late`: `home` sees the warning after the call of `cloud` came into its ledger.
 * - `slow`: the order of `cloud-first`, and each answer of the exchange comes `slowMs` late.
 * - `reset`: the proxies reset each connection of the exchange. The copies see the warning at the start.
 * - `stall`: the proxies hold each answer of the exchange past the time limit of a read.
 *
 * The gates of each arm:
 *
 * - `pushed`: one push or more comes, and no copy sends two pushes.
 * - `calls`: the count of the calls is the count of the arm: one call, or two calls when the exchange is down.
 * - `caller`: the first call comes from the copy of the arm.
 * - `apart`: a second call comes one rank floor or more after the first call, less one time limit of a read.
 * - `noThrow`: no pass throws, and no loop of the exchange gives an error.
 * - `faulted`, in the arms with a fault: the proxies record faults. In `reset` and `stall`, the reads of each copy fail.
 * - `clean`, in `control`: no read fails.
 */
import { platformClock } from "@mark1russell7/algebra/clock";
import type { ChannelId, EscalationPolicy, Recipient } from "@mark1russell7/alerts";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { CHANNEL_ID as TWILIO, createTwilioCallChannel, type TwilioFetch } from "@mark1russell7/alerts-channel-twilio";
import {
  DELIVERY_TIMES,
  EXCHANGE_BASE_PATH,
  EXCHANGE_EVERY,
  EXCHANGE_LIMIT,
  exchangeCall,
  exchangeHost,
  exchangeLoop,
  exchangeWorker,
  openRuntime,
  openRuntimeLog,
  RANK_DELAY,
  RANK_FLOOR,
  type EntriesSource,
  type Runtime,
} from "@mark1russell7/alerts-runtime";
import { type FaultPlan, faultPlanOf, type WindowFault } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { embeddedProcess, service, type ServiceBuilder } from "@mark1russell7/service";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import { pushoverApi, pushoverFetchTo } from "@procedures/notify/testing";
import { deliveryFixture, FIXTURE_PLACE, PUSHOVER } from "./delivery-fixture.ts";
import { caseClock, caseDeliveryTimes } from "./source-down.ts";

const MINUTE = 60_000;

/** The id of the case. */
export const CASE_13_ID = "al-13-case-13";

/** The arms of the case. */
export const COPIES_ARMS = ["control", "cloud-first", "home-late", "slow", "reset", "stall"] as const;
/** One arm of the case. */
export type CopiesArm = (typeof COPIES_ARMS)[number];

/** The gates of the case. */
export const COPIES_GATES = ["pushed", "calls", "caller", "apart", "noThrow", "faulted", "clean"] as const;
/** One gate of the case. */
export type CopiesGate = (typeof COPIES_GATES)[number];

/** The two copies of the case. */
export const COPIES = ["home", "cloud"] as const;
/** One copy of the case. */
export type CopyName = (typeof COPIES)[number];

/** The settings of the case. */
export interface CopiesSettings {
  /** The case clock moves this number of times faster than real time. */
  readonly speed: number;
  /** The time of one arm on the case clock. */
  readonly armMs: number;
  /** The longest sleep of the passes of a copy. */
  readonly tickMs: number;
  /** In `cloud-first` and `slow`, `home` sees the warning this time after `cloud`: one interval and one time limit of the exchange. */
  readonly lateMs: number;
  /** In `home-late`, `home` sees the warning this time after `cloud`. */
  readonly awayMs: number;
  /** In `slow`, each answer of the exchange comes this time late. */
  readonly slowMs: number;
  /** A call of the scripted Twilio API is in progress for this time. Then it is complete. */
  readonly callMs: number;
}

/** The settings of the case in CI. At the speed 10, the delivery times of the case are the delivery times of production. */
export const CASE_13_SETTINGS: CopiesSettings = {
  speed: 10,
  armMs: 100_000,
  tickMs: 5_000,
  lateMs: EXCHANGE_EVERY + EXCHANGE_LIMIT,
  awayMs: 60_000,
  slowMs: 1_000,
  callMs: 20_000,
};

/** The arms with a fault of the exchange. */
const FAULT_ARMS: readonly CopiesArm[] = ["slow", "reset", "stall"];

/** The arms where the exchange is down: each copy calls one time. */
const DOWN_ARMS: readonly CopiesArm[] = ["reset", "stall"];

/** The count of the calls of an arm, and the copy of the first call. */
export function expectedCallsOf(arm: CopiesArm): { readonly count: number; readonly first: CopyName } {
  return { count: DOWN_ARMS.includes(arm) ? 2 : 1, first: arm === "home-late" ? "cloud" : "home" };
}

/** The time of the first sight of the warning of each copy, after the start of the arm. */
export function seenOf(arm: CopiesArm, settings: CopiesSettings = CASE_13_SETTINGS): Readonly<Record<CopyName, number>> {
  if (arm === "cloud-first" || arm === "slow") return { home: settings.lateMs, cloud: 0 };
  if (arm === "home-late") return { home: settings.awayMs, cloud: 0 };
  return { home: 0, cloud: 0 };
}

/** The least time between two calls of the gate `apart`: one rank floor, less one time limit of a read. */
export const APART_LIMIT: number = RANK_FLOOR - EXCHANGE_LIMIT;

/** This function gives the fault of the window of an arm, or `undefined` for an arm with no fault. */
export function copiesFaultOf(arm: CopiesArm, settings: CopiesSettings = CASE_13_SETTINGS): WindowFault | undefined {
  // The window covers the arm and its end. Thus each connection of the arm gets the fault.
  const window = { from: 0, to: 2 * settings.armMs };
  if (arm === "reset") return { window, direction: "up", at: { byte: 0 }, kind: "reset" };
  if (arm === "stall") return { window, direction: "down", at: { frame: 0 }, kind: "stall", ms: 2 * settings.armMs };
  if (arm === "slow") return { window, direction: "down", at: { frame: 0 }, kind: "delay", ms: settings.slowMs, forMs: 2 * settings.armMs };
  return undefined;
}

/** This function gives the fault plan of the proxies of an arm. */
export function copiesPlanOf(arm: CopiesArm, settings: CopiesSettings = CASE_13_SETTINGS): FaultPlan {
  const fault = copiesFaultOf(arm, settings);
  return faultPlanOf([], fault === undefined ? [] : [fault]);
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function copiesSettingsProblems(settings: CopiesSettings): string[] {
  const problems: string[] = [];
  // The floor of the instance holds only for the call limit of production.
  if (caseDeliveryTimes(settings.speed).callLimit !== DELIVERY_TIMES.callLimit) problems.push(`At the speed ${String(settings.speed)}, the call limit of the case is not the call limit of production. Thus RANK_FLOOR does not hold.`);
  // In `home-late`, the call of `cloud` comes into the ledger of `home` before `home` sees the warning.
  const merged = RANK_FLOOR + DELIVERY_TIMES.callLimit + EXCHANGE_EVERY + EXCHANGE_LIMIT;
  if (settings.awayMs < merged) problems.push(`The time of home-late (${String(settings.awayMs)} ms) is shorter than the time of the merge of the call of cloud (${String(merged)} ms).`);
  if (2 * settings.slowMs > EXCHANGE_LIMIT) problems.push(`The delay of slow (${String(settings.slowMs)} ms) is more than half of the time limit of a read.`);
  // The last due time of a call: the first sight of home, or the first sight of cloud and one floor. Then two passes record the call.
  const last = Math.max(...COPIES_ARMS.map((arm) => {
    const seen = seenOf(arm, settings);
    return Math.max(seen.home, seen.cloud + RANK_FLOOR);
  })) + 2 * settings.tickMs;
  if (settings.armMs < last) problems.push(`The arm (${String(settings.armMs)} ms) ends before the last due time of a call (${String(last)} ms).`);
  return problems;
}

/** One message of a channel, with its copy and its time after the start of the arm. */
export interface SentRecord {
  readonly copy: CopyName;
  readonly at: number;
}

/** What one copy did in an arm. */
export interface CopyRunRecord {
  readonly copy: CopyName;
  /** The time of the first pass, after the start of the arm. */
  readonly seenAt: number;
  readonly passes: number;
  readonly rounds: number;
  /** The rounds with a failed read of the other copy. */
  readonly failedRounds: number;
  /** The rounds with a problem of a page. */
  readonly problemRounds: number;
}

/** The record of one arm. */
export interface CopiesRecord {
  readonly arm: CopiesArm;
  readonly copies: readonly CopyRunRecord[];
  /** Each push, in the order of its time. */
  readonly pushes: readonly SentRecord[];
  /** Each call of the scripted Twilio API, in the order of its time. */
  readonly calls: readonly SentRecord[];
  /** The count of the faults that the proxies recorded. */
  readonly faults: number;
  /** The count of the connections of the proxies. */
  readonly connections: number;
  /** The messages of each throw of a pass and of each error of a loop of the exchange. */
  readonly errors: readonly string[];
}

/** The source, the person and the test values of the case. */
const FIXTURE = deliveryFixture("case-13", "casethirteen");

// Fake keys and fake numbers: the country code +999 has no country.
const CREDENTIALS = { accountSid: `AC${"0".repeat(32)}`, keySid: `SK${"1".repeat(32)}`, secret: "s".repeat(32) };
const FROM = "+99900000001";
const PHONE = "+99900000002";
// The token of the exchange: a test value of 32 characters.
const TOKEN = "casethirteenexchange".padEnd(32, "0");
// The two copies have one configuration, thus one hash.
const CONFIG_HASH = "case-13-config";

/** The policy of the case: a push and a call at once. */
const POLICY: EscalationPolicy = { level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }, { channel: TWILIO as ChannelId, at: 0 }], exhaustedAfter: 20 * MINUTE };

/** The person of the case, with an address on each channel. */
const RECIPIENT: Recipient = { ...FIXTURE.recipient, policies: [POLICY], addresses: { ...FIXTURE.recipient.addresses, [TWILIO]: { to: PHONE } } };

/** A service with short stages for the procedures host of a copy, as in the tests of the HTTP transport of the exchange. */
function hostService(name: string): ServiceBuilder {
  const ms = (value: number) => ({ value, unit: "ms" });
  return service(name)
    .readiness({ type: "debounce", interval: ms(5_000), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: ms(45_000) })
    .startup(ms(10_000))
    .phase("fail readiness", ms(10))
    .phase("stop intake", ms(500))
    .phase("drain", ms(1000))
    .phase("close transports", ms(500))
    .phase("stop the poller", ms(100))
    .phase("tear down dependencies", ms(500))
    .phase("close the health server", ms(100))
    .cooperativeWindow(ms(500))
    .onRepeatSignal("ignore");
}

/** This function starts the procedures host of a copy on the loopback, and it gives its port. */
async function serveCopy(source: EntriesSource, name: string): Promise<{ readonly port: number; stop(): Promise<void> }> {
  const host = exchangeHost({ source, token: TOKEN, listen: { host: "127.0.0.1", port: 0 } });
  const life = await host.declare(hostService(name)).run({ process: embeddedProcess() });
  const address = host.info.endpoints().find((endpoint) => endpoint.type === "http")?.address;
  if (address === undefined) {
    await life.shutdown("the case has no address");
    throw new Error("The host of the exchange has no HTTP endpoint.");
  }
  const base = new URL(address.slice(0, address.length - EXCHANGE_BASE_PATH.length));
  return {
    port: Number(base.port),
    stop: async () => {
      await life.shutdown("the arm ended");
      await life.done;
    },
  };
}

/** The scripted Twilio API of an arm. Each copy has its own fetch, and the API records the copy of each call. */
function twilioApi(now: () => number, start: number, callMs: number) {
  const calls: (SentRecord & { readonly sid: string })[] = [];
  const reply = (status: number, body: object) => ({ status, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const fetchOf =
    (copy: CopyName): TwilioFetch =>
    async (url, init) => {
      const at = now() - start;
      if (init.method === "POST" && url.endsWith("/Calls.json")) {
        const sid = `CA${String(calls.length + 1).padStart(32, "0")}`;
        calls.push({ copy, at, sid });
        return reply(201, { sid, status: "queued" });
      }
      const sid = /\/Calls\/(CA[0-9a-f]{32})\.json$/.exec(url)?.[1];
      const made = calls.find((one) => one.sid === sid);
      if (made === undefined) return reply(404, { code: 20404, message: "The call is not known.", status: 404 });
      return reply(200, { sid, status: at - made.at < callMs ? "in-progress" : "completed", answered_by: "human" });
    };
  return { calls, fetchOf };
}

/** The parts of one copy in an arm. */
interface CopyParts {
  readonly copy: CopyName;
  readonly peer: CopyName;
  readonly counts: { passes: number; rounds: number; failedRounds: number; problemRounds: number };
  readonly runtime: Runtime;
  readonly loop: ReturnType<typeof exchangeLoop>;
}

/**
 * This function starts one arm: a scripted Pushover API, a scripted Twilio API, and two copies with their hosts, their
 * proxies and their loops. The arm starts after the setup. Each time of the record is a time after this start.
 */
export async function runCopiesArm(arm: CopiesArm, settings: CopiesSettings = CASE_13_SETTINGS): Promise<CopiesRecord> {
  const origin = Date.now();
  const clock = caseClock(origin, settings.speed);
  const monotonic = platformClock({ speed: settings.speed, start: origin });
  const plan = copiesPlanOf(arm, settings);
  const seen = seenOf(arm, settings);
  const errors: string[] = [];
  const pushes: SentRecord[] = [];
  const proxies: Awaited<ReturnType<typeof startFaultProxy>>[] = [];
  const parts: CopyParts[] = [];
  // The service closes the parts in the reverse order of their start: the loops, the proxies and the hosts, the Pushover API, the logs.
  const closers: (() => unknown)[] = [];
  const logs = new Map(COPIES.map((copy) => [copy, openRuntimeLog(":memory:")] as const));
  for (const log of logs.values()) closers.push(() => log.close());
  // The runtime of a copy opens after its host, thus the host reads it through a function.
  const runtimes = new Map<CopyName, Runtime>();
  const runtimeOf = (copy: CopyName): Runtime => {
    const runtime = runtimes.get(copy);
    if (runtime === undefined) throw new Error(`The runtime of ${copy} is not open.`);
    return runtime;
  };
  let start = clock.now();
  let calls: readonly SentRecord[] = [];
  try {
    // The person does not acknowledge a push. Thus an acknowledgment does not stop a call, and only the floor and the ledger decide.
    const pushover = await startScriptedServer(pushoverApi({ receipts: 4, tags: "any", state: "pending" }));
    closers.push(() => pushover.close());
    const toPushover = pushoverFetchTo(`http://${pushover.host}:${String(pushover.port)}`);
    // Each copy serves its log behind its own proxy. The other copy reads it through that proxy.
    const fronts = new Map<CopyName, string>();
    for (const copy of COPIES) {
      const source: EntriesSource = { runtime: { share: (after, limit) => runtimeOf(copy).share(after, limit) }, clock, configHash: CONFIG_HASH };
      const host = await serveCopy(source, `${CASE_13_ID}-${copy}`);
      closers.push(() => host.stop());
      const proxy = await startFaultProxy({ target: { host: "127.0.0.1", port: host.port }, plan, protocol: "http", clock: monotonic, origin: monotonic.now() });
      closers.push(() => proxy.close());
      proxies.push(proxy);
      fronts.set(copy, `http://${proxy.host}:${String(proxy.port)}`);
    }
    start = clock.now();
    const end = start + settings.armMs;
    const twilio = twilioApi(clock.now, start, settings.callMs);
    COPIES.forEach((copy, rank) => {
      const peer: CopyName = copy === "home" ? "cloud" : "home";
      const counts = { passes: 0, rounds: 0, failedRounds: 0, problemRounds: 0 };
      const fetch: typeof toPushover = async (url, init) => {
        if (new URL(url).pathname === "/1/messages.json") pushes.push({ copy, at: clock.now() - start });
        return toPushover(url, init);
      };
      const channels = [createPushoverChannel({ token: FIXTURE.token, fetch, now: clock.now }), createTwilioCallChannel({ credentials: CREDENTIALS, from: FROM, fetch: twilio.fetchOf(copy), now: clock.now })];
      const worker = exchangeWorker({
        runtime: { position: (id) => runtimeOf(copy).position(id), take: (page) => runtimeOf(copy).take(page) },
        peers: [{ id: peer, url: fronts.get(peer) ?? "" }],
        call: exchangeCall({ token: TOKEN }),
        clock,
        configHash: CONFIG_HASH,
      });
      const runtime = openRuntime({
        log: logs.get(copy) ?? openRuntimeLog(":memory:"),
        clock,
        sources: [FIXTURE.sourceOf(start)],
        watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
        view: FIXTURE.view,
        run: `${CASE_13_ID}-${arm}-${copy}`,
        copy,
        delivery: { recipients: [RECIPIENT], channels, ...caseDeliveryTimes(settings.speed), rank, rankDelay: RANK_DELAY, rankDelays: { "life-safety": 0 }, rankFloor: RANK_FLOOR },
        copies: worker,
      });
      runtimes.set(copy, runtime);
      const loop = exchangeLoop({
        worker,
        clock: monotonic,
        random: () => 0.5,
        onRound: (round) => {
          counts.rounds += 1;
          if (worker.failure(peer) !== undefined) counts.failedRounds += 1;
          if (round.problems.length > 0) counts.problemRounds += 1;
        },
        onError: (error) => errors.push(`${copy}: the loop of the exchange: ${error instanceof Error ? error.message : String(error)}`),
      });
      parts.push({ copy, peer, counts, runtime, loop });
    });

    const signal = new AbortController().signal;
    for (const part of parts) {
      await part.loop.start(signal, detachedLifecycle(monotonic));
      closers.push(async () => {
        await part.loop.stopIntake();
        await part.loop.drain(monotonic.now() + EXCHANGE_LIMIT, signal);
        await part.loop.close();
      });
    }
    // The passes of each copy start at its first sight of the warning, and they go on to the end of the arm, as in case 7.
    const drive = async (part: CopyParts): Promise<void> => {
      await clock.sleep(Math.max(0, start + seen[part.copy] - clock.now()));
      try {
        while (clock.now() < end) {
          const pass = await part.runtime.pass();
          part.counts.passes += 1;
          const next = Math.min(pass.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + settings.tickMs, end);
          await clock.sleep(Math.max(0, next - clock.now()));
        }
      } catch (thrown) {
        errors.push(`${part.copy}: a pass threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      }
    };
    await Promise.all(parts.map((part) => drive(part)));
    calls = twilio.calls.map(({ copy, at }) => ({ copy, at }));
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch (thrown) {
        errors.push(`the end of the arm: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      }
    }
  }
  // The proxies give the summary of a connection when it closes. Thus the record reads them after the close.
  return {
    arm,
    copies: parts.map((part) => ({ copy: part.copy, seenAt: seen[part.copy], ...part.counts })),
    pushes: [...pushes].sort((a, b) => a.at - b.at),
    calls: [...calls].sort((a, b) => a.at - b.at),
    faults: proxies.reduce((sum, proxy) => sum + proxy.records.length, 0),
    connections: proxies.reduce((sum, proxy) => sum + proxy.connections.length, 0),
    errors,
  };
}

/** The gates of one arm. A gate that does not apply to the arm passes. */
export function copiesGatesOf(record: CopiesRecord): { readonly gates: Readonly<Record<CopiesGate, boolean>>; readonly problems: readonly string[] } {
  const { arm } = record;
  const problems: string[] = [];
  const pushesOf = (copy: CopyName) => record.pushes.filter((push) => push.copy === copy).length;
  const pushed = record.pushes.length > 0 && COPIES.every((copy) => pushesOf(copy) <= 1);
  if (!pushed) problems.push(`${arm}: the pushes are ${COPIES.map((copy) => `${String(pushesOf(copy))} from ${copy}`).join(" and ")}. One or more push must come, and one push from each copy or fewer.`);
  const expected = expectedCallsOf(arm);
  const calls = record.calls.length === expected.count;
  if (!calls) problems.push(`${arm}: ${String(record.calls.length)} calls came, not ${String(expected.count)}.`);
  const caller = record.calls[0]?.copy === expected.first;
  if (!caller) problems.push(`${arm}: the first call came from ${record.calls[0]?.copy ?? "no copy"}, not from ${expected.first}.`);
  const gaps = record.calls.slice(1).map((call, index) => call.at - (record.calls[index]?.at ?? 0));
  const apart = gaps.every((gap) => gap >= APART_LIMIT);
  if (!apart) problems.push(`${arm}: two calls came ${gaps.map(String).join(", ")} ms apart, less than ${String(APART_LIMIT)} ms.`);
  const noThrow = record.errors.length === 0;
  if (!noThrow) problems.push(...record.errors.map((error) => `${arm}: ${error}`));
  const failing = record.copies.every((copy) => copy.failedRounds > 0);
  const faulted = !FAULT_ARMS.includes(arm) || (record.faults > 0 && (!DOWN_ARMS.includes(arm) || failing));
  if (!faulted) problems.push(`${arm}: the proxies recorded ${String(record.faults)} faults, and the failed rounds are ${record.copies.map((copy) => `${String(copy.failedRounds)} of ${copy.copy}`).join(" and ")}.`);
  const clean = arm !== "control" || record.copies.every((copy) => copy.failedRounds === 0 && copy.problemRounds === 0);
  if (!clean) problems.push(`${arm}: a read failed with no fault: ${record.copies.map((copy) => `${String(copy.failedRounds)} failed rounds of ${copy.copy}`).join(" and ")}.`);
  return { gates: { pushed, calls, caller, apart, noThrow, faulted, clean }, problems };
}

/** The verdict of the case. */
export interface CopiesVerdict {
  /** The case reads when the settings have no problem, and each copy of each arm passed and read the other copy. */
  readonly read: boolean;
  readonly pass: boolean;
  readonly results: Readonly<Partial<Record<CopiesArm, Readonly<Record<CopiesGate, boolean>>>>>;
  readonly problems: readonly string[];
}

/** This function gives the verdict of the records. */
export function copiesVerdictOf(records: readonly CopiesRecord[], settings: CopiesSettings = CASE_13_SETTINGS): CopiesVerdict {
  const problems = copiesSettingsProblems(settings);
  let read = problems.length === 0;
  const results: Partial<Record<CopiesArm, Readonly<Record<CopiesGate, boolean>>>> = {};
  for (const arm of COPIES_ARMS) {
    const record = records.find((one) => one.arm === arm);
    const ran = record !== undefined && record.copies.every((copy) => copy.passes > 0 && copy.rounds > 0) && record.connections > 0;
    if (!ran) {
      read = false;
      problems.push(`${arm}: the arm did not run: a copy has no pass or no round, or the proxies have no connection.`);
      continue;
    }
    const { gates, problems: found } = copiesGatesOf(record);
    results[arm] = gates;
    problems.push(...found);
  }
  const pass = read && COPIES_ARMS.every((arm) => COPIES_GATES.every((gate) => results[arm]?.[gate] === true));
  return { read, pass, results, problems };
}

/** The run of the case. */
export interface CopiesRun {
  readonly id: typeof CASE_13_ID;
  readonly settings: CopiesSettings;
  /** The floor and the rank delay of the case. */
  readonly times: { readonly rankFloor: number; readonly rankDelay: number; readonly apartLimit: number };
  readonly records: readonly CopiesRecord[];
  readonly verdict: CopiesVerdict;
}

/** This function starts each arm in its order, and it gives the records and the verdict. */
export async function runTwoCopies(settings: CopiesSettings = CASE_13_SETTINGS): Promise<CopiesRun> {
  const records: CopiesRecord[] = [];
  if (copiesSettingsProblems(settings).length === 0) for (const arm of COPIES_ARMS) records.push(await runCopiesArm(arm, settings));
  return { id: CASE_13_ID, settings, times: { rankFloor: RANK_FLOOR, rankDelay: RANK_DELAY, apartLimit: APART_LIMIT }, records, verdict: copiesVerdictOf(records, settings) };
}
