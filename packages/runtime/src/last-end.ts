/**
 * This module holds the report of the end of the last run of the runtime (AL-222). A child that stops in a block, for example
 * at a liveness stop, writes no cause. The host of a copy can be too small for a read over ssh. Thus each start reads the
 * end of the log of the program. It tells the facts in one line and in the answer of the exchange.
 *
 * - The supervisor writes the output of each run to the log of the program (`programLogPath()`). A start reads the end of that
 *   file before it writes its first line. Thus the end of the file is the end of the run before it.
 * - The watch of long blocks (AL-119, `block-watch.ts`) writes a line during a block. The worker of that watch writes no other line.
 * - A later line of the runtime that is not a line of the watch tells that the event loop ran again. The end line of a block
 *   (AL-88, `loop-watch.ts`) is one such line. Thus a line of the watch with no later line of the runtime is a block that did not end.
 */
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { blockSizeText, LAST_LINE_LIMIT, type Duration, type Instant, type LastEnd, type LastEndReport } from "@mark1russell7/alerts";
import { truncate } from "@mark1russell7/text/length";
import { hostFolder, RUNTIME_PROGRAM } from "./host.ts";

/** The most bytes of the end of the log that a start reads. */
export const LAST_END_BYTES: number = 64 * 1024;

/** This function gives the path of the log of the program of the runtime: the default log of a program of `@mark1russell7/service`. */
export const programLogPath = (home: string): string => join(hostFolder(home), "logs", `${RUNTIME_PROGRAM}.log`);

/** The end of a log file: its text, and the value that tells if the read started after the start of the file. */
export interface LogTail {
  readonly text: string;
  /** This value is `true` when the read started after the start of the file. Then the first line of the text can be a part of a line. */
  readonly cut: boolean;
}

// A line with a time: the time of the wall clock in the format of `Date.prototype.toISOString`, a space and the message.
const TIMED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/su;

// The message of a line of the watch of long blocks: the size, the start and the phase (`blockWatchLine()` of `block-watch.ts`).
const CONTINUES = /^The event loop of the runtime is blocked for (\d+(?:\.\d+)?) s from (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z), in the phase "(.*)"\. The block continues\./su;

// This function gives the time of a text in the format of `Date.prototype.toISOString`, or `undefined` for a bad time.
const instantOf = (text: string): Instant | undefined => {
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
};

/** This function gives the block of a message of the watch of long blocks, or `undefined` for each other message. */
function blockOf(message: string): LastEnd["block"] | undefined {
  const match = CONTINUES.exec(message);
  if (match === null) return undefined;
  const [, seconds = "", from = "", phase = ""] = match;
  const at = instantOf(from);
  if (at === undefined || phase === "") return undefined;
  const size: Duration = Math.round(Number(seconds) * 1000);
  return { at, size, phase: truncate(phase, LAST_LINE_LIMIT) };
}

/** The facts of a log with no line. */
const NO_END: LastEnd = { lastLineAt: null, block: null, lastLine: null };

/** This function gives one line of a log as text of one line: each run of control characters becomes one space. */
const plainLine = (line: string): string => line.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();

/** The options of `lastEndOf()`. */
export interface LastEndOptions {
  /** This value is `true` when the text can start with a part of a line. Then the function ignores the text up to the first line break. */
  readonly cut?: boolean;
  /**
   * The start of the current run. A line with this time or a later time is a line of the current run.
   * The function ignores that line and each line without a time after it.
   */
  readonly before?: Instant;
}

/**
 * This function gives the facts about the end of a run from the end of the log of its output. It is pure.
 *
 * - `lastLineAt` is the time of the last line that has a time. A line of a message with more lines has no time.
 * - `block` is the last line of the watch of long blocks, when no later line with a time is a line of the runtime.
 * - `lastLine` is the last line that is not empty, with no control character, at most `LAST_LINE_LIMIT` characters.
 */
export function lastEndOf(text: string, options: LastEndOptions = {}): LastEnd {
  const start = options.cut === true ? text.indexOf("\n") : -1;
  if (options.cut === true && start === -1) return NO_END;
  let lastLineAt: Instant | null = null;
  let block: LastEnd["block"] = null;
  let lastLine: string | null = null;
  for (const raw of text.slice(start + 1).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const timed = TIMED.exec(line);
    const at = timed === null ? undefined : instantOf(timed[1] ?? "");
    // The first line of the current run ends the lines of the last run.
    if (at !== undefined && options.before !== undefined && at >= options.before) break;
    const plain = plainLine(line);
    if (plain !== "") lastLine = plain;
    if (timed === null || at === undefined) continue;
    lastLineAt = at;
    // Each line with a time that is not a line of the watch ends the block before it.
    block = blockOf(timed[2] ?? "") ?? null;
  }
  return { lastLineAt, block, lastLine: lastLine === null ? null : truncate(lastLine, LAST_LINE_LIMIT) };
}

/**
 * This function reads the end of a file: at most `bytes` bytes. It opens the file to read only, and it closes the file. A file
 * that is not there gives `null`. Each other fault of the read throws.
 */
export async function readLogTail(path: string, bytes: number = LAST_END_BYTES): Promise<LogTail | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), cut: size > length };
  } finally {
    await handle.close();
  }
}

/** This function gives the facts about the end of the last run from a tail of its log. A missing log gives no facts. */
export const lastEndOfTail = (tail: LogTail | null, before?: Instant): LastEnd =>
  tail === null ? NO_END : lastEndOf(tail.text, { cut: tail.cut, ...(before === undefined ? {} : { before }) });

/** This function gives the line of the output with the facts about the end of the last run. The line holds the last line of that run as it is. */
export function lastEndText(end: LastEnd): string {
  if (end.lastLine === null && end.lastLineAt === null) return "The last run: its log has no line.";
  const parts = [`The last run: its last line with a time came at ${end.lastLineAt === null ? "no time" : new Date(end.lastLineAt).toISOString()}.`];
  parts.push(
    end.block === null
      ? "No block of the event loop continued at its end."
      : `A block of the event loop of ${blockSizeText(end.block.size)} or more from ${new Date(end.block.at).toISOString()} continued at its end, in the phase "${end.block.phase}".`,
  );
  if (end.lastLine !== null) parts.push(`Its last line: ${end.lastLine}`);
  return parts.join(" ");
}

/** This function gives the report of a start for the answer of the exchange. The report holds the time of the start and the facts about the last run. */
export const lastEndReport = (startedAt: Instant, end: LastEnd): LastEndReport => ({ startedAt, ...end });
