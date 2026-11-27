/**
 * The mesh channel of the alert system. It sounds a siren on a LoRa mesh node near the bed (Meshtastic), and a person
 * pushes the button of the node to acknowledge. The channel gives the procedures of the channel contract of
 * `@mark1russell7/alerts`: `describe`, `send`, `status`, `cancel` and `probe`.
 *
 * - The radio link needs no phone, no push service and no internet link. It is its own failure domain.
 * - `send` writes an alarm frame, and it writes the frame again on a backoff until the ack, the cancel or `expires`.
 *   The bed node keeps one alarm for each id. Thus a frame that comes again does nothing new.
 * - The bed node answers each alarm frame of an acked id with the ack again. Thus a lost ack comes with the next frame.
 * - `status` gives `acknowledged` when the receiver has the ack of the bed node.
 * - `probe` passes only when the last heartbeat of the bed node is younger than a limit. Thus a dead node is visible.
 * - A siren has no silent mode. Thus the channel refuses a quiet message with the kind `quiet`.
 */

import { delay, wallClock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  COPY_ID,
  type AddressField,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type DeliveryStatus,
  type Duration,
  type Instant,
  type Level,
  type ProbeOutcome,
  type Receipt,
  type SendOutcome,
} from "@mark1russell7/alerts";
import { backoffDelay, backoffProblems, type Backoff } from "@mark1russell7/service/backoff";
import { errorMessage } from "@mark1russell7/text";
import { BED_BEAT_MS } from "./node-config.ts";
import { encodeFrame, isAlarmId, isNodeName, MESH_NODE, type AlarmFrame } from "./protocol.ts";
import type { LinkOutcome, MeshLink, MeshReceiver } from "./receiver.ts";

export * from "./link.ts";
export * from "./node-config.ts";
export * from "./protocol.ts";
export * from "./receiver.ts";

/** The id of the channel. */
export const MESH_CHANNEL = "mesh" as ChannelId;

/** The count of the characters of the delivery key in an alarm id. 16 hexadecimal characters are 64 bits. */
export const MESH_ID_CHARS = 16;

/**
 * The backoff of the sends of an alarm frame when the options give none. The first wait is 5 seconds. Each wait is two
 * times longer, up to 1 minute, with a jitter of up to 2 seconds. Thus a lost frame comes again soon, and the mesh does
 * not fill.
 */
export const MESH_RESEND: Backoff = { base: 5_000, factor: 2, cap: 60_000, jitter: { kind: "add", amount: 2_000 } };

/** The time after which the channel stops the sends of an alarm with no ack, when the options give none: 30 minutes. */
export const MESH_RESEND_FOR_MS: Duration = 30 * 60_000;

/** The count of the stop frames of one stop when the options give none. A mesh can lose a frame. */
export const MESH_STOP_COUNT = 3;

/** The count of heartbeat periods with no beat after which the probe fails. */
export const MESH_BEAT_PERIODS = 3;

/** The levels that sound the siren when the options give none. A siren at night is only for an urgent message. */
export const MESH_LEVELS: readonly Level[] = ["urgent", "life-safety"];

/** The most ended alarms that the channel keeps for `status`. */
export const MESH_KEPT = 64;

/**
 * The fields of the address of a person on the channel: the name of the bed node. The address needs no field, because
 * the channel has one bed node.
 */
export const MESH_ADDRESS: readonly AddressField[] = [{ name: "node", required: false, pattern: MESH_NODE, form: "the name of a mesh node: small letters, digits and hyphens" }];

/** The options of the mesh channel. */
export interface MeshChannelOptions {
  /** The link to the home node. */
  readonly link: MeshLink;
  /** The receiver of the frames of the home node. A worker of the service reads the link into it (`meshReceiverWorker`). */
  readonly receiver: MeshReceiver;
  /** The name of the bed node, for example `bed-node`. */
  readonly node: string;
  /** The nodes whose ack acknowledges an alarm. The default is the bed node only. */
  readonly ackNodes?: readonly string[] | undefined;
  /** The heartbeat period of the bed node. The default is `BED_BEAT_MS`. */
  readonly beatMs?: Duration | undefined;
  /** The age of the last beat at which the probe fails. The default is `MESH_BEAT_PERIODS` heartbeat periods. */
  readonly beatLimitMs?: Duration | undefined;
  /** The levels that sound the siren. The channel refuses a message of each other level. The default is `MESH_LEVELS`. */
  readonly levels?: readonly Level[] | undefined;
  /** The backoff of the sends of an alarm frame. The default is `MESH_RESEND`. */
  readonly resend?: Backoff | undefined;
  /** The time after which the channel stops the sends of an alarm with no ack. The default is `MESH_RESEND_FOR_MS`. */
  readonly resendForMs?: Duration | undefined;
  /** The count of the stop frames of one stop. The default is `MESH_STOP_COUNT`. */
  readonly stopCount?: number | undefined;
  /** The failure domains outside the cell that the channel needs. The radio link is its own failure domain, thus the default is none. */
  readonly dependsOn?: readonly string[] | undefined;
  /** The clock of the channel: the time of each state, and the timers of the sends. The default is the wall clock of the platform. */
  readonly clock?: WallClock | undefined;
  /** This function gives the random numbers of the jitter, from 0 up to 1. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/** This function gives the descriptor of the channel. */
export function meshDescriptor(options: Pick<MeshChannelOptions, "dependsOn"> = {}): ChannelDescriptor {
  return {
    id: MESH_CHANNEL,
    title: "Mesh siren",
    // The radio link is its own failure domain, outside each provider.
    dependsOn: options.dependsOn ?? [],
    uses: ["power"],
    // A siren sets its own loudness.
    breaksThrough: true,
    // The siren sounds until an ack, a cancel or the time expires.
    repeats: true,
    ack: "poll",
    // A frame holds no text of the message. A siren shows no text, and other persons can hear the radio channel.
    maxTitle: 0,
    maxBody: 0,
    address: MESH_ADDRESS,
  };
}

const isWholeAbove = (value: number, low: number): boolean => Number.isInteger(value) && value > low;

/**
 * This function gives the problems of the options of the channel. A problem names the option, and not a value.
 *
 * - The bed node and each ack node have the form of `MESH_NODE`.
 * - Each time is a whole number of milliseconds above 0, and the count of the stop frames is 1 or more.
 * - The backoff passes `backoffProblems` of `@mark1russell7/service/backoff`, and the channel has a level or more.
 */
export function meshProblems(options: MeshChannelOptions): string[] {
  const problems: string[] = [];
  if (!isNodeName(options.node)) problems.push("The option node is not small letters, digits and hyphens.");
  if (options.ackNodes !== undefined) {
    if (options.ackNodes.length === 0) problems.push("The option ackNodes is empty.");
    if (options.ackNodes.some((node) => !isNodeName(node))) problems.push("A node of the option ackNodes is not small letters, digits and hyphens.");
  }
  for (const [name, value] of Object.entries({ beatMs: options.beatMs, beatLimitMs: options.beatLimitMs, resendForMs: options.resendForMs })) {
    if (value !== undefined && !isWholeAbove(value, 0)) problems.push(`The option ${name} is not a whole number of milliseconds above 0.`);
  }
  if (options.stopCount !== undefined && !isWholeAbove(options.stopCount, 0)) problems.push("The option stopCount is not a whole number above 0.");
  if (options.levels?.length === 0) problems.push("The option levels is empty.");
  if (options.resend !== undefined) problems.push(...backoffProblems(options.resend).map((text) => `The option resend: ${text}`));
  return problems;
}

/**
 * This function gives the alarm id of a delivery key: its first `MESH_ID_CHARS` characters. A round above 0 comes after
 * a hyphen. A key is a SHA-256 in hexadecimal. Thus the chance that two live alarms have the same id is approximately 2
 * to the power of -64.
 *
 * The first alarm of a key has the same id after a restart, so the bed node keeps
 * one alarm. A later alarm of the same key has a new id, so the bed node sounds again. A key that is not of the form of
 * an id gives `undefined`.
 */
export function alarmIdOf(key: string, round = 0): string | undefined {
  if (!isAlarmId(key) || !(Number.isInteger(round) && round >= 0)) return undefined;
  const id = round === 0 ? key.slice(0, MESH_ID_CHARS) : `${key.slice(0, MESH_ID_CHARS)}-${String(round)}`;
  return isAlarmId(id) ? id : undefined;
}

/** The reason of the end of an alarm. */
type EndReason = "acknowledged" | "cancelled" | "expired" | "unanswered";

// One alarm of the channel: the sends of the frames of one delivery key.
interface Alarm {
  readonly id: string;
  readonly key: string;
  // The copies of the key that wait for the alarm. A cancel of the last copy stops the alarm.
  readonly copies: Set<string | undefined>;
  readonly level: Level;
  readonly expires: Instant | undefined;
  readonly started: Instant;
  readonly stop: AbortController;
  // The answer of the send that started the alarm. A send of the same key gives it again.
  first: Promise<SendOutcome>;
  // The count of the frames that the link took.
  sent: number;
  // The count of the frames, also the frames that failed. It is the sequence of the next frame.
  seq: number;
  // The message of the failure of the last frame, when it failed.
  failure: string | undefined;
  ended: EndReason | undefined;
  at: Instant;
}

// The receipt of a send: the delivery key and the alarm id.
const receiptOf = (alarm: Alarm): Receipt => ({ key: alarm.key, id: alarm.id });

/**
 * This function makes the procedures of the mesh channel.
 *
 * - `send` does not throw. It arms the id in the receiver, and it writes the first frame before its answer. A failed
 *   first write gives the kind `network`. A send of a key that is live joins its alarm. A send after the end of the
 *   alarm of its key starts an alarm with a new id (`alarmIdOf`).
 * - The other frames come after the answer, on the backoff `resend`. They stop at the ack, at a cancel, at the time
 *   `expires`, or after `resendForMs`.
 * - At each end other than the ack of the bed node, the channel writes `stopCount` stop frames on the same backoff.
 * - `status` gives `acknowledged` with `by` for an ack of an ack node, `expired` after `expires`, and `failed` after `resendForMs` with no ack.
 * - `cancel({ receipt })` stops the alarm of the key. `cancel({ copy })` takes one copy away, and the alarm stops with its last copy.
 * - `probe` fails with the kind `network` when the last heartbeat of the bed node is older than `beatLimitMs`.
 *
 * @throws Error when the options have a problem (`meshProblems`)
 */
export function meshChannel(options: MeshChannelOptions): ChannelProcedures {
  const problems = meshProblems(options);
  if (problems.length > 0) throw new Error(problems.join(" "));
  const clock = options.clock ?? wallClock({ unref: true });
  const random = options.random ?? Math.random;
  const resend = options.resend ?? MESH_RESEND;
  const resendFor = options.resendForMs ?? MESH_RESEND_FOR_MS;
  const stopCount = options.stopCount ?? MESH_STOP_COUNT;
  const beatLimit = options.beatLimitMs ?? MESH_BEAT_PERIODS * (options.beatMs ?? BED_BEAT_MS);
  const levels = new Set(options.levels ?? MESH_LEVELS);
  const ackNodes = new Set(options.ackNodes ?? [options.node]);
  const { link, receiver } = options;
  const descriptor = meshDescriptor(options);
  const alarms = new Map<string, Alarm>();
  // The ids of the ended alarms, the oldest first.
  const over: string[] = [];
  // The count of the alarms of each delivery key in this run. It gives the round of the next alarm of the key.
  const rounds = new Map<string, number>();

  /** The waits of the backoff end at the abort of the signal, and they do not throw. */
  const wait = (time: Duration, signal: AbortSignal): Promise<void> =>
    delay(clock, time, signal).then(
      () => undefined,
      () => undefined,
    );

  /** The first ack of an ack node for an alarm. */
  const ackOf = (id: string) => receiver.acksOf(id).find((ack) => ackNodes.has(ack.by));

  /** This function writes the stop frames of an id, on the backoff. It does not throw. */
  const stopFrames = async (id: string): Promise<void> => {
    const text = encodeFrame({ v: 1, kind: "stop", id });
    for (let index = 0; index < stopCount; index += 1) {
      if (index > 0) await wait(backoffDelay(resend, index, random), new AbortController().signal);
      await link.send(text, new AbortController().signal).catch(() => undefined);
    }
  };

  /** The alarm ends: no more alarm frames come. The channel keeps the last ended alarms for `status`. */
  const end = (alarm: Alarm, reason: EndReason): void => {
    if (alarm.ended !== undefined) return;
    alarm.ended = reason;
    alarm.at = clock.now();
    alarm.stop.abort();
    receiver.disarm(alarm.id);
    over.push(alarm.id);
    while (over.length > MESH_KEPT) {
      const oldest = over.shift();
      if (oldest !== undefined) alarms.delete(oldest);
    }
    // The bed node stops its siren at the push of its button. At each other end, the siren needs a stop frame.
    const ack = ackOf(alarm.id);
    if (!(reason === "acknowledged" && ack?.by === options.node)) void stopFrames(alarm.id);
  };

  /** This function writes one alarm frame. It does not throw. */
  const write = async (alarm: Alarm): Promise<boolean> => {
    const frame: AlarmFrame = { v: 1, kind: "alarm", id: alarm.id, level: alarm.level, seq: alarm.seq, ...(alarm.expires === undefined ? {} : { expires: alarm.expires }) };
    alarm.seq += 1;
    let outcome: LinkOutcome;
    try {
      outcome = await link.send(encodeFrame(frame), alarm.stop.signal);
    } catch (error) {
      outcome = { ok: false, message: `The mesh link threw: ${errorMessage(error)}` };
    }
    alarm.at = clock.now();
    if (outcome.ok) {
      alarm.sent += 1;
      alarm.failure = undefined;
    } else alarm.failure = outcome.message;
    return outcome.ok;
  };

  /** The reason to end an alarm at this time, or `undefined` while the alarm goes on. */
  const endOf = (alarm: Alarm): EndReason | undefined => {
    if (ackOf(alarm.id) !== undefined) return "acknowledged";
    const now = clock.now();
    if (alarm.expires !== undefined && alarm.expires <= now) return "expired";
    if (now - alarm.started >= resendFor) return "unanswered";
    return undefined;
  };

  /** The alarm frames after the first. */
  const rest = async (alarm: Alarm): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      // The wait ends at the time expires and at the end of the time of the sends. Thus the end comes at its time.
      const now = clock.now();
      const until = Math.min(alarm.expires ?? Number.POSITIVE_INFINITY, alarm.started + resendFor) - now;
      await wait(Math.max(0, Math.min(backoffDelay(resend, attempt, random), until)), alarm.stop.signal);
      if (alarm.ended !== undefined) return;
      const reason = endOf(alarm);
      if (reason !== undefined) {
        end(alarm, reason);
        return;
      }
      await write(alarm);
    }
  };

  /** The alarm of a receipt. A receipt of an earlier run of the system has no alarm. */
  const alarmOf = (receipt: Receipt): Alarm | undefined => {
    const alarm = alarms.get(receipt["id"] ?? "");
    return alarm !== undefined && alarm.key === receipt["key"] ? alarm : undefined;
  };

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that a copy id cannot have.` };
      if (message.expires !== undefined && message.expires <= clock.now()) return { ok: false, kind: "expired", message: "The message expired before the send." };
      if (message.quiet) return { ok: false, kind: "quiet", message: "The message is quiet, and a siren has no silent mode." };
      if (!levels.has(message.level)) return { ok: false, kind: "refused", message: `The channel sounds no siren at the level ${message.level}.` };
      const node = address["node"];
      if (node !== undefined && node !== options.node) return { ok: false, kind: "refused", message: "The address names a node that is not the bed node of the channel." };
      if (!isAlarmId(message.key)) return { ok: false, kind: "refused", message: "The delivery key is not letters, digits, underscores and hyphens." };
      const live = [...alarms.values()].find((alarm) => alarm.ended === undefined && alarm.key === message.key);
      if (live !== undefined) {
        live.copies.add(copy);
        return live.first;
      }
      const round = rounds.get(message.key) ?? 0;
      const id = alarmIdOf(message.key, round);
      if (id === undefined) return { ok: false, kind: "refused", message: "The delivery key gives no alarm id." };
      rounds.delete(message.key);
      rounds.set(message.key, round + 1);
      while (rounds.size > 4 * MESH_KEPT) {
        const [oldest] = rounds.keys();
        if (oldest !== undefined) rounds.delete(oldest);
      }
      const now = clock.now();
      const alarm: Alarm = {
        id,
        key: message.key,
        copies: new Set([copy]),
        level: message.level,
        expires: message.expires,
        started: now,
        stop: new AbortController(),
        first: Promise.resolve({ ok: false, kind: "refused", message: "The alarm did not start." }),
        sent: 0,
        seq: 0,
        failure: undefined,
        ended: undefined,
        at: now,
      };
      // An ended alarm with the same id leaves the list of the ended alarms, so the trim of the list keeps the new alarm.
      const index = over.indexOf(id);
      if (index >= 0) over.splice(index, 1);
      alarms.set(id, alarm);
      // The id is armed before the first frame. Thus an ack that comes at once counts.
      receiver.arm(id);
      alarm.first = (async (): Promise<SendOutcome> => {
        if (!(await write(alarm))) {
          alarms.delete(id);
          receiver.disarm(id);
          return { ok: false, kind: "network", message: `The mesh link did not take the alarm frame: ${alarm.failure ?? "no reason"}` };
        }
        void rest(alarm);
        return { ok: true, receipt: receiptOf(alarm), accepted: clock.now() };
      })();
      return alarm.first;
    },

    status({ receipt }): Promise<DeliveryStatus> {
      const id = receipt["id"] ?? "";
      const ack = isAlarmId(id) ? ackOf(id) : undefined;
      if (ack !== undefined) return Promise.resolve({ state: "acknowledged", at: ack.heard, by: ack.by, reason: "A person pushed the button of the node." });
      const alarm = alarmOf(receipt);
      if (alarm === undefined) return Promise.resolve({ state: "accepted", at: clock.now(), reason: "The channel does not keep this alarm. A restart of the system ends its frames." });
      const frames = `${String(alarm.sent)} alarm frames`;
      const reason = endOf(alarm) ?? alarm.ended;
      if (reason === "expired") return Promise.resolve({ state: "expired", at: alarm.expires ?? alarm.at, reason: `The alarm expired with no ack after ${frames}.` });
      if (reason === "unanswered") return Promise.resolve({ state: "failed", at: alarm.at, reason: `The alarm got no ack in its time, after ${frames}.` });
      if (reason === "cancelled") return Promise.resolve({ state: "accepted", at: alarm.at, reason: `A cancel stopped the alarm after ${frames}, with no ack.` });
      const failure = alarm.failure === undefined ? "" : ` The last frame failed: ${alarm.failure}`;
      return Promise.resolve({ state: "accepted", at: alarm.at, reason: `The channel wrote ${frames}, and it has no ack.${failure}` });
    },

    cancel(target): Promise<void> {
      for (const alarm of [...alarms.values()]) {
        if (alarm.ended !== undefined) continue;
        if ("copy" in target) {
          if (!alarm.copies.delete(target.copy) || alarm.copies.size > 0) continue;
        } else if (alarm.key !== target.receipt["key"]) continue;
        end(alarm, endOf(alarm) ?? "cancelled");
      }
      return Promise.resolve();
    },

    probe(): Promise<ProbeOutcome> {
      const beat = receiver.beatOf(options.node);
      const now = clock.now();
      if (beat === undefined) return Promise.resolve({ ok: false, kind: "network", message: "The receiver has no heartbeat of the bed node since its start." });
      const age = now - beat.heard;
      if (age > beatLimit) return Promise.resolve({ ok: false, kind: "network", message: `There is no heartbeat of the bed node in ${String(Math.round(age / 1000))} seconds. The limit is ${String(Math.round(beatLimit / 1000))} seconds.` });
      return Promise.resolve({ ok: true, at: now });
    },
  };
}
