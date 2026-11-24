/**
 * The sounder channel of the alert system. It makes a sound on a device in the home of the person. The device is the
 * speaker of a computer, a siren, or a radio node with a buzzer. The channel gives the procedures of the channel
 * contract of `@mark1russell7/alerts`: `describe`, `send`, `status`, `cancel` and `probe`.
 *
 * - The channel needs no phone, no push service and no internet link. Thus its failures are not those of a push.
 * - A sounder is the adapter of one device. The channel gives the pattern of the sounds: their count, and the wait between two.
 * - The first adapter is `commandSounder`. It starts a program for each sound, and the runner of the program is a parameter.
 * - A device shows no text. A sound tells the person to read the alert on another channel.
 * - A device has no silent mode. Thus the channel refuses a quiet message with the kind `quiet`.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  COPY_ID,
  LEVELS,
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

/** The id of the channel. */
export const SOUNDER_CHANNEL = "sounder" as ChannelId;

/**
 * The most sounds of one message at each level, when the options give no value. A message of the level `life-safety`
 * sounds for approximately 4 minutes, with a sound of 3 seconds.
 *
 * The channel has no acknowledgment, and a later rung of the escalation does not stop the sounds. A cancel of the
 * incident stops them, and so does the time `expires` of the message.
 */
export const SOUNDER_SOUNDS: Readonly<Record<Level, number>> = { "life-safety": 60, urgent: 3, notice: 1, digest: 1 };

/** The wait between two sounds of a message when the options give none, in milliseconds. */
export const SOUNDER_GAP_MS = 1000;

/** The most ended messages that the channel keeps for `status`. */
export const SOUNDER_KEPT = 64;

/** The time limit of one program of a command sounder when the options give none, in milliseconds. */
export const SOUNDER_COMMAND_LIMIT_MS = 5000;

/**
 * The form of the name of a device: small letters, digits and hyphens, 32 characters at most. The pattern has no nested
 * repeats, because the load of the configuration examines each address with it.
 */
export const SOUNDER_DEVICE: string = "[a-z0-9][a-z0-9-]{0,31}";

// The pattern of the name of a device, for one whole text.
const SOUNDER_DEVICE_EXACT = new RegExp(`^(?:${SOUNDER_DEVICE})$`, "u");

/**
 * The fields of the address of a person on the channel: the name of the device near the person. A system with one
 * sounder needs no name.
 */
export const SOUNDER_ADDRESS: readonly AddressField[] = [{ name: "device", required: false, pattern: SOUNDER_DEVICE, form: "the name of a sounder: small letters, digits and hyphens" }];

/** The kind of a failed sound. Each one is a kind of a failed send of the channel contract. */
export type SoundFailureKind = "network" | "timeout" | "server" | "refused";

/** The result of one sound, or of one check of a device. */
export type SoundOutcome = { readonly ok: true } | { readonly ok: false; readonly kind: SoundFailureKind; readonly message: string };

/** The input of one sound. */
export interface SoundInput {
  /** The level of the message. A sounder can have a different sound for each level. */
  readonly level: Level;
  /** The abort of this signal stops the sound. */
  readonly signal: AbortSignal;
}

/** The adapter of one device that makes a sound. */
export interface Sounder {
  /**
   * This function makes one sound, and it ends when the sound ends. It does not throw. Keep one sound shorter than
   * 5 seconds, because a send waits for the first sound.
   */
  sound(input: SoundInput): Promise<SoundOutcome>;
  /** This function examines the device, and it makes no sound. It does not throw. */
  probe?(): Promise<SoundOutcome>;
}

/** The facts of the sounders of a system, for the descriptor of the channel. */
export interface SounderFacts {
  /**
   * True: each sounder sets its own loudness, as a siren does. The speaker of a computer does not, because the person
   * can set its volume to zero. The default is false.
   */
  readonly breaksThrough?: boolean | undefined;
  /** The failure domains outside the cell that the sounders need, for example the radio link to a device. */
  readonly dependsOn?: readonly string[] | undefined;
}

/** The options of the sounder channel. */
export interface SounderChannelOptions {
  /** The sounders of the system, by the name of each device. */
  readonly sounders: Readonly<Record<string, Sounder>>;
  /** The facts of the sounders. */
  readonly facts?: SounderFacts | undefined;
  /** The most sounds of one message at a level. A level with no value has the value of `SOUNDER_SOUNDS`. A value of 0 refuses each message of the level. */
  readonly sounds?: Partial<Readonly<Record<Level, number>>> | undefined;
  /** The wait between two sounds of a message. The default is 1 second. */
  readonly gapMs?: Duration | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
  /** This function waits for a time. The abort of the signal ends the wait, and the function does not throw. A test gives a fake. */
  readonly wait?: ((time: Duration, signal: AbortSignal) => Promise<void>) | undefined;
}

/** This function gives the descriptor of the channel. */
export function sounderDescriptor(facts: SounderFacts = {}): ChannelDescriptor {
  return {
    id: SOUNDER_CHANNEL,
    title: "Sounder",
    // A device in the home needs no provider.
    dependsOn: facts.dependsOn ?? [],
    uses: ["power"],
    breaksThrough: facts.breaksThrough ?? false,
    // The channel makes the sounds of a message one after the other, until a stop or the last sound.
    repeats: true,
    ack: "none",
    // A device shows no text.
    maxTitle: 0,
    maxBody: 0,
    address: SOUNDER_ADDRESS,
  };
}

/**
 * This function gives the problems of the options of the channel. A problem names the option, and not a value of the
 * private configuration.
 *
 * - The channel has one sounder or more, and the name of each one has the form of `SOUNDER_DEVICE`.
 * - Each count of sounds is a whole number that is 0 or more.
 * - The wait between two sounds is a number that is 0 or more.
 */
export function sounderProblems(options: SounderChannelOptions): string[] {
  const problems: string[] = [];
  const names = Object.keys(options.sounders);
  if (names.length === 0) problems.push("The channel has no sounder.");
  const bad = names.filter((name) => !SOUNDER_DEVICE_EXACT.test(name)).length;
  if (bad > 0) problems.push(`The names of ${String(bad)} of ${String(names.length)} sounders are not small letters, digits and hyphens.`);
  for (const level of LEVELS) {
    const count = options.sounds?.[level];
    if (count !== undefined && !(Number.isInteger(count) && count >= 0)) problems.push(`The count of the sounds at the level ${level} is not a whole number that is 0 or more.`);
  }
  if (options.gapMs !== undefined && !(Number.isFinite(options.gapMs) && options.gapMs >= 0)) problems.push("The wait between two sounds is not a number that is 0 or more.");
  return problems;
}

// The sounds of one accepted send.
interface Play {
  readonly id: string;
  readonly key: string;
  readonly copy: string | undefined;
  // The name of the device of the sounds.
  readonly device: string;
  readonly stop: AbortController;
  readonly most: number;
  // The answer of the send that started the play. A send of the same message to the same device gives it again.
  first: Promise<SendOutcome>;
  // The sounds that ended with no failure.
  made: number;
  // The message of the failure of the last sound, when it failed.
  failure: string | undefined;
  // The value `true` tells that no more sounds come.
  ended: boolean;
  // The time of the last change.
  at: Instant;
}

// The default wait. The timer does not keep the process alive, because no caller waits for the sounds after the first.
const sleep = (time: Duration, signal: AbortSignal): Promise<void> =>
  delay(time, undefined, { signal, ref: false }).then(
    () => undefined,
    () => undefined,
  );

/**
 * This function makes the procedures of the sounder channel.
 *
 * - `send` does not throw. It makes the first sound before its answer. Thus an accepted send tells that the device made a sound.
 * - The other sounds of the message come after the answer, with a wait between two. A failed sound does not stop them.
 * - The sounds stop at a cancel, at the time `expires` of the message, or after the count of the level.
 * - One device makes one sound at a time. Thus the sounds of two messages on one device come in turns.
 * - A send of a message to a device that already plays it for the same copy joins that play. It makes no second play.
 * - `send` refuses a quiet message with the kind `quiet`, because a device has no silent mode.
 * - `cancel({ receipt })` stops each copy of the delivery key. `cancel({ copy })` stops one copy. A cancel is idempotent, and it does not throw.
 * - `status` gives `delivered` after a sound, and `failed` when the last sound failed. A restart of the system ends the sounds.
 * - `probe` examines each sounder that has a probe. The channel has no `probe` when no sounder has one.
 *
 * @throws Error when the options have a problem (`sounderProblems`)
 */
export function createSounderChannel(options: SounderChannelOptions): ChannelProcedures {
  const problems = sounderProblems(options);
  if (problems.length > 0) throw new Error(problems.join(" "));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const gap = options.gapMs ?? SOUNDER_GAP_MS;
  const descriptor = sounderDescriptor(options.facts);
  const sounders = new Map(Object.entries(options.sounders));
  const plays = new Map<string, Play>();
  // The ids of the ended plays, the oldest first.
  const over: string[] = [];
  // The end of the last sound of each device. The next sound of the device starts after it.
  const lines = new Map<string, Promise<void>>();
  let count = 0;

  /** The sounder of an address and its name, or the text of a refusal. */
  const sounderOf = (device: string | undefined): { readonly name: string; readonly sounder: Sounder } | string => {
    if (device === undefined) {
      const [only, ...others] = [...sounders];
      if (only === undefined || others.length > 0) return "The address names no device, and the channel has more than one sounder.";
      return { name: only[0], sounder: only[1] };
    }
    const sounder = sounders.get(device);
    return sounder === undefined ? "The channel has no sounder with the name of the address." : { name: device, sounder };
  };

  /** One sound of a play, after the sounds of its device that came before. A stopped play makes no sound. */
  const turn = (play: Play, device: string, sounder: Sounder, level: Level): Promise<SoundOutcome> => {
    const sound = async (): Promise<SoundOutcome> => {
      if (play.stop.signal.aborted) return { ok: true };
      try {
        return await sounder.sound({ level, signal: play.stop.signal });
      } catch {
        return { ok: false, kind: "server", message: "The sounder threw." };
      }
    };
    const next = (lines.get(device) ?? Promise.resolve()).then(sound);
    lines.set(
      device,
      next.then(() => undefined),
    );
    return next;
  };

  /** The channel keeps the result of one sound. A stopped sound is not a failure. */
  const note = (play: Play, outcome: SoundOutcome): void => {
    if (play.stop.signal.aborted) return;
    if (outcome.ok) play.made += 1;
    play.failure = outcome.ok ? undefined : outcome.message;
    play.at = now();
  };

  /** No more sounds of the play come. The channel keeps the last ended plays for `status`. */
  const end = (play: Play): void => {
    if (play.ended) return;
    play.ended = true;
    play.at = now();
    over.push(play.id);
    while (over.length > SOUNDER_KEPT) {
      const oldest = over.shift();
      if (oldest !== undefined) plays.delete(oldest);
    }
  };

  /** The sounds of a play after the first. */
  const rest = async (play: Play, device: string, sounder: Sounder, level: Level, expires: Instant | undefined): Promise<void> => {
    for (let index = 1; index < play.most; index += 1) {
      await wait(gap, play.stop.signal);
      if (play.stop.signal.aborted || (expires !== undefined && expires <= now())) break;
      note(play, await turn(play, device, sounder, level));
    }
    end(play);
  };

  /** The play of a receipt. A receipt of an earlier run of the system has no play. */
  const playOf = (receipt: Receipt): Play | undefined => {
    const play = plays.get(receipt["play"] ?? "");
    return play !== undefined && play.key === receipt["key"] ? play : undefined;
  };

  const probed = [...sounders].flatMap(([name, sounder]) => (sounder.probe === undefined ? [] : [{ name, probe: () => sounder.probe?.() }]));

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that a copy id cannot have.` };
      if (message.expires !== undefined && message.expires <= now()) return { ok: false, kind: "expired", message: "The message expired before the send." };
      if (message.quiet) return { ok: false, kind: "quiet", message: "The message is quiet, and a sounder has no silent mode." };
      const found = sounderOf(address["device"]);
      if (typeof found === "string") return { ok: false, kind: "refused", message: found };
      const most = options.sounds?.[message.level] ?? SOUNDER_SOUNDS[message.level];
      if (most === 0) return { ok: false, kind: "refused", message: `The channel makes no sound at the level ${message.level}.` };
      // An escalation can send one message to two persons near one device. The second send joins the play of the first,
      // and it does not wait in the line of the device behind the first sound.
      const live = [...plays.values()].find((play) => !play.ended && play.key === message.key && play.device === found.name && play.copy === copy);
      if (live !== undefined) return live.first;
      count += 1;
      const play: Play = {
        id: String(count),
        key: message.key,
        copy,
        device: found.name,
        stop: new AbortController(),
        most,
        first: Promise.resolve({ ok: false, kind: "refused", message: "The play did not start." }),
        made: 0,
        failure: undefined,
        ended: false,
        at: now(),
      };
      plays.set(play.id, play);
      play.first = (async (): Promise<SendOutcome> => {
        const first = await turn(play, found.name, found.sounder, message.level);
        // A stop during the first sound is not a failure: the device started the sound.
        if (!first.ok && !play.stop.signal.aborted) {
          plays.delete(play.id);
          return { ok: false, kind: first.kind, message: first.message };
        }
        note(play, first);
        if (play.stop.signal.aborted) end(play);
        else void rest(play, found.name, found.sounder, message.level, message.expires);
        return { ok: true, receipt: { key: message.key, device: found.name, play: play.id }, accepted: now() };
      })();
      return play.first;
    },

    status({ receipt }): Promise<DeliveryStatus> {
      const play = playOf(receipt);
      if (play === undefined) return Promise.resolve({ state: "accepted", at: now(), reason: "The channel does not keep this message. A restart of the system ends its sounds." });
      const sounds = `${String(play.made)} of ${String(play.most)} sounds`;
      if (play.failure !== undefined) return Promise.resolve({ state: "failed", at: play.at, reason: `The last sound failed after ${sounds}: ${play.failure}` });
      // A cancel during the first sound stops the play before one sound ends. Thus no sound is sure.
      if (play.made === 0) return Promise.resolve({ state: "accepted", at: play.at, reason: "A cancel stopped the play before the end of the first sound." });
      return Promise.resolve({ state: "delivered", at: play.at, reason: play.ended ? `The sounds ended: ${sounds}.` : `The device made ${sounds}.` });
    },

    cancel(target): Promise<void> {
      for (const play of [...plays.values()]) {
        if (play.ended || ("copy" in target ? play.copy !== target.copy : play.key !== target.receipt["key"])) continue;
        end(play);
        play.stop.abort();
      }
      return Promise.resolve();
    },

    ...(probed.length === 0
      ? {}
      : {
          async probe(): Promise<ProbeOutcome> {
            for (const { name, probe } of probed) {
              let outcome: SoundOutcome | undefined;
              try {
                outcome = await probe();
              } catch {
                outcome = { ok: false, kind: "server", message: "The probe threw." };
              }
              if (outcome !== undefined && !outcome.ok) return { ok: false, kind: outcome.kind, message: `The sounder ${name}: ${outcome.message}` };
            }
            return { ok: true, at: now() };
          },
        }),
  };
}

/** The output of one command. A runner does not throw. */
export interface CommandOutput {
  readonly exitCode: number;
  /** The value `true` tells that the time limit stopped the command. */
  readonly timedOut?: boolean;
  /** The value `true` tells that the program did not start. */
  readonly notStarted?: boolean;
}

/**
 * This function starts the program of `argv` with its arguments, with no shell. It stops the program at the abort of the
 * signal, or after the time `limit`. A test gives a fake.
 */
export type CommandRunner = (argv: readonly string[], signal: AbortSignal, limit: Duration) => Promise<CommandOutput>;

/** The options of a command sounder. */
export interface CommandSounderOptions {
  /** The program of one sound and its arguments. The program ends when the sound ends. */
  readonly sound: readonly string[];
  /** The program of the sound of a level, for a level with a sound of its own. */
  readonly levels?: Partial<Readonly<Record<Level, readonly string[]>>> | undefined;
  /** The program that examines the device with no sound. An exit code of 0 is a pass. Without it, the sounder has no probe. */
  readonly probe?: readonly string[] | undefined;
  /** The runner of each program. */
  readonly run: CommandRunner;
  /** The time limit of one program. The default is 5 seconds. */
  readonly limitMs?: Duration | undefined;
}

/**
 * This function gives the result of the output of a program. A message holds no argument of the program, because an
 * argument can be a path of the private configuration.
 *
 * - A program that did not start gives `refused`, and a program that passed its time limit gives `timeout`.
 * - An exit code other than 0 gives `server`.
 */
export function commandOutcome(output: CommandOutput): SoundOutcome {
  if (output.notStarted === true) return { ok: false, kind: "refused", message: "The program did not start." };
  if (output.timedOut === true) return { ok: false, kind: "timeout", message: "The program did not end in its time limit." };
  if (output.exitCode !== 0) return { ok: false, kind: "server", message: `The program ended with the exit code ${String(output.exitCode)}.` };
  return { ok: true };
}

/**
 * This function makes a sounder that starts a program for each sound. The program is an argument list, thus no shell
 * reads it. It serves the speaker of a computer, and each device with a command-line tool.
 *
 * - A level with a program in `levels` has its own sound. Each other level has the program `sound`.
 * - An empty argument list gives `refused`, and a runner that throws gives `server`.
 */
export function commandSounder(options: CommandSounderOptions): Sounder {
  const limit = options.limitMs ?? SOUNDER_COMMAND_LIMIT_MS;
  const run = async (argv: readonly string[], signal: AbortSignal): Promise<SoundOutcome> => {
    if (argv.length === 0) return { ok: false, kind: "refused", message: "The command has no program." };
    try {
      return commandOutcome(await options.run(argv, signal, limit));
    } catch {
      return { ok: false, kind: "server", message: "The runner of the program threw." };
    }
  };
  const probe = options.probe;
  return {
    sound: ({ level, signal }) => run(options.levels?.[level] ?? options.sound, signal),
    ...(probe === undefined ? {} : { probe: () => run(probe, new AbortController().signal) }),
  };
}
