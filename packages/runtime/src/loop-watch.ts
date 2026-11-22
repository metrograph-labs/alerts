/**
 * This module holds the watch of the event loop of the runtime (AL-88). It reads the spans of a watch of
 * `@mark1russell7/lag/node`, and it keeps each block of `LOOP_BLOCK_LIMIT` or longer for `LOOP_BLOCK_WINDOW`. Each pass
 * writes the new blocks into the log, and the system report of the blocks reads the log.
 */
import { blockSizeText, LOOP_BLOCK_LIMIT, LOOP_BLOCK_WINDOW, type Duration, type Instant, type LoopBlock } from "@mark1russell7/alerts";
import type { LoopSpan } from "@mark1russell7/lag/node";
import { envelope, type LoopEvent } from "./events.ts";

/** The time between two reads of the watch. A block shows at the first read after its end. */
export const LOOP_READ_EVERY: Duration = 5_000;

/** The part of a watch of `@mark1russell7/lag/node` that the loop watch reads. */
export interface SpanWatch {
  span(): Pick<LoopSpan, "blocks">;
  stop(): void;
}

/** The options of `startLoopWatch()`. */
export interface LoopWatchOptions {
  readonly watch: SpanWatch;
  /** The clock of the times of the blocks of the watch: `performance.now()` for `watchEventLoop()`. */
  readonly mono: () => number;
  /** The wall clock of the runtime. */
  readonly wall: () => Instant;
  /** This function gets each new block, after its end. */
  readonly onBlock?: (block: LoopBlock) => void;
  /** The time between two reads. The default is `LOOP_READ_EVERY`. */
  readonly every?: Duration;
  /** The timer of the reads. The default is `setInterval` of Node.js with `unref`, thus the timer does not keep the process alive. */
  readonly repeat?: (handler: () => void, ms: Duration) => () => void;
}

/** A running watch of the event loop. */
export interface LoopWatch {
  /** This function reads the watch at once, and gives the new blocks. A read after `stop()` gives no block. */
  read(): readonly LoopBlock[];
  /** This function gives the blocks of `LOOP_BLOCK_WINDOW` before the time of the call, in their order. */
  blocks(): readonly LoopBlock[];
  /** This function stops the timer and the watch. A second call does nothing. */
  stop(): void;
}

const nodeRepeat = (handler: () => void, ms: Duration): (() => void) => {
  const timer = setInterval(handler, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * This function starts the reads of a watch of the event loop. Each read changes the start of each block of
 * `LOOP_BLOCK_LIMIT` or longer to the wall clock, and it gives the block to `onBlock`.
 */
export function startLoopWatch(options: LoopWatchOptions): LoopWatch {
  let kept: readonly LoopBlock[] = [];
  let stopped = false;
  const read = (): readonly LoopBlock[] => {
    if (stopped) return [];
    const { blocks } = options.watch.span();
    const mono = options.mono();
    const wall = options.wall();
    const found = blocks
      .filter((block) => block.durationMs >= LOOP_BLOCK_LIMIT)
      .map((block) => ({ at: Math.round(wall - (mono - block.startedAt)), size: Math.round(block.durationMs) }));
    kept = [...kept.filter((block) => wall - block.at < LOOP_BLOCK_WINDOW), ...found];
    for (const block of found) options.onBlock?.(block);
    return found;
  };
  // A throw in a timer stops the process. Thus a fault of a read stops only that read, and the next read tries again.
  const cancel = (options.repeat ?? nodeRepeat)(() => {
    try {
      read();
    } catch {
      return;
    }
  }, options.every ?? LOOP_READ_EVERY);
  return {
    read,
    blocks: () => {
      const wall = options.wall();
      return kept.filter((block) => block.at <= wall && wall - block.at < LOOP_BLOCK_WINDOW);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel();
      options.watch.stop();
    },
  };
}

/**
 * This function gives the event of a block in the log. The id has the run, the start and the length of the block. The watch
 * of a run gives the same start for a block at each read, also after a step of the wall clock. Thus a block goes into the
 * log one time.
 */
export function blockEvent(block: LoopBlock, run: string): LoopEvent {
  return { ...envelope("loop", `loop:${run}:${String(block.at)}:${String(block.size)}`, block.at), size: block.size };
}

/** This function gives the line of the output for a block. */
export function blockLine(block: LoopBlock): string {
  return `The event loop of the runtime was blocked for ${blockSizeText(block.size)} from ${new Date(block.at).toISOString()}.`;
}
