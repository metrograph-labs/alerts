/**
 * The watch of the joint down time of the copies (AL-148).
 *
 * The copies share one loud check of Healthchecks.io. The check gets only the success pings of each copy, thus it goes
 * down only when no copy can tell the person. The flips of the check are thus the joint down time of the copies.
 *
 * - The target: some copy can send in 0.999 of each 7 days. Thus the joint down time of the last 7 days is 10 minutes or less.
 * - The runtime starts `check` of the watch in each pass. The watch reads at its first check, then once in each hour.
 * - A read lists the checks of the project, finds the loud check by its ping URL, and reads its flips of the window.
 * - A failed read keeps the last read that passed. The core gives the line `unread` when the last read is too old.
 * - The watch keeps no record. After a restart, the first check reads again.
 * - The key of the management API and the ping URL are secrets. No message holds them or the id of the check.
 */
import type { Duration, Instant, JointDown, JointDownRead, ReadHealth } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { send, statusLine, type Exchange, type Pace, type Transport } from "polite-crawler/api";
import { checkOfPingUrl, checksRequest, HEALTHCHECKS_API } from "./heartbeat.ts";
import { readHealth, readSchedule, type ReadFailure, type ReadWatch } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The window of the sum of the joint down time: 7 days before each read. */
export const JOINT_WINDOW: Duration = 7 * DAY;

/** The longest joint down time in the window: 0.001 of 7 days is 10.08 minutes, and the limit is 10 minutes. */
export const JOINT_LIMIT: Duration = 10 * MINUTE;

/** The time between two reads that pass. The management API is generous, and one read in each hour is polite. */
export const JOINT_EVERY: Duration = HOUR;

/** The time after a failed read before the next read. */
export const JOINT_RETRY: Duration = 15 * MINUTE;

/** The longest time with no read that passed. After it, the core gives the line `unread`. */
export const JOINT_MAX_AGE: Duration = 6 * HOUR;

/** The longest time of one read: two requests. */
export const JOINT_READ_LIMIT: Duration = MINUTE;

/** One flip of a check: the time when the check went up or down. */
export interface Flip {
  readonly at: Instant;
  /** The value `true` tells that the check went up, and `false` tells that it went down. */
  readonly up: boolean;
}

/**
 * This function gives the request of all the flips of one check (API v3). The key and the id of the check are secrets.
 * The request has no window: the flips before the window tell the state at its start, and the first flip tells a new check.
 */
export function flipsRequest(apiKey: string, checkId: string, userAgent: string, base: string = HEALTHCHECKS_API): Exchange {
  const url = new URL(`checks/${encodeURIComponent(checkId)}/flips/`, base);
  return { method: "GET", url: url.toString(), headers: { accept: "application/json", "user-agent": userAgent, "x-api-key": apiKey }, body: null };
}

/**
 * This function gives the flips in the answer of `flipsRequest`, from the earliest. The answer is a list of flips, or an
 * object with the list `flips`. Each flip has `timestamp` and `up`: 1 or 0, or `true` or `false`. A flip that the function
 * cannot read gives a problem, because a missed flip changes the sum. A problem holds no value of the answer.
 */
export function flipsOf(body: string): { readonly ok: true; readonly flips: readonly Flip[] } | { readonly ok: false; readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, problem: "The answer of the flips is not valid JSON." };
  }
  const list = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? (parsed as { readonly flips?: unknown }).flips : undefined;
  if (!Array.isArray(list)) return { ok: false, problem: "The answer of the flips has no list of flips." };
  const flips: Flip[] = [];
  for (const entry of list as unknown[]) {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const at = typeof record["timestamp"] === "string" ? Date.parse(record["timestamp"]) : Number.NaN;
    const up = record["up"] === 1 || record["up"] === true ? true : record["up"] === 0 || record["up"] === false ? false : undefined;
    if (!Number.isFinite(at) || up === undefined) return { ok: false, problem: "A flip of the answer has no valid time or no valid state." };
    flips.push({ at, up });
  }
  return { ok: true, flips: flips.sort((a, b) => a.at - b.at) };
}

/** The input of `jointDownTime`. */
export interface DownInput {
  /** The flips of the check. Their order does not matter. */
  readonly flips: readonly Flip[];
  /** The state of the check at the read, for example `up` or `down`. With no flip in the window, only `down` counts as down. */
  readonly status: string;
  /** The time from the last ping to the down flip: the period plus the grace of the check. */
  readonly lag: Duration;
  /** The end of the window: the time of the read. */
  readonly at: Instant;
  /** The size of the window. */
  readonly window: Duration;
}

/** The sum of the down spans of a check in a window. */
export interface DownSum {
  /** The sum of the down spans in the window. */
  readonly down: Duration;
  /** The count of the down spans in the window. */
  readonly spans: number;
}

/**
 * This function gives the down time of a check in the window [`at` − `window`, `at`].
 *
 * - A down span starts at its down flip less the lag: the check goes down only after the period plus the grace with no ping.
 * - A down span ends at the next up flip. An open span ends at `at`.
 * - Each span is clipped to the window. A span does not start before the flip before it.
 * - The state at the start of the window is the state after the last flip before it. With no such flip, the check is
 *   newer than the window. Its first flip is the first up of a new check, thus it was not down. With no flip, it is the
 *   state of the check: only `down` is down for the whole window.
 * - A flip after `at` does not count. A second flip with the same state changes nothing.
 */
export function jointDownTime(input: DownInput): DownSum {
  const from = input.at - input.window;
  const flips = [...input.flips].filter((flip) => flip.at <= input.at).sort((a, b) => a.at - b.at);
  const before = flips.filter((flip) => flip.at <= from);
  const inside = flips.filter((flip) => flip.at > from);
  const last = before[before.length - 1];
  const downAtStart = last !== undefined ? !last.up : inside.length === 0 && input.status === "down";
  let start: Instant | undefined = downAtStart ? from : undefined;
  let previous = from;
  let down = 0;
  let spans = 0;
  for (const flip of inside) {
    if (!flip.up && start === undefined) start = Math.max(flip.at - input.lag, previous);
    else if (flip.up && start !== undefined) {
      down += flip.at - start;
      spans += 1;
      start = undefined;
    }
    previous = flip.at;
  }
  if (start !== undefined) {
    down += input.at - start;
    spans += 1;
  }
  return { down, spans };
}

/** The answer of a reader of the joint down time. A reader does not throw. A throw is a failure too. */
export type JointReading = ({ readonly ok: true } & DownSum) | ReadFailure;

/** The options of the reader of the joint down time. */
export interface JointReaderOptions {
  /** The key of the management API of Healthchecks.io. It must be a key that can write, because only such a key lists the ping URLs. */
  readonly key: string;
  /** The ping URL of the loud check that the copies share. */
  readonly url: string;
  /** The pace of the requests: a scheduler of polite-crawler for the host of the API. */
  readonly pace: Pace;
  /** The transport of the requests, for example `fetchTransport` of polite-crawler. A test gives a fake. */
  readonly transport: Transport;
  /** The User-Agent of the requests. */
  readonly userAgent: string;
  /** The base URL of the management API. The default is `HEALTHCHECKS_API`. */
  readonly base?: string;
  /** The window of the sum. The default is `JOINT_WINDOW`. */
  readonly window?: Duration;
}

/**
 * This function makes the reader of the joint down time. Each read sends two requests through `send` of polite-crawler:
 * the list of the checks, then the flips of the loud check. A message of a failure holds no key, no URL and no id.
 */
export function jointReader(options: JointReaderOptions): (signal: AbortSignal, at: Instant) => Promise<JointReading> {
  const base = options.base ?? HEALTHCHECKS_API;
  const window = options.window ?? JOINT_WINDOW;
  const secrets = [options.key, options.url];
  const host = new URL(base).host;
  const get = async (exchange: Exchange, what: string, signal: AbortSignal): Promise<{ readonly body: string } | ReadFailure> => {
    const answer = await send(options.pace, options.transport, { source: "Healthchecks.io", host, what, exchange, secrets, redact: redactSecrets }, signal);
    return answer.reply.status === 200 ? { body: answer.reply.body } : { ok: false, message: `The management API gave ${statusLine(answer.reply)} for ${what}.` };
  };
  return async (signal, at) => {
    try {
      const listed = await get(checksRequest(options.key, options.userAgent, base), "the checks of the project", signal);
      if ("ok" in listed) return listed;
      const found = checkOfPingUrl(listed.body, options.url);
      if (!found.ok) return { ok: false, message: found.problem };
      if (found.check.id === "") return { ok: false, message: "The loud check in the answer has no id." };
      const flipped = await get(flipsRequest(options.key, found.check.id, options.userAgent, base), "the flips of the loud check", signal);
      if ("ok" in flipped) return flipped;
      const flips = flipsOf(flipped.body);
      if (!flips.ok) return { ok: false, message: flips.problem };
      const sum = jointDownTime({ flips: flips.flips, status: found.check.status, lag: found.check.timeout + found.check.grace, at, window });
      return { ok: true, ...sum };
    } catch (error) {
      // The schedule ignores a read that the stop ended.
      if (signal.aborted) throw error;
      return { ok: false, message: redactSecrets(errorMessage(error), [...secrets]) };
    }
  };
}

/** The options of the watch of the joint down time. */
export interface JointWatchOptions {
  /** This function reads the joint down time in the window before the time `at`. It stops at the abort of the signal. */
  readonly read: (signal: AbortSignal, at: Instant) => Promise<JointReading>;
  /** The window of the sum. The default is `JOINT_WINDOW`. Give the same window to the reader. */
  readonly window?: Duration;
  /** The longest joint down time in the window. The default is `JOINT_LIMIT`. */
  readonly downLimit?: Duration;
  /** The time between two reads that pass. The default is `JOINT_EVERY`. */
  readonly every?: Duration;
  /** The time after a failed read before the next read. The default is `JOINT_RETRY`. */
  readonly retry?: Duration;
  /** The longest time with no read that passed. The default is `JOINT_MAX_AGE`. */
  readonly maxAge?: Duration;
  /** The longest time of one read. The default is `JOINT_READ_LIMIT`. */
  readonly limit?: Duration;
}

/** The watch of the joint down time of the copies. */
export interface JointWatch extends ReadWatch {
  /** This method gives the watch as data of the core. Before the first check, it gives `undefined`. */
  joint(): JointDown | undefined;
  /** This method gives the message of the last read when it failed. */
  failure(): string | undefined;
  /** This method gives the health of the reads. It holds no down time and no message. */
  health(): ReadHealth;
}

/**
 * This function makes the watch of the joint down time of the copies.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0.
 */
export function jointWatch(options: JointWatchOptions): JointWatch {
  const window = options.window ?? JOINT_WINDOW;
  const downLimit = options.downLimit ?? JOINT_LIMIT;
  const every = options.every ?? JOINT_EVERY;
  const retry = options.retry ?? JOINT_RETRY;
  const maxAge = options.maxAge ?? JOINT_MAX_AGE;
  const limit = options.limit ?? JOINT_READ_LIMIT;
  for (const [name, value] of Object.entries({ window, downLimit, every, retry, maxAge, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the watch of the joint down time is not a whole count of milliseconds above 0.`);
  }
  let since: Instant | undefined;
  let read: JointDownRead | undefined;
  const reads = readSchedule<{ readonly ok: true } & DownSum>({
    what: "joint down time",
    every,
    retry,
    limit,
    read: (signal, at) => options.read(signal, at),
    use(reading, at) {
      if (!reading.ok) return reading.message;
      if (!(Number.isFinite(reading.down) && reading.down >= 0 && Number.isInteger(reading.spans) && reading.spans >= 0)) return "The read of the joint down time gave no valid sum.";
      read = { down: reading.down, spans: reading.spans, at };
      return undefined;
    },
  });
  return {
    check(clock, stop) {
      since ??= clock.now();
      return reads.check(clock, stop);
    },
    nextReadAt: () => reads.nextReadAt(),
    joint() {
      if (since === undefined) return undefined;
      return { window, limit: downLimit, maxAge, since, ...(read === undefined ? {} : { read }) };
    },
    failure: () => reads.failure(),
    health: () => readHealth("joint down time", reads, read?.at),
    shift(size) {
      if (since !== undefined) since += size;
      reads.shift(size);
      if (read !== undefined) read = { ...read, at: read.at + size };
    },
  };
}
