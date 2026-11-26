/**
 * The watch of the balance of a paid provider account, the watch of its spend, and the quota of the spend of a channel.
 *
 * - The runtime starts `check` of each watch in each pass. A watch reads only when it is due: at its first check, then once in each interval.
 * - A failed read keeps the last read that passed. The core gives the line `unread` when the last balance is too old.
 * - The watch keeps no record. After a restart, the first check reads again. The gates keep the count of the spend.
 * - The start of the month of a cap comes from `monthOf` of `@mark1russell7/algebra/clock`.
 */
import type { BalanceRead, ChannelDescriptor, ChannelId, Duration, Instant, ProviderBalance, ReadHealth, SpendConfig } from "@mark1russell7/alerts";
import { localTime, monthOf, type WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { quotaGate, type Quota, type QuotaGate, type QuotaGateOptions } from "polite-crawler/api";
import { readHealth, readSchedule } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The answer of a reader of a balance. A reader does not throw. A throw is a failure too. */
export type BalanceReading = { readonly ok: true; readonly balance: number; readonly currency: string } | { readonly ok: false; readonly message: string };

/** The options of one watch. */
export interface BalanceWatchOptions {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The name of the provider in a text: for example `Twilio`. */
  readonly title: string;
  /** The channels that the account pays for. The reports have their subjects. */
  readonly channels: readonly ChannelId[];
  /** The floors of the balance, in the currency of the account. Below each floor, the core gives one line `low`. */
  readonly floors: readonly number[];
  /** This function reads the balance. It stops at the abort of the signal. */
  readonly read: (signal: AbortSignal) => Promise<BalanceReading>;
  /** The time between two reads that pass. The default is one day. */
  readonly every?: Duration;
  /** The time after a failed read before the next read. The default is one hour. */
  readonly retry?: Duration;
  /** The longest time with no read that passed. The default is 2 days. Thus one failed day gives no line. */
  readonly maxAge?: Duration;
  /** The longest time of one read. The default is 30 seconds. */
  readonly limit?: Duration;
}

/** The watch of one provider account. */
export interface BalanceWatch {
  readonly provider: string;
  /** This method reads the balance when the read is due, and gives no result. It does not throw. */
  check(clock: WallClock, stop?: AbortSignal): Promise<void>;
  /** This method gives the time of the next read. Before the first check, the read is due at once. */
  nextReadAt(): Instant | undefined;
  /** This method gives the watch as data of the core. Before the first check, it gives `undefined`. */
  balance(): ProviderBalance | undefined;
  /** This method gives the message of the last read when it failed. */
  failure(): string | undefined;
  /**
   * This method moves the own times of the watch by the size of a step of the wall clock. They are the start of the
   * watch, the time of the last read and the time of the next read. Thus the next read keeps its distance on the monotonic clock.
   */
  shift(size: Duration): void;
}

/**
 * This function makes the watch of one provider account.
 *
 * @throws Error when the watch has no channel or no floor, or when a time or a floor is not valid.
 */
export function balanceWatch(options: BalanceWatchOptions): BalanceWatch {
  const every = options.every ?? DAY;
  const retry = options.retry ?? HOUR;
  const maxAge = options.maxAge ?? 2 * DAY;
  const limit = options.limit ?? 30_000;
  if (options.channels.length === 0) throw new Error(`The balance watch of ${options.provider} has no channel. Its reports reach no person.`);
  if (options.floors.length === 0) throw new Error(`The balance watch of ${options.provider} has no floor.`);
  if (!options.floors.every(Number.isFinite)) throw new Error(`A floor of the balance of ${options.provider} is not a number.`);
  for (const [name, value] of Object.entries({ every, retry, maxAge, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the balance watch of ${options.provider} is not a whole count of milliseconds above 0.`);
  }
  let since: Instant | undefined;
  let read: BalanceRead | undefined;
  const reads = readSchedule<BalanceReading>({
    what: "balance",
    every,
    retry,
    limit,
    read: (signal) => options.read(signal),
    use(reading, at) {
      if (!reading.ok) return reading.message;
      if (!(Number.isFinite(reading.balance) && /^[A-Z]{3}$/.test(reading.currency))) return "The read of the balance gave no finite balance or no currency code.";
      read = { balance: reading.balance, currency: reading.currency, at };
      return undefined;
    },
  });

  return {
    provider: options.provider,
    check(clock, stop) {
      since ??= clock.now();
      return reads.check(clock, stop);
    },
    nextReadAt: () => reads.nextReadAt(),
    balance() {
      if (since === undefined) return undefined;
      const { provider, title, channels, floors } = options;
      return { provider, title, channels, floors, maxAge, since, ...(read === undefined ? {} : { read }) };
    },
    failure: () => reads.failure(),
    shift(size) {
      if (since !== undefined) since += size;
      reads.shift(size);
      if (read !== undefined) read = { ...read, at: read.at + size };
    },
  };
}

/** The answer of a reader of the spend. A reader does not throw. A throw is a failure too. */
export type SpendReading = { readonly ok: true; readonly usedUsd: number } | { readonly ok: false; readonly message: string };

/** The options of one watch of the spend. */
export interface SpendWatchOptions {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The gates of the cap of the provider. The watch adds the spend of the provider to their count. */
  readonly gates: SpendGates;
  /** The IANA time zone of the month of the cap: the `timeZone` of the spend entry. */
  readonly timeZone: string;
  /**
   * This function reads the spend of the account from the instant `from` to the time of the read, in US dollars. The
   * spend does not include the fixed monthly costs, for example the rent of a number. The cap holds these costs only
   * when its entry lists them in `fixed`. `from` is the start of the month of the cap. It stops at the abort of the
   * signal.
   */
  readonly read: (from: Instant, signal: AbortSignal) => Promise<SpendReading>;
  /** The time between two reads that pass. The default is one hour. */
  readonly every?: Duration;
  /** The time after a failed read before the next read. The default is 15 minutes. */
  readonly retry?: Duration;
  /** The longest time of one read. The default is 30 seconds. */
  readonly limit?: Duration;
}

/** The last read of the spend that the watch took. */
export interface SpendRead {
  /** The spend of the month that the provider gave, in US dollars. */
  readonly usedUsd: number;
  /** The spend in the units of the quota: whole cents, rounded up. */
  readonly units: number;
  readonly at: Instant;
}

/** The watch of the spend of one provider account. */
export interface SpendWatch {
  readonly provider: string;
  /** This method reads the spend when the read is due, and gives no result. It does not throw. */
  check(clock: WallClock, stop?: AbortSignal): Promise<void>;
  /** This method gives the time of the next read. Before the first check, the read is due at once. */
  nextReadAt(): Instant | undefined;
  /** This method gives the last read that the watch took. */
  spend(): SpendRead | undefined;
  /** This method gives the message of the last read when it failed. */
  failure(): string | undefined;
  /** This method gives the health of the watch for the health route. It holds no amount and no message. */
  health(): ReadHealth;
  /** This method moves the own times of the watch by the size of a step of the wall clock. */
  shift(size: Duration): void;
}

/**
 * This function makes the watch of the spend of one provider account. The gates count only the sends of the channels.
 * The provider also bills other usage: a reply, a call of another tool, a fee that is not in the fixed costs. Each read
 * gives the count of the gates the spend of the provider, when it is larger. The count does not become smaller at any time.
 *
 * - The provider adds its usage after a delay. Thus the count can miss the sends of that delay that the gates did not count.
 * - A read that ends in the next month gives a failure, and no count. The next read reads the new month.
 * - The watch does not block the key at any time. A full month refuses each send, also `life-safety`, as the count of the gates does.
 *
 * @throws Error when a time is not valid, or when the time zone is not an IANA time zone.
 */
export function spendWatch(options: SpendWatchOptions): SpendWatch {
  const every = options.every ?? HOUR;
  const retry = options.retry ?? 15 * MINUTE;
  const limit = options.limit ?? 30_000;
  for (const [name, value] of Object.entries({ every, retry, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the spend watch of ${options.provider} is not a whole count of milliseconds above 0.`);
  }
  const zone = options.timeZone;
  if (localTime(0, zone) === undefined) throw new Error(`The time zone of the spend watch of ${options.provider} is not an IANA time zone.`);
  // The zone is valid, thus only an instant that is not a date gives no month.
  const monthStart = (at: Instant): Instant | undefined => monthOf(at, zone)?.start;
  // The two gates have one name, one key and one store. Thus a note of one gate changes the count of both.
  const { gate } = options.gates;
  let last: SpendRead | undefined;
  const reads = readSchedule<SpendReading>({
    what: "spend",
    every,
    retry,
    limit,
    read: (signal, at) => {
      const start = monthStart(at);
      return start === undefined ? Promise.resolve({ ok: false, message: "The time of the read has no month." }) : options.read(start, signal);
    },
    use(reading, at, startedAt) {
      if (!reading.ok) return reading.message;
      if (!Number.isFinite(reading.usedUsd)) return "The read of the spend gave no finite amount.";
      if (monthStart(at) !== monthStart(startedAt)) return "The month of the cap ended during the read of the spend.";
      // A credit gives a spend below 0. The count stays at the count of the gates.
      const units = spendUnits(Math.max(0, reading.usedUsd));
      try {
        // A reading with no `resetAt` blocks nothing. It only makes the count of the month larger.
        gate.note({ remaining: Math.max(0, gate.quota.limit - units) });
      } catch (error) {
        return `The count of the spend did not take the read: ${errorMessage(error)}`;
      }
      last = { usedUsd: reading.usedUsd, units, at };
      return undefined;
    },
  });
  return {
    provider: options.provider,
    check: (clock, stop) => reads.check(clock, stop),
    nextReadAt: () => reads.nextReadAt(),
    spend: () => last,
    failure: () => reads.failure(),
    health: () => readHealth(`spend of ${options.provider}`, reads, last?.at),
    shift(size) {
      reads.shift(size);
      if (last !== undefined) last = { ...last, at: last.at + size };
    },
  };
}

/**
 * This function gives the notes of a watch of the spend for the heartbeat: one note after a failed read, or none. The
 * note names the provider, and it holds no amount and no message of the provider.
 */
export function spendNotes(watch: Pick<SpendWatch, "provider" | "failure"> | undefined): readonly string[] {
  if (watch?.failure() === undefined) return [];
  return [`The last read of the spend of ${watch.provider} failed. The cap has no usage outside the sends since the last read that passed.`];
}

/** A monthly cap of the spend of a provider account: the fields of a `SpendConfig` of the configuration, and a name. */
export interface SpendCap extends Pick<SpendConfig, "monthlyUsd" | "fixed" | "reserveUsd" | "timeZone"> {
  /** The name of the quota in a message: for example `Twilio spend`. */
  readonly name: string;
}

/**
 * This function gives the spend entry of a channel with a cost: the first entry for a provider in the `dependsOn` of the
 * channel. The cap of the entry counts each send of the channel.
 */
export function spendEntryOf(descriptor: ChannelDescriptor, spend: readonly SpendConfig[] | undefined): SpendConfig | undefined {
  return spend?.find((entry) => descriptor.dependsOn.includes(entry.provider));
}

/** The unit of a quota of the spend, for the texts of the core. */
export const SPEND_UNIT = "cents";

/**
 * This function gives the quota of a cap for a gate of `polite-crawler/api`. The units are cents, and
 * the window is the calendar month. A send takes `spendUnits` of its cost. The limit is the monthly cap less the fixed
 * costs, in cents.
 *
 * @throws Error when the cap, a fixed cost or the reserve is not valid.
 */
export function spendQuota(cap: SpendCap): Quota {
  const fixed = (cap.fixed ?? []).map((cost) => cents(cost.usd));
  if (!fixed.every((value) => value >= 0)) throw new Error(`A fixed cost of ${cap.name} is not 0 or more US dollars.`);
  const limit = cents(cap.monthlyUsd) - fixed.reduce((sum, value) => sum + value, 0);
  const reserve = cents(cap.reserveUsd ?? 0);
  if (!(limit > 0)) throw new Error(`The monthly cap of ${cap.name} less its fixed costs is not above 0 US dollars.`);
  if (!(reserve >= 0 && reserve < limit)) throw new Error(`The reserve of ${cap.name} is not 0 or more and less than the cap.`);
  return { name: cap.name, limit, reserve, window: { kind: "calendar", unit: "month", timeZone: cap.timeZone } };
}

/**
 * This function gives the cost of one send in whole cents, rounded up. Thus the cap does not count less
 * than the price at any time. It rounds the cost to a millionth of a dollar first, so `0.07` gives 7, not 8.
 *
 * @throws Error when the cost is not 0 or more.
 */
export function spendUnits(costUsd: number): number {
  if (!(Number.isFinite(costUsd) && costUsd >= 0)) throw new Error("The cost of a send is not 0 or more US dollars.");
  return Math.ceil(Math.round(costUsd * 1_000_000) / 10_000);
}

/** The two gates of one cap of the spend, and the gate of the own count. */
export interface SpendGates {
  /** The gate of each message below `life-safety`. It keeps the reserve of the cap. */
  readonly gate: QuotaGate;
  /** The gate of a `life-safety` message. It has no reserve. It counts the same units as `gate`. */
  readonly lifeSafety: QuotaGate;
  /**
   * The gate of the own count (AL-91). It counts each send of the channels, and the watch of the spend gives it no read.
   * Thus its count is the cost of the sends of this copy alone. It refuses no send.
   */
  readonly own: QuotaGate;
}

/**
 * This function makes the two gates of one quota of the spend. The gates have one name, one key and one store,
 * thus they keep one record. Only the gate of `life-safety` takes the units of the reserve.
 *
 * The gate of the own count has the key `<key>:own` in the same store. Thus it keeps a second record, and a restart keeps it.
 *
 * @throws Error when the quota is not valid.
 */
export function spendGates(quota: Quota, options: QuotaGateOptions): SpendGates {
  const full = { ...quota, reserve: 0 };
  return { gate: quotaGate(quota, options), lifeSafety: quotaGate(full, options), own: quotaGate(full, { ...options, key: ownKey(options.key) }) };
}

/** This function gives the key of the gate of the own count of a cap. */
function ownKey(key: string): string {
  return `${key}:own`;
}

function cents(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * 100) : Number.NaN;
}
