/**
 * The fakes of the mesh channel for tests: a simulated bed node and a simulated mesh between it and the home. Each one
 * runs on an injected clock, thus a test moves the time with a fake clock and needs no radio.
 *
 * - The simulated node sounds its siren for each new alarm frame, and it stops the siren at a stop frame or at `expires`.
 * - `press()` is a push of the button: an ack for each alarm that sounds. The node answers each later alarm frame of an
 *   acked id with the ack again.
 * - The node sends a beat in each heartbeat period. A stopped node sends nothing and hears nothing.
 * - The simulated mesh carries each text in two directions. A filter of a direction can drop, hold, copy or reorder a text.
 */

import type { Duration, Instant } from "@mark1russell7/alerts";
import type { Cancel, WallClock } from "@mark1russell7/algebra/clock";
import { Channel } from "@mark1russell7/service/channel";
import { decodeFrame, encodeFrame } from "./protocol.ts";
import type { LinkOutcome, MeshLink } from "./receiver.ts";

/** The direction of a text in the simulated mesh. `up` goes from the home to the node, and `down` from the node to the home. */
export type MeshDirection = "up" | "down";

/**
 * A filter of one direction of the simulated mesh. It gets each text and the function that delivers a text at the other
 * end. A filter with no fault uses `deliver(text)` one time.
 */
export type MeshFilter = (text: string, deliver: (text: string) => void) => void;

/** The counts of the texts of a simulated node. */
export interface NodeCounts {
  /** The ack frames that the node sent. */
  readonly acks: number;
  readonly beats: number;
  /** The texts that the node heard, also the texts that it did not read. */
  readonly heard: number;
}

/** A simulated bed node. */
export interface SimulatedNode {
  readonly name: string;
  /** This method gives a text from the mesh to the node. A stopped node does not hear it. */
  hear(text: string): void;
  /** This method pushes the button: the node sends an ack for each alarm that sounds, and it stops the siren. */
  press(): void;
  /** This method stops the node: no more beats, and it hears nothing. The siren stops, as with a loss of power. */
  kill(): void;
  /** This method starts a stopped node again. Its beat sequence starts at 0, as after a restart. */
  revive(): void;
  /** This method tells if the siren sounds. */
  siren(): boolean;
  /** This method gives the ids of the alarms that sound. */
  sounding(): readonly string[];
  /** This method tells if the node is alive. */
  alive(): boolean;
  /** This method gives the counts of the texts of the node. */
  counts(): NodeCounts;
  /** This method stops the timers of the node. */
  close(): void;
}

/** The options of a simulated node. */
export interface SimulatedNodeOptions {
  /** The name of the node in the frames. */
  readonly name: string;
  /** The clock of the node. Its timers give the beats. */
  readonly clock: Pick<WallClock, "now" | "after">;
  /** The heartbeat period of the node. */
  readonly beatMs: Duration;
  /** This function sends a text from the node to the mesh. */
  readonly send: (text: string) => void;
  /** The time from the start to the first beat. The default is 0: the first beat comes at once. */
  readonly firstBeatMs?: Duration | undefined;
}

// The most ended ids that a node keeps.
const NODE_KEPT = 64;

/** This function makes a simulated bed node. */
export function simulatedNode(options: SimulatedNodeOptions): SimulatedNode {
  const { clock, name } = options;
  // The alarms that sound, by id, with their time expires.
  const sounding = new Map<string, Instant | undefined>();
  // The ids that a push acked, and the ids that a stop or the time expires ended. The oldest first.
  const acked: string[] = [];
  const ended: string[] = [];
  let alive = true;
  let seq = 0;
  let beatTimer: Cancel | undefined;
  const counts = { acks: 0, beats: 0, heard: 0 };

  const keep = (list: string[], id: string): void => {
    if (list.includes(id)) return;
    list.push(id);
    if (list.length > NODE_KEPT) list.shift();
  };

  // The node stops each alarm whose time expires passed.
  const expire = (): void => {
    const now = clock.now();
    for (const [id, expires] of sounding) {
      if (expires !== undefined && expires <= now) {
        sounding.delete(id);
        keep(ended, id);
      }
    }
  };

  const ack = (id: string): void => {
    counts.acks += 1;
    options.send(encodeFrame({ v: 1, kind: "ack", id, by: name, at: clock.now() }));
  };

  const beat = (): void => {
    if (!alive) return;
    expire();
    counts.beats += 1;
    options.send(encodeFrame({ v: 1, kind: "beat", node: name, seq, at: clock.now() }));
    seq += 1;
    beatTimer = clock.after(options.beatMs, beat);
  };

  const start = (first: Duration): void => {
    beatTimer = clock.after(first, beat);
  };
  start(options.firstBeatMs ?? 0);

  return {
    name,
    hear(text) {
      if (!alive) return;
      counts.heard += 1;
      expire();
      const read = decodeFrame(text);
      if (read.tag === "err") return;
      const frame = read.value;
      if (frame.kind === "alarm") {
        if (acked.includes(frame.id)) ack(frame.id);
        else if (!ended.includes(frame.id) && !sounding.has(frame.id) && !(frame.expires !== undefined && frame.expires <= clock.now())) sounding.set(frame.id, frame.expires);
      } else if (frame.kind === "stop") {
        if (sounding.delete(frame.id)) keep(ended, frame.id);
        else if (!acked.includes(frame.id)) keep(ended, frame.id);
      }
    },
    press() {
      if (!alive) return;
      expire();
      for (const id of [...sounding.keys()]) {
        sounding.delete(id);
        keep(acked, id);
        ack(id);
      }
    },
    kill() {
      alive = false;
      sounding.clear();
      beatTimer?.();
      beatTimer = undefined;
    },
    revive() {
      if (alive) return;
      alive = true;
      seq = 0;
      start(0);
    },
    siren: () => {
      expire();
      return alive && sounding.size > 0;
    },
    sounding: () => {
      expire();
      return [...sounding.keys()];
    },
    alive: () => alive,
    counts: () => ({ ...counts }),
    close() {
      beatTimer?.();
      beatTimer = undefined;
    },
  };
}

/** The counts of the texts of a simulated mesh, by direction. */
export interface MeshCounts {
  /** The texts that a side gave to the mesh. */
  readonly sent: Readonly<Record<MeshDirection, number>>;
  /** The texts that came to the other side, with each copy. */
  readonly delivered: Readonly<Record<MeshDirection, number>>;
}

/** A simulated mesh: the link of the home side, and the bed node at the other side. */
export interface SimulatedMesh {
  /** The link of the home side, for the channel and the receiver. */
  readonly link: MeshLink;
  readonly node: SimulatedNode;
  /** This method makes the next writes of the home side fail, as a link with no serial port, until a call with false. */
  breakLink(broken: boolean): void;
  counts(): MeshCounts;
  /** This method stops the timers of the node and ends each read of the link. */
  close(): void;
}

/** The options of a simulated mesh. */
export interface SimulatedMeshOptions {
  readonly clock: Pick<WallClock, "now" | "after">;
  /** The name of the bed node. The default is `bed-node`. */
  readonly node?: string | undefined;
  /** The heartbeat period of the node. */
  readonly beatMs: Duration;
  /** The time from the start to the first beat. The default is 0. */
  readonly firstBeatMs?: Duration | undefined;
  /** The filter of each direction. The default delivers each text one time, at once. */
  readonly filters?: Partial<Readonly<Record<MeshDirection, MeshFilter>>> | undefined;
}

const pass: MeshFilter = (text, deliver) => deliver(text);

/** The most texts that the home side keeps for a read. A full buffer drops the new text, as a full radio queue does. */
export const MESH_BUFFER = 1024;

/** This function makes a simulated mesh with one bed node. */
export function simulatedMesh(options: SimulatedMeshOptions): SimulatedMesh {
  const up = options.filters?.up ?? pass;
  const down = options.filters?.down ?? pass;
  const inbox = new Channel<string>(MESH_BUFFER);
  const sent = { up: 0, down: 0 };
  const delivered = { up: 0, down: 0 };
  let broken = false;
  const node = simulatedNode({
    name: options.node ?? "bed-node",
    clock: options.clock,
    beatMs: options.beatMs,
    firstBeatMs: options.firstBeatMs,
    send: (text) => {
      sent.down += 1;
      down(text, (copy) => {
        delivered.down += 1;
        inbox.trySend(copy);
      });
    },
  });

  const link: MeshLink = {
    send(text): Promise<LinkOutcome> {
      if (broken) return Promise.resolve({ ok: false, message: "The serial port of the home node is closed." });
      sent.up += 1;
      up(text, (copy) => {
        delivered.up += 1;
        node.hear(copy);
      });
      return Promise.resolve({ ok: true });
    },
    receive(signal) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<string>>((resolve) => {
              if (signal.aborted) {
                resolve({ done: true, value: undefined });
                return;
              }
              // A value in the buffer comes at once, in the call of waitReceive. Then the read adds no listener.
              let done = false;
              const onAbort = (): void => {
                if (withdraw()) resolve({ done: true, value: undefined });
              };
              const finish = (result: IteratorResult<string>): void => {
                done = true;
                signal.removeEventListener("abort", onAbort);
                resolve(result);
              };
              const withdraw = inbox.waitReceive(
                (value) => finish({ done: false, value }),
                () => finish({ done: true, value: undefined }),
              );
              if (!done) signal.addEventListener("abort", onAbort, { once: true });
            }),
        }),
      };
    },
  };

  return {
    link,
    node,
    breakLink: (value) => {
      broken = value;
    },
    counts: () => ({ sent: { ...sent }, delivered: { ...delivered } }),
    close() {
      node.close();
      inbox.close();
    },
  };
}
