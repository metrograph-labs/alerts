/**
 * The watch of the use of each hard limit of a paid provider account (AL-111), and the reader of the use of GitHub.
 *
 * - The runtime starts `check` of each watch in each pass. A watch reads only when it is due: after a delay from its
 *   first check, then once in each interval.
 * - A failed read keeps the last read that passed. The core gives the line `unread` when the last read is too old.
 * - The watch keeps no record. After a restart, the first read comes after the delay again. Until then, the core keeps
 *   the open levels of the use.
 * - The reader of GitHub loads the client of GitHub and the rule of the levels at its first read. Thus a start loads
 *   neither of them.
 */
import type { Duration, Instant, LimitConfig, LimitUse, LimitUseRead, ReadHealth, SecretLookup } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import type { RestClient, RestTransport } from "@procedures/gh";
import { readHealth, readSchedule, type ReadFailure, type ReadWatch } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The answer of a reader of a use. A reader does not throw. A throw is a failure too. */
export type UseReading =
  | {
      readonly ok: true;
      /** The month of the use, as `YYYY-MM`. */
      readonly month: string;
      /** The used amount of the month. */
      readonly used: number;
      /** The hard limit of the month. */
      readonly limit: number;
      /** The currency of the amounts, as a code of ISO 4217. */
      readonly currency: string;
      /** The largest level that the share reached. A share below each level has none. */
      readonly level?: number;
      /** The levels of the rule of the read. */
      readonly levels: readonly number[];
    }
  | ReadFailure;

/** The options of one watch of the use of a limit. */
export interface LimitWatchOptions {
  /** The id of the limit, from the configuration. */
  readonly id: string;
  /** The provider: for example `provider:github`. */
  readonly provider: string;
  /** The name of the limit in a text. */
  readonly title: string;
  /** The levels of the configuration. Without them, the watch takes the levels of its first read that passes. */
  readonly levels?: readonly number[];
  /** This function reads the use from the time `at`. It stops at the abort of the signal. */
  readonly read: (signal: AbortSignal, at: Instant) => Promise<UseReading>;
  /** The time from the first check to the first read. The default is 20 minutes. Thus a start does not load the reader. */
  readonly delay?: Duration;
  /** The time between two reads that pass. The default is one day. */
  readonly every?: Duration;
  /** The time after a failed read before the next read. The default is one hour. */
  readonly retry?: Duration;
  /** The longest time with no read that passed. The default is 2 days. Thus one failed day gives no line. */
  readonly maxAge?: Duration;
  /** The longest time of one read. The default is one minute. */
  readonly limit?: Duration;
}

/** The watch of the use of one limit. */
export interface LimitWatch extends ReadWatch {
  readonly id: string;
  /** This method gives the watch as data of the core. Before the first check, it gives `undefined`. */
  use(): LimitUse | undefined;
  /** This method gives the message of the last read when it failed. */
  failure(): string | undefined;
  /** This method gives the health of the reads. It holds no amount and no message. */
  health(): ReadHealth;
}

/**
 * This function makes the watch of the use of one limit.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0, or a level is not a finite share above 0
 */
export function limitWatch(options: LimitWatchOptions): LimitWatch {
  const delay = options.delay ?? 20 * MINUTE;
  const every = options.every ?? DAY;
  const retry = options.retry ?? HOUR;
  const maxAge = options.maxAge ?? 2 * DAY;
  const limit = options.limit ?? MINUTE;
  for (const [name, value] of Object.entries({ delay, every, retry, maxAge, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the watch of the limit ${options.id} is not a whole count of milliseconds above 0.`);
  }
  if (options.levels !== undefined && !options.levels.every((level) => Number.isFinite(level) && level > 0)) throw new Error(`A level of the watch of the limit ${options.id} is not a finite share above 0.`);
  let since: Instant | undefined;
  let read: LimitUseRead | undefined;
  let levels = options.levels;
  const reads = readSchedule<UseReading>({
    what: "use",
    every,
    retry,
    limit,
    read: (signal, at) => options.read(signal, at),
    use(reading, at) {
      if (!reading.ok) return reading.message;
      const amounts = [reading.used, reading.limit, ...(reading.level === undefined ? [] : [reading.level])];
      if (!amounts.every((amount) => Number.isFinite(amount) && amount >= 0) || !/^\d{4}-\d{2}$/.test(reading.month) || !/^[A-Z]{3}$/.test(reading.currency)) {
        return "The read of the use gave no finite amounts, no month or no currency code.";
      }
      levels ??= reading.levels;
      read = { month: reading.month, used: reading.used, limit: reading.limit, currency: reading.currency, ...(reading.level === undefined ? {} : { level: reading.level }), at };
      return undefined;
    },
  });
  const nextReadAt = (): Instant | undefined => reads.nextReadAt() ?? (since === undefined ? undefined : since + delay);

  return {
    id: options.id,
    check(clock: WallClock, stop?: AbortSignal) {
      since ??= clock.now();
      if (reads.nextReadAt() === undefined && clock.now() < since + delay) return Promise.resolve();
      return reads.check(clock, stop);
    },
    nextReadAt,
    use() {
      if (since === undefined) return undefined;
      const { id, provider, title } = options;
      return { id, provider, title, levels: levels ?? [], maxAge, since, ...(read === undefined ? {} : { read }) };
    },
    failure: () => reads.failure(),
    health: () => readHealth(`use of ${options.id}`, { failure: () => reads.failure(), nextReadAt }, read?.at),
    shift(size) {
      if (since !== undefined) since += size;
      reads.shift(size);
      if (read !== undefined) read = { ...read, at: read.at + size };
    },
  };
}

/** The provider of GitHub in a watch of a limit. The runtime has a reader only for this provider. */
export const GITHUB_PROVIDER = "provider:github";

/**
 * The default key of `secrets.env` that holds the token of the billing reads of GitHub. A fine-grained token needs the
 * permissions of `BILLING_PERMISSIONS` of `@procedures/gh`: Plan (read) of a user, Administration (read) of an organization.
 * A fine-grained token has one owner, thus a user and an organization need two tokens. `LimitConfig.tokenKey` names the
 * key of each other token.
 */
export const GITHUB_BILLING_TOKEN = "GITHUB_BILLING_TOKEN";

/** This function gives the key of the token of a limit of GitHub: `tokenKey`, or `GITHUB_BILLING_TOKEN`. */
export function githubTokenKey(limit: Pick<LimitConfig, "tokenKey">): string {
  return limit.tokenKey ?? GITHUB_BILLING_TOKEN;
}

/** The modules that the reader of GitHub loads at its first read. A test gives its own. */
export interface GithubUseModules {
  readonly gh: Pick<typeof import("@procedures/gh"), "createRestClient" | "readBillingUsage" | "readOrganizationBudgets" | "netAmountByProduct">;
  readonly spend: Pick<typeof import("@mark1russell7/stack-spend"), "useStates" | "USE_LEVELS">;
}

/** The options of the readers of GitHub. */
export interface GithubUseOptions {
  /** The token of the billing reads, from the key of `githubTokenKey`. */
  readonly token: string;
  /** The transport of the client of GitHub. The default is the transport of `@procedures/gh`. A test gives a fake. */
  readonly transport?: RestTransport;
  /** This function loads the modules. The default imports `@procedures/gh` and `@mark1russell7/stack-spend`. */
  readonly load?: () => Promise<GithubUseModules>;
}

/** A reader of the use of one limit. */
export type UseReader = (signal: AbortSignal, at: Instant) => Promise<UseReading>;

async function loadGithubUse(): Promise<GithubUseModules> {
  const [gh, spend] = await Promise.all([import("@procedures/gh"), import("@mark1russell7/stack-spend")]);
  return { gh, spend };
}

const same = (one: string, other: string): boolean => one.toLowerCase() === other.toLowerCase();

/**
 * This function gives the reader of the use of each limit of GitHub with one token. The readers share one client and one
 * load of the modules. A load that fails loads again at the next read.
 *
 * - The used amount is the sum of the net amounts of the products of the limit in the month of the read, in UTC.
 * - The limit is `monthlyUsd`, or the smallest budget of the organization that stops the paid use of its product.
 * - The level comes from `useStates` of `@mark1russell7/stack-spend`. A use above a limit of 0 reaches the largest level.
 * - A message of a failure names no amount and no token.
 */
export function githubUse(options: GithubUseOptions): (limit: LimitConfig) => UseReader {
  let loaded: Promise<{ readonly modules: GithubUseModules; readonly client: RestClient }> | undefined;
  const ready = (): Promise<{ readonly modules: GithubUseModules; readonly client: RestClient }> => {
    loaded ??= (options.load ?? loadGithubUse)().then(
      (modules) => ({ modules, client: modules.gh.createRestClient({ token: options.token, ...(options.transport === undefined ? {} : { transport: options.transport }) }) }),
      (error: unknown) => {
        loaded = undefined;
        throw error;
      },
    );
    return loaded;
  };
  return (limit) => async (signal, at) => {
    const { modules, client } = await ready();
    const today = new Date(at).toISOString().slice(0, 10);
    const date = new Date(at);
    const account = { kind: limit.accountKind, login: limit.account };
    const items = await modules.gh.readBillingUsage(client, account, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }, signal);
    if (items === undefined) return { ok: false, message: "GitHub gave a usage report that the reader cannot read." };
    const sums = modules.gh.netAmountByProduct(items);
    const used = limit.products.reduce((sum, product) => sum + (sums.get(product.toLowerCase()) ?? 0), 0);
    let amount = limit.monthlyUsd;
    if (amount === undefined) {
      const budgets = await modules.gh.readOrganizationBudgets(client, limit.account, signal);
      if (budgets === undefined) return { ok: false, message: "GitHub gave budgets that the reader cannot read." };
      const product = limit.budget ?? limit.products[0] ?? "";
      const stops = budgets.filter((budget) => budget.stops && same(budget.scope, "organization") && same(budget.entity, limit.account) && same(budget.product, product));
      if (stops.length === 0) return { ok: false, message: `The organization of the limit ${limit.id} has no budget that stops the paid use of ${product}.` };
      amount = Math.min(...stops.map((budget) => budget.amount));
    }
    const levels = limit.levels ?? modules.spend.USE_LEVELS;
    const layer = { schema: "spend/1", currency: "USD", kinds: [], proofDays: 365, services: [{ part: limit.id, billing: "metered", limits: [{ kind: "provider", amount }] }] } as const;
    const [state] = modules.spend.useStates(layer, [{ part: limit.id, source: "provider", amount: used, date: today }], { today, levels });
    // A limit of 0 has no share. A use above it is over the limit, thus it reaches the largest level.
    const level = state?.level ?? (state?.over === true ? Math.max(...levels) : undefined);
    return { ok: true, month: today.slice(0, 7), used, limit: amount, currency: "USD", levels, ...(level === undefined ? {} : { level }) };
  };
}

/**
 * This function gives the problems of the watches of the limits (AL-111). A provider with no reader is a problem. A
 * limit of GitHub with no value for the key of its token is a problem. A problem names ids and keys, and no value.
 */
export function limitProblems(limits: readonly LimitConfig[], secret: SecretLookup): string[] {
  return limits.flatMap((limit) => {
    if (limit.provider !== GITHUB_PROVIDER) return [`The watch of the limit ${limit.id} names the provider ${limit.provider}, and the runtime has no reader of it.`];
    const key = githubTokenKey(limit);
    return (secret(key) ?? "") === "" ? [`The watch of the limit ${limit.id} needs a token in the key ${key}, and the secret store has no value for it.`] : [];
  });
}

/**
 * This function makes the watch of each limit of GitHub in the configuration (AL-111). The watches with one key of a token
 * share one reader. A limit with no token gets no watch: `limitProblems` stops such a start.
 */
export function limitWatches(limits: readonly LimitConfig[], secret: SecretLookup, transport?: RestTransport): LimitWatch[] {
  const readers = new Map<string, (limit: LimitConfig) => UseReader>();
  return limits.flatMap((limit) => {
    if (limit.provider !== GITHUB_PROVIDER) return [];
    const key = githubTokenKey(limit);
    const token = secret(key) ?? "";
    if (token === "") return [];
    let reader = readers.get(key);
    if (reader === undefined) {
      reader = githubUse({ token, ...(transport === undefined ? {} : { transport }) });
      readers.set(key, reader);
    }
    return [limitWatch({ id: limit.id, provider: limit.provider, title: limit.title, ...(limit.levels === undefined ? {} : { levels: limit.levels }), read: reader(limit) })];
  });
}
