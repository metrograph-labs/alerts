/**
 * This module holds the notices of the supervisor about a loop of the runtime (AL-55). A runtime that stops again and
 * again sends no alert, because the runtime is the sender of the alerts. Thus the supervisor sends one signed request to
 * the receiver of its copy at the start of a loop. It sends one more request at the end of the loop.
 *
 * - The URL of the receiver is the key `SUPERVISOR_WEBHOOK_KEY` of `secrets.env`. Each copy has its own file, thus its own
 *   receiver. The secrets that sign each request are the key `WEBHOOK_SECRET_KEY`, the key of the webhook channel.
 * - A loop starts at `LOOP_STOPS` stops of the runtime in `LOOP_WINDOW`. A stop after a ready start counts too.
 * - A loop ends when the runtime is ready and has no stop for one more `LOOP_WINDOW`. One loop gives one event
 *   `runtime.restarts` and one event `runtime.ready`.
 * - A send that fails goes again after `LOOP_RETRY`, with the same id. Thus the receiver keeps one of each event.
 * - The supervisor reads the keys at its start. A change of the keys takes effect at the next start of the supervisor.
 * - A bad key does not stop the supervisor. The supervisor writes one warning, and it sends no notice.
 */
import { createHash } from "node:crypto";
import type { Duration, Instant, SecretLookup, SendOutcome } from "@mark1russell7/alerts";
import { sendWebhookEvent, WEBHOOK_URL, type WebhookFetch, type WebhookSecret } from "@mark1russell7/alerts-channel-webhook";
import type { Clock } from "@mark1russell7/algebra/clock";
import { err, ok, type Result } from "@mark1russell7/optional";
import type { LogFields, LogLevel } from "@mark1russell7/service";
import { RUNTIME_PROGRAM } from "./host.ts";
import { WEBHOOK_SECRET_KEY, webhookSetup } from "./instance.ts";

/** The key of `secrets.env` with the URL of the receiver of the notices of the supervisor of this copy. */
export const SUPERVISOR_WEBHOOK_KEY = "SUPERVISOR_WEBHOOK_URL";

/** The count of stops in `LOOP_WINDOW` that starts a loop. */
export const LOOP_STOPS = 3;

/** The window of the stops of a loop, and the steady time that ends a loop. */
export const LOOP_WINDOW: Duration = 15 * 60_000;

/** The wait before a failed send goes again. */
export const LOOP_RETRY: Duration = 60_000;

/** The type of the event at the start of a loop. */
export const RESTARTS_EVENT = "runtime.restarts";

/** The type of the event at the end of a loop. */
export const READY_EVENT = "runtime.ready";

/** The most characters of the end of the last stop in an event. */
export const LAST_LIMIT = 200;

// The start of the warning of the group at each end of the runtime.
const STOPPED = `${RUNTIME_PROGRAM} stopped: `;

/** One entry of the log of the supervisor that the rule of a loop reads. The times are monotonic times. */
export type SupervisorEntry = { readonly kind: "stop"; readonly at: number; readonly last: string } | { readonly kind: "ready"; readonly at: number };

/**
 * This function gives the entry of a line of the log of the group, or `undefined` for each other line.
 *
 * - The runner of `@mark1russell7/service` writes the warning `runtime stopped: <end>` with the fields `code` and
 *   `signal` at each end of the runtime. The end tells the cause, for example a missed ready window, and the exit.
 * - The runner writes the line `runtime is ready` at each ready start.
 * - A planned stop of the group writes no warning.
 *
 * The end in the entry has one line of `LAST_LIMIT` characters or fewer.
 */
export function supervisorEntry(level: LogLevel, message: string, fields: LogFields, at: number): SupervisorEntry | undefined {
  if (fields["program"] !== RUNTIME_PROGRAM) return undefined;
  if (level === "warn" && "code" in fields && "signal" in fields && message.startsWith(STOPPED)) {
    const end = message.slice(STOPPED.length).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
    return { kind: "stop", at, last: end.length > LAST_LIMIT ? `${end.slice(0, LAST_LIMIT - 1)}…` : end };
  }
  if (level === "info" && message === `${RUNTIME_PROGRAM} is ready`) return { kind: "ready", at };
  return undefined;
}

/** A loop of the runtime: its first stop, its count of stops and the end of its last stop. */
export interface Loop {
  /** The monotonic time of the first stop in the window that started the loop. */
  readonly since: number;
  readonly stops: number;
  readonly last: string;
}

/** The state of the rule of a loop. */
export interface LoopState {
  /** The monotonic times of the stops in the window, the oldest first. */
  readonly stops: readonly number[];
  /** The open loop, or `undefined`. */
  readonly loop?: Loop | undefined;
}

/** The state of a supervisor with no stop. */
export const LOOP_START: LoopState = { stops: [] };

/** The input of the rule of a loop: an entry of the log, or the end of a steady time that a ready start armed. */
export type LoopInput = SupervisorEntry | { readonly kind: "steady"; readonly at: number };

/** The step of the rule: the next state, the event to tell, and the change of the steady check. */
export interface LoopOutcome {
  readonly state: LoopState;
  /** `start` is the start of a loop, and `end` is the end of a loop. */
  readonly tell?: { readonly kind: "start" | "end"; readonly loop: Loop } | undefined;
  /** A time arms the steady check at that time. `null` stops the check. `undefined` keeps it. */
  readonly check?: number | null | undefined;
}

/**
 * This function gives the next step of the rule of a loop. It is pure, thus a test gives each sequence of inputs.
 *
 * - A stop adds its time to the window. The stop that makes the count `stops` starts a loop. A stop in an open loop
 *   adds to the count of the loop, and it stops the steady check.
 * - A ready start in an open loop arms the steady check one `window` later.
 * - A steady check with no stop in the last `window` ends the loop.
 */
export function loopStep(state: LoopState, input: LoopInput, rule: { readonly stops: number; readonly window: Duration } = { stops: LOOP_STOPS, window: LOOP_WINDOW }): LoopOutcome {
  switch (input.kind) {
    case "stop": {
      const stops = [...state.stops.filter((at) => at > input.at - rule.window), input.at];
      if (state.loop !== undefined) return { state: { stops, loop: { ...state.loop, stops: state.loop.stops + 1, last: input.last } }, check: null };
      if (stops.length < rule.stops) return { state: { stops } };
      const loop: Loop = { since: stops[0] ?? input.at, stops: stops.length, last: input.last };
      return { state: { stops, loop }, tell: { kind: "start", loop }, check: null };
    }
    case "ready":
      return state.loop === undefined ? { state } : { state, check: input.at + rule.window };
    case "steady": {
      const lastStop = state.stops.at(-1);
      if (state.loop === undefined || (lastStop !== undefined && lastStop > input.at - rule.window)) return { state };
      return { state: LOOP_START, tell: { kind: "end", loop: state.loop } };
    }
  }
}

/** One event of the supervisor for the receiver. */
export interface LoopEvent {
  readonly type: string;
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * This function gives the event of a start or an end of a loop. The id comes from the copy, the type and the wall time of
 * the first stop. Thus a send again has the same id, and the events of two loops have different ids.
 */
export function loopEvent(tell: NonNullable<LoopOutcome["tell"]>, copy: string, since: Instant, window: Duration = LOOP_WINDOW): LoopEvent {
  const type = tell.kind === "start" ? RESTARTS_EVENT : READY_EVENT;
  const id = createHash("sha256").update(`${copy}\u0000${type}\u0000${String(since)}`).digest("hex").slice(0, 32);
  const sinceText = new Date(since).toISOString();
  const data = tell.kind === "start" ? { copy, stops: tell.loop.stops, windowMs: window, last: tell.loop.last, since: sinceText } : { copy, stops: tell.loop.stops, since: sinceText };
  return { type, id, data };
}

/** The receiver of the notices of the supervisor, and the secrets that sign each request. */
export interface LoopReceiver {
  readonly url: string;
  readonly secrets: readonly WebhookSecret[];
}

const RECEIVER_URL = new RegExp(`^(?:${WEBHOOK_URL})$`, "u");

/**
 * This function gives the receiver of the notices from the keys of `secrets.env`. A copy with no key
 * `SUPERVISOR_WEBHOOK_KEY` has no receiver. A problem names a key, and it holds no value.
 */
export function loopReceiver(secret: SecretLookup): Result<LoopReceiver | undefined, readonly string[]> {
  const url = (secret(SUPERVISOR_WEBHOOK_KEY) ?? "").trim();
  if (url === "") return ok(undefined);
  if (!RECEIVER_URL.test(url)) return err([`The value of ${SUPERVISOR_WEBHOOK_KEY} is not an https URL, and not an http URL of the loopback host.`]);
  const secrets = webhookSetup(secret);
  if (secrets.tag === "err") return secrets;
  if (secrets.value === undefined) return err([`The key ${SUPERVISOR_WEBHOOK_KEY} needs the key ${WEBHOOK_SECRET_KEY}, because each notice is signed.`]);
  return ok({ url, secrets: secrets.value });
}

/** The options of `loopNotifier`. */
export interface LoopNotifierOptions {
  /** The id of the copy (`copy.json`). */
  readonly copy: string;
  readonly receiver: LoopReceiver;
  readonly fetch: WebhookFetch;
  readonly userAgent: string;
  /** The monotonic clock of the window, the steady check and the retries: the clock of the ports of the host. */
  readonly clock: Clock;
  /** This function gives the wall time of the instants in the events and of each signature. */
  readonly wall: () => Instant;
  /** This function writes a warning of a failed send. The text holds no URL and no secret. */
  readonly warn: (text: string) => void;
}

/** The notifier of the loops: the hook of the log of the supervisor, and the stop of its timers. */
export interface LoopNotifier {
  /** This hook reads each line of the log of the group. It does not throw and does not wait. */
  readonly log: (level: LogLevel, message: string, fields: LogFields) => void;
  /** This function stops the steady check and the retries, thus no timer keeps the supervisor alive after its stop. */
  readonly stop: () => void;
  /** This function gives a promise that ends when no send is in progress. The signature of a send ends on a thread of Node.js, not on the clock. */
  readonly idle: () => Promise<void>;
}

/**
 * This function makes the notifier of the loops of the supervisor. It sends the events in their order, one at a time.
 * A failed send goes again after `LOOP_RETRY`. After `stop`, the notifier sends nothing.
 */
export function loopNotifier(options: LoopNotifierOptions): LoopNotifier {
  let state = LOOP_START;
  let stopped = false;
  let check: (() => void) | undefined;
  let retry: (() => void) | undefined;
  // The wall time of the first stop of each loop, by its monotonic time.
  const walls = new Map<number, Instant>();
  const queue: LoopEvent[] = [];
  let sending: Promise<void> | undefined;
  const channel = { secrets: options.receiver.secrets, fetch: options.fetch, userAgent: options.userAgent, now: options.wall };

  const flush = (): void => {
    retry = undefined;
    const event = queue[0];
    if (stopped || sending !== undefined || event === undefined) return;
    const done = (outcome: SendOutcome): void => {
      sending = undefined;
      if (outcome.ok) {
        queue.shift();
        flush();
        return;
      }
      options.warn(`The notice ${event.type} of the supervisor was not sent (${outcome.kind}). It goes again in ${String(LOOP_RETRY / 1000)} s.`);
      if (!stopped) retry = options.clock.after(LOOP_RETRY, flush);
    };
    // A send that throws is a failed send too, thus the notice goes again after the retry wait.
    sending = sendWebhookEvent(channel, { url: options.receiver.url, ...event }).then(done, () => done({ ok: false, kind: "server", message: "The send threw." }));
  };

  const apply = (input: LoopInput): void => {
    const outcome = loopStep(state, input);
    state = outcome.state;
    if (outcome.check !== undefined) {
      check?.();
      check = undefined;
      if (outcome.check !== null) check = options.clock.after(Math.max(0, outcome.check - options.clock.now()), () => apply({ kind: "steady", at: options.clock.now() }));
    }
    if (outcome.tell !== undefined) {
      const since = walls.get(outcome.tell.loop.since) ?? options.wall();
      queue.push(loopEvent(outcome.tell, options.copy, since));
      flush();
    }
    // Only the stops in the window keep a wall time.
    for (const at of walls.keys()) if (!state.stops.includes(at) && state.loop?.since !== at) walls.delete(at);
  };

  const log: LoopNotifier["log"] = (level, message, fields) => {
    if (stopped) return;
    const entry = supervisorEntry(level, message, fields, options.clock.now());
    if (entry === undefined) return;
    if (entry.kind === "stop") walls.set(entry.at, options.wall());
    apply(entry);
  };

  return {
    log,
    stop: () => {
      stopped = true;
      check?.();
      retry?.();
      check = undefined;
      retry = undefined;
    },
    idle: async () => {
      while (sending !== undefined) await sending;
    },
  };
}
