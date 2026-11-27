/**
 * The command link of the mesh channel (AL-41-wire). It connects the channel to the home node through two programs.
 *
 * - The program `send` gets the text of one frame as its last argument. It ends when the home node has the frame.
 * - The program `listen` operates until the link stops it. It writes each frame that the home node hears on one line.
 * - The link starts each program with no shell. A test gives a fake runner and a fake reader.
 * - A message of a failure names no program and no argument. The values of the programs are private.
 *
 * Thus the channel knows no radio. The two programs are the adapter of the radio of the home node.
 */

import type { Duration } from "@mark1russell7/alerts";
import type { LinkOutcome, MeshLink } from "./receiver.ts";

/** The result of one start of the program `send`. */
export interface LinkCommandOutput {
  readonly exitCode: number;
  /** The value `true` tells that the time limit stopped the program. */
  readonly timedOut?: boolean | undefined;
  /** The value `true` tells that the program did not start. */
  readonly notStarted?: boolean | undefined;
}

/** This function starts the program of `argv` with no shell, and it stops the program at the abort or after `limit`. */
export type LinkRunner = (argv: readonly string[], signal: AbortSignal, limit: Duration) => Promise<LinkCommandOutput>;

/**
 * This function starts the program of `argv` with no shell, and it gives each line of its output. The lines end when the
 * program ends. The abort stops the program.
 */
export type LineReader = (argv: readonly string[], signal: AbortSignal) => AsyncIterable<string>;

/** The time limit of one start of the program `send`, in milliseconds. */
export const LINK_SEND_LIMIT_MS: Duration = 10_000;

/** The options of a command link. */
export interface CommandLinkOptions {
  /** The program that writes one frame to the home node, and its arguments. The link adds the frame as the last argument. */
  readonly send: readonly string[];
  /** The program that writes each frame of the home node on one line, and its arguments. */
  readonly listen: readonly string[];
  /** The runner of the program `send`. */
  readonly run: LinkRunner;
  /** The reader of the lines of the program `listen`. */
  readonly read: LineReader;
  /** The time limit of one start of the program `send`. The default is `LINK_SEND_LIMIT_MS`. */
  readonly sendLimitMs?: Duration | undefined;
}

/** This function gives the problems of the options of a command link. An empty list tells that `commandLink` can make the link. */
export function commandLinkProblems(options: Pick<CommandLinkOptions, "send" | "listen" | "sendLimitMs">): string[] {
  const problems: string[] = [];
  for (const [name, argv] of [["send", options.send], ["listen", options.listen]] as const) {
    if (argv.length === 0) problems.push(`The program ${name} of the mesh link names no program.`);
    else if (argv.some((arg) => arg.length === 0)) problems.push(`The program ${name} of the mesh link has an empty argument.`);
  }
  const limit = options.sendLimitMs;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) problems.push("The time limit of the program send of the mesh link is not a whole count of milliseconds above 0.");
  return problems;
}

/**
 * This function makes a link that writes each frame with the program `send` and reads the frames of the program `listen`.
 *
 * - A send passes only when the program exits with the code 0.
 * - The link removes the end `\r` of each line, and it gives no empty line.
 *
 * @throws RangeError when `commandLinkProblems` gives a problem
 */
export function commandLink(options: CommandLinkOptions): MeshLink {
  const problems = commandLinkProblems(options);
  if (problems.length > 0) throw new RangeError(problems.join(" "));
  const limit = options.sendLimitMs ?? LINK_SEND_LIMIT_MS;
  return {
    async send(text: string, signal: AbortSignal): Promise<LinkOutcome> {
      try {
        const output = await options.run([...options.send, text], signal, limit);
        if (output.notStarted === true) return { ok: false, message: "The program send of the mesh link did not start." };
        if (output.timedOut === true) return { ok: false, message: "The program send of the mesh link passed its time limit." };
        if (output.exitCode !== 0) return { ok: false, message: `The program send of the mesh link exited with the code ${String(output.exitCode)}.` };
        return { ok: true };
      } catch {
        return { ok: false, message: "The program send of the mesh link failed." };
      }
    },
    async *receive(signal: AbortSignal): AsyncIterable<string> {
      for await (const line of options.read(options.listen, signal)) {
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (text.length > 0) yield text;
      }
    },
  };
}
