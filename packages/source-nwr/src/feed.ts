/**
 * The feed of the lines of the decoder. The process of the decoder adds each line that it writes, and each fetch
 * reads the lines after its position. The feed is pure state with no clock and no I/O.
 */

import type { Instant } from "@mark1russell7/alerts";

/** One line of the feed. */
export interface FeedLine {
  /** The sequence number of the line in this feed. The first line has the number 1. */
  readonly seq: number;
  /** The time at which the feed got the line. */
  readonly at: Instant;
  readonly text: string;
}

/** The result of a read of the feed. */
export interface FeedRead {
  /** The lines after the position of the read, oldest first. */
  readonly lines: readonly FeedLine[];
  /** The sequence number of the newest line. It is 0 for an empty feed. */
  readonly last: number;
  /** True: the feed removed one or more lines after the position of the read. */
  readonly lost: boolean;
}

/** The feed of the lines of the decoder. */
export interface DecoderFeed {
  /** This method gives the lines after the sequence number `after`. */
  read(after: number): FeedRead;
  /** This method gives the time at which the decoder started, or `undefined` when the decoder is stopped. */
  started(): Instant | undefined;
}

/** A feed that a process of the decoder fills. */
export interface LineFeed extends DecoderFeed {
  /** This method adds one line. */
  add(text: string, at: Instant): void;
  /** This method records the start of the decoder. */
  start(at: Instant): void;
  /** This method records the stop of the decoder. */
  stop(): void;
}

/**
 * This function makes an empty feed. When the feed has `capacity` lines, a new line removes the oldest one. A read
 * from a position before the oldest line then tells the loss.
 */
export function createLineFeed(capacity: number): LineFeed {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`The capacity of the feed is ${String(capacity)}: it must be a positive integer.`);
  const ring: FeedLine[] = [];
  let next = 1;
  let since: Instant | undefined;
  return {
    add(text, at) {
      ring.push({ seq: next, at, text });
      next += 1;
      if (ring.length > capacity) ring.shift();
    },
    start(at) {
      since = at;
    },
    stop() {
      since = undefined;
    },
    read(after) {
      const lines = ring.filter((line) => line.seq > after);
      const oldest = ring[0];
      return { lines, last: next - 1, lost: oldest !== undefined && oldest.seq > after + 1 };
    },
    started: () => since,
  };
}
