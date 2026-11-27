/**
 * The receiver of the mesh channel. It reads the frames that come from the home node, and it keeps the acks and the
 * heartbeats that the channel reads.
 *
 * - A frame that comes again changes nothing. A mesh can give one frame two times.
 * - An ack for an id that is not armed acks nothing. Thus an old ack does not ack a new alarm.
 * - The time of an ack and of a beat is the time when the receiver got it, on the clock of the home. A node clock can be wrong.
 * - `runMeshReceiver` is the read loop as a plain function. `meshReceiverWorker` is the same loop as a worker of `@mark1russell7/service`.
 */

import type { Duration, Instant } from "@mark1russell7/alerts";
import type { Cancel, Clock, WallClock } from "@mark1russell7/algebra/clock";
import { workerLoop, type WorkerLoop } from "@mark1russell7/service";
import { decodeFrame } from "./protocol.ts";

/** The result of one write of a text to the mesh. */
export type LinkOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The link to the home node: for example the serial port of a Meshtastic node, or a fake in a test.
 *
 * - `send` writes one text to the channel of the mesh. It does not throw.
 * - `receive` gives each text that comes from the mesh, until the abort of the signal. The link keeps the texts that
 *   come between two reads, because the worker starts a new read in each iteration.
 */
export interface MeshLink {
  send(text: string, signal: AbortSignal): Promise<LinkOutcome>;
  receive(signal: AbortSignal): AsyncIterable<string>;
}

/** One ack that the receiver keeps. */
export interface MeshAck {
  readonly id: string;
  /** The node of the button. */
  readonly by: string;
  /** The time of the push on the clock of the node. */
  readonly at: Instant;
  /** The time when the receiver got the ack, on the clock of the home. */
  readonly heard: Instant;
}

/** The last beat of one node. */
export interface NodeBeat {
  readonly node: string;
  readonly seq: number;
  /** The time of the beat on the clock of the node. */
  readonly at: Instant;
  /** The time when the receiver got the beat, on the clock of the home. */
  readonly heard: Instant;
}

/**
 * The result of one text:
 *
 * - `ack`: a new ack for an armed id. `beat`: a new beat.
 * - `duplicate`: the receiver has this ack or this beat already.
 * - `stray`: an ack for an id that is not armed.
 * - `ignored`: a valid frame that the home does not read, as an alarm or a stop.
 * - `rejected`: the text is not a valid frame (`decodeFrame`).
 */
export type TakeResult = "ack" | "beat" | "duplicate" | "stray" | "ignored" | "rejected";

/** The counts of the texts of a receiver, by their result. */
export type ReceiverCounts = Readonly<Record<TakeResult, number>>;

/** The receiver of the mesh channel. */
export interface MeshReceiver {
  /** This method reads one text from the mesh. It does not throw. */
  take(text: string): TakeResult;
  /** This method arms an id. After it, an ack for the id counts. The channel arms each alarm before its first frame. */
  arm(id: string): void;
  /** This method disarms an id. After it, an ack for the id is `stray`. The acks that the receiver has stay. */
  disarm(id: string): void;
  /** This method tells if an id is armed. */
  armed(id: string): boolean;
  /** This method gives the acks of an id, one for each node, in the order that they came. */
  acksOf(id: string): readonly MeshAck[];
  /** This method gives the last beat of a node, or `undefined` before the first beat. */
  beatOf(node: string): NodeBeat | undefined;
  /** This method gives the counts of the texts by their result. */
  counts(): ReceiverCounts;
}

/** The options of a receiver. */
export interface MeshReceiverOptions {
  /** The clock of the home. The receiver reads only its time. */
  readonly clock: Pick<WallClock, "now">;
}

/** The most disarmed ids whose acks the receiver keeps. */
export const RECEIVER_KEPT = 64;

/** The most beats of one node that the receiver keeps to find a beat that comes again. */
export const RECEIVER_BEATS_KEPT = 32;

/** This function makes a receiver. */
export function meshReceiver(options: MeshReceiverOptions): MeshReceiver {
  const armed = new Set<string>();
  const acks = new Map<string, MeshAck[]>();
  // The disarmed ids with acks, the oldest first.
  const over: string[] = [];
  const beats = new Map<string, NodeBeat>();
  // The recent beats of each node, as `seq:at`. A reboot of a node starts its sequence at 0 again, with a new time.
  const recent = new Map<string, string[]>();
  const counts: Record<TakeResult, number> = { ack: 0, beat: 0, duplicate: 0, stray: 0, ignored: 0, rejected: 0 };

  const result = (value: TakeResult): TakeResult => {
    counts[value] += 1;
    return value;
  };

  const take = (text: string): TakeResult => {
    const read = decodeFrame(text);
    if (read.tag === "err") return result("rejected");
    const frame = read.value;
    if (frame.kind === "ack") {
      const list = acks.get(frame.id) ?? [];
      if (list.some((ack) => ack.by === frame.by)) return result("duplicate");
      if (!armed.has(frame.id)) return result("stray");
      list.push({ id: frame.id, by: frame.by, at: frame.at, heard: options.clock.now() });
      acks.set(frame.id, list);
      return result("ack");
    }
    if (frame.kind === "beat") {
      const mark = `${String(frame.seq)}:${String(frame.at)}`;
      const seen = recent.get(frame.node) ?? [];
      if (seen.includes(mark)) return result("duplicate");
      seen.push(mark);
      if (seen.length > RECEIVER_BEATS_KEPT) seen.shift();
      recent.set(frame.node, seen);
      beats.set(frame.node, { node: frame.node, seq: frame.seq, at: frame.at, heard: options.clock.now() });
      return result("beat");
    }
    return result("ignored");
  };

  return {
    take,
    arm: (id) => {
      armed.add(id);
      const index = over.indexOf(id);
      if (index >= 0) over.splice(index, 1);
    },
    disarm: (id) => {
      if (!armed.delete(id)) return;
      if (!acks.has(id)) return;
      over.push(id);
      while (over.length > RECEIVER_KEPT) {
        const oldest = over.shift();
        if (oldest !== undefined) acks.delete(oldest);
      }
    },
    armed: (id) => armed.has(id),
    acksOf: (id) => [...(acks.get(id) ?? [])],
    beatOf: (node) => beats.get(node),
    counts: () => ({ ...counts }),
  };
}

/**
 * This function reads the texts of the link into the receiver until the abort of the signal or the end of the texts.
 * It ends with no throw at the abort. A failure of the link throws.
 */
export async function runMeshReceiver(receiver: MeshReceiver, link: MeshLink, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  for await (const text of link.receive(signal)) {
    if (signal.aborted) return;
    receiver.take(text);
  }
}

/** The options of the worker of a receiver. */
export interface MeshReceiverWorkerOptions {
  readonly receiver: MeshReceiver;
  readonly link: MeshLink;
  /** The monotonic clock of the service. The reads, the sleeps and the backoffs use it. */
  readonly clock: Clock;
  /** The time of one read. After it, the iteration ends and the next read starts. The default is 1 minute. */
  readonly readMs?: Duration | undefined;
  /** The wait after the first failed read. The wait doubles after each failure in sequence. The default is 5 seconds. */
  readonly retryBase?: Duration | undefined;
  /** The longest wait after a failed read. The default is 5 minutes. */
  readonly retryCap?: Duration | undefined;
  /** This function gives the random numbers of the jitter of the backoff, from 0 up to 1. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This function receives each failed read, with the count of failures in sequence. */
  readonly onError?: ((error: unknown, failures: number) => void) | undefined;
}

/** The time of one read of the worker when the options give none, in milliseconds. */
export const RECEIVER_READ_MS = 60_000;

const ms = (value: number) => ({ value, unit: "ms" });

/**
 * This function makes the worker of a receiver. The service declares it: `svc.worker(name, worker.knobs, worker)`.
 *
 * - Each iteration reads the link for `readMs`, and then the next iteration starts with no sleep.
 * - A failure of the link throws in the iteration, and so does an end of its texts before the end of the read. Then the
 *   worker waits its backoff, and it reads again.
 * - The drain and the close abort the read. A read ends at once at the abort.
 *
 * @throws Error when a time is not a whole count of milliseconds above 0
 */
export function meshReceiverWorker(options: MeshReceiverWorkerOptions): WorkerLoop {
  const readMs = options.readMs ?? RECEIVER_READ_MS;
  const retryBase = options.retryBase ?? 5_000;
  const retryCap = options.retryCap ?? 300_000;
  for (const [name, value] of Object.entries({ readMs, retryBase, retryCap })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the mesh receiver is not a whole count of milliseconds above 0.`);
  }
  if (retryCap < retryBase) throw new Error("The longest wait of the mesh receiver is shorter than its first wait.");
  return workerLoop(
    {
      worker_sleep: ms(0),
      // A read ends at its own timer. The bound adds one retry base, so the bound does not cut a read that ends in time.
      unit_processing_time: ms(readMs + retryBase),
      retry_base: ms(retryBase),
      retry_cap: ms(retryCap),
      // A read ends at once at the abort.
      close_bound: ms(1_000),
      concurrency: { value: 1, unit: "count" },
    },
    {
      clock: options.clock,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      iteration: async ({ signal }) => {
        const read = new AbortController();
        const stop = (): void => read.abort(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        const cancel: Cancel = options.clock.after(readMs, () => read.abort());
        try {
          await runMeshReceiver(options.receiver, options.link, read.signal);
        } finally {
          cancel();
          signal.removeEventListener("abort", stop);
        }
        // A link that ends its texts before the abort is a failure. Thus the worker waits its backoff, and it does not read in a tight loop.
        if (!read.signal.aborted) throw new Error("The mesh link ended its texts before the end of the read.");
        return "more";
      },
    },
  );
}
