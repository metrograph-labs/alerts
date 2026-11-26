/**
 * The payload of the health route of the runtime. It tells the state of each part of the system. The parts are the
 * sources, the lateness, the coverage, the other copies, the quotas, the balances, the reads on a schedule and the channels.
 */

import type {
  BalanceStage,
  ChannelQuota,
  CopyRead,
  CopyStage,
  CopyWatch,
  Coverage,
  FetchFailure,
  Instant,
  ProviderBalance,
  QuotaStage,
  SourceHealth,
} from "./contracts.ts";
import { DEFAULT_CHANNEL_DOWN, runOpens, type ChannelDownPolicy, type ChannelSnapshot } from "./channel-down.ts";
import type { Lateness } from "./lateness.ts";
import { balanceStages, copyStages, quotaStages } from "./system-reports.ts";
import { CONTEXT_SHAPES, redactSecrets, redactSecretShapes, SECRET_SHAPES, type Secret, type SecretShape } from "@mark1russell7/text/redact";

/**
 * The name of the format of the health payload. A change that breaks a reader gets a new name. The fifth format adds the
 * message of the last failure of a source (AL-182).
 */
export const HEALTH_FORMAT = "alerts-health/5";

/** The most UTF-16 code units of the message of the last failure in the payload. A longer message is cut, with `…` at its end. */
export const FAILURE_MESSAGE_LIMIT = 300;

/**
 * The shape of the user part of a URL in a text, for example `user:password@` or `token@`. The redaction puts a mark in
 * place of all of it. The shape `url-password` of `@mark1russell7/text` removes only a password and keeps the user, but a
 * token can be the whole user part. The health keeps only the scheme and the host, thus the user goes too.
 */
export const URL_USER_SHAPE: SecretShape = Object.freeze({
  id: "url-user",
  label: "the user part of a URL",
  pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?<secret>[^\s/?#@]+)@/u,
});

/**
 * The shape of the path, the query and the fragment of a URL in a text. The redaction keeps the scheme and the host of
 * the URL, and puts a mark in place of the rest. Thus a key or a place in the address of a fetch does not go in.
 */
export const URL_PATH_SHAPE: SecretShape = Object.freeze({
  id: "url-path",
  label: "the path, the query and the fragment of a URL",
  pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]+(?<secret>[/?#][^\s"'<>]*)/u,
});

/**
 * The health of one source in the payload. It keeps the time, the kind and the redacted message of the last failure
 * (`failureMessage`). The message has no known secret, no token of a known shape and no path of a URL.
 */
export interface SourceHealthView extends Omit<SourceHealth, "lastFailure"> {
  readonly lastFailure?: {
    readonly at: Instant;
    readonly kind: FetchFailure["kind"];
    /** The redacted message of the failure, at most `FAILURE_MESSAGE_LIMIT` characters. An empty message gives none. */
    readonly message?: string;
  };
}

/** The health of another copy of the system: its stages at the time of the read, and its last read that passed. */
export interface CopyHealth {
  readonly copy: string;
  readonly stages: readonly CopyStage[];
  readonly read?: CopyRead;
}

/** The health of the quota of one channel: the quota, and the stages that it reached. */
export interface QuotaHealth {
  readonly quota: ChannelQuota;
  readonly stages: readonly QuotaStage[];
}

/**
 * The health of one read on a schedule of the runtime, for example the read of the replies of the texts. It holds no
 * message of a failure and no value of the read.
 */
export interface ReadHealth {
  /** The read, as words: for example `replies of the texts` or `spend of provider:twilio`. */
  readonly what: string;
  /** The end of the last read that passed, or `null` before it. */
  readonly at: Instant | null;
  /** This value is true when the last read failed. */
  readonly failed: boolean;
  /** The time of the next read, or `null` before the first read. */
  readonly next: Instant | null;
}

/**
 * The health of one channel of this copy (AL-65): its endpoints, its last good call and its run of failed calls. The run
 * holds the kind of each failure, and not its message. Thus a passed probe shows as a new time in `good`.
 */
export interface ChannelHealth extends ChannelSnapshot {
  /** This value is true when the run opens a line under the policy of the down channels (`runOpens`). */
  readonly down: boolean;
}

/** The health of the balance of one provider account: the balance, and its stages at the time of the read. */
export interface BalanceHealth {
  readonly balance: ProviderBalance;
  readonly stages: readonly BalanceStage[];
}

/**
 * The answer of the health route of the runtime. The route is on the loopback address only, because the coverage holds
 * the ids of the places. The payload holds no secret. The message of the last failure of each source is redacted
 * (`failureMessage`).
 */
export interface HealthPayload {
  /** The format of the payload. A page of another format tells the reader to start the runtime of its own version. */
  readonly format: typeof HEALTH_FORMAT;
  /** The time of the last pass, or `null` before the first pass. The sources, the lateness and the coverage are from it. */
  readonly at: Instant | null;
  /** The time of the read. The stages of the copies and of the balances are at this time. */
  readonly now: Instant;
  readonly sources: readonly SourceHealthView[];
  readonly lateness: readonly Lateness[];
  readonly coverage: readonly Coverage[];
  readonly copies: readonly CopyHealth[];
  readonly quotas: readonly QuotaHealth[];
  readonly balances: readonly BalanceHealth[];
  readonly reads: readonly ReadHealth[];
  readonly channels: readonly ChannelHealth[];
}

/** These are the inputs of the payload of the health route. */
export interface HealthPayloadInput {
  /** The time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The time of the read. */
  readonly now: Instant;
  /** The health of each source at the last pass. */
  readonly sources: readonly SourceHealth[];
  /** The lateness of each expectation at the last pass. */
  readonly lateness: readonly Lateness[];
  /** The coverage of each kind at each place at the last pass. */
  readonly coverage: readonly Coverage[];
  /** The watch of each other copy at the time of the read. */
  readonly copies: readonly CopyWatch[];
  /** The quota of each channel at the time of the read. */
  readonly quotas: readonly ChannelQuota[];
  /** The balance of each provider account that has a read. */
  readonly balances: readonly ProviderBalance[];
  /** The health of each read on a schedule, other than the balances, at the time of the read. */
  readonly reads: readonly ReadHealth[];
  /** The channels of this copy at the time of the read (AL-65). The default is no channel. */
  readonly channels?: readonly ChannelSnapshot[];
  /** The policy of the down channels. The default is `DEFAULT_CHANNEL_DOWN`. */
  readonly channelDown?: ChannelDownPolicy;
  /** The secrets that the message of each failure must not hold, for example each value of `secrets.env`. The default is none. */
  readonly secrets?: readonly Secret[];
}

/**
 * This function gives the message of a failure for the payload. The steps are in this order:
 *
 * 1. `redactSecrets` of `@mark1russell7/text` removes each form of each secret of `secrets`.
 * 2. `redactSecretShapes` removes each token of a known shape (`SECRET_SHAPES`) and each value after the name of a
 *    secret (`CONTEXT_SHAPES`).
 * 3. The user part of each URL goes (`URL_USER_SHAPE`).
 * 4. The path, the query and the fragment of each URL go (`URL_PATH_SHAPE`). The scheme and the host stay.
 * 5. Each run of white space becomes one space, and the message is cut to `FAILURE_MESSAGE_LIMIT` code units.
 *
 * It gives `undefined` for a message with no text.
 */
export function failureMessage(message: string, secrets: readonly Secret[] = []): string | undefined {
  const known = secrets.length === 0 ? message : redactSecrets(message, secrets);
  const shaped = redactSecretShapes(known, { shapes: [...SECRET_SHAPES, ...CONTEXT_SHAPES] });
  const users = redactSecretShapes(shaped, { shapes: [URL_USER_SHAPE] });
  const text = redactSecretShapes(users, { shapes: [URL_PATH_SHAPE], mark: "/…" }).replace(/\s+/gu, " ").trim();
  if (text === "") return undefined;
  if (text.length <= FAILURE_MESSAGE_LIMIT) return text;
  // The limit counts code units, as the schema does. A cut does not split a surrogate pair.
  const cut = text.slice(0, FAILURE_MESSAGE_LIMIT - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/**
 * This function gives the health of a source for the payload. The last failure keeps its time and its kind, and its
 * message after `failureMessage` with `secrets`.
 */
export function sourceHealthView(health: SourceHealth, secrets: readonly Secret[] = []): SourceHealthView {
  const { lastFailure, ...rest } = health;
  if (lastFailure === undefined) return rest;
  const message = failureMessage(lastFailure.failure.message, secrets);
  return { ...rest, lastFailure: { at: lastFailure.at, kind: lastFailure.failure.kind, ...(message === undefined ? {} : { message }) } };
}

/**
 * This function gives the payload of the health route. It keeps the order of each list of its input. The core gives the
 * stages, thus the page and the system reports agree on each stage.
 */
export function healthPayload(input: HealthPayloadInput): HealthPayload {
  const { at, now } = input;
  const policy = input.channelDown ?? DEFAULT_CHANNEL_DOWN;
  return {
    format: HEALTH_FORMAT,
    at,
    now,
    sources: input.sources.map((health) => sourceHealthView(health, input.secrets ?? [])),
    lateness: input.lateness,
    coverage: input.coverage,
    copies: input.copies.map((watch) => ({ copy: watch.copy, stages: copyStages(watch, now), ...(watch.read === undefined ? {} : { read: watch.read }) })),
    quotas: input.quotas.map((quota) => ({ quota, stages: quotaStages(quota) })),
    balances: input.balances.map((balance) => ({ balance, stages: balanceStages(balance, now) })),
    reads: input.reads,
    channels: (input.channels ?? []).map((snapshot) => ({ ...snapshot, down: snapshot.run !== undefined && runOpens(snapshot.run, policy) })),
  };
}
