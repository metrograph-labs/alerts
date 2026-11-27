/**
 * The faults of a `@mark1russell7/rigor-chaos` plan on the simulated mesh. The plan has one connection: the mesh. The
 * direction `up` goes from the home to the bed node, and `down` from the bed node to the home. Each point counts the
 * frames of its direction, from 0.
 *
 * A radio frame is a datagram with no connection. Thus the kinds `cut` and `reset` drop the one frame at their point. A
 * plan of `rigor-chaos` has no kind for the loss of one datagram. The kind `split` has no effect, because a frame is one packet.
 */

import type { WallClock } from "@mark1russell7/algebra/clock";
import { faultPlan, faultsOf, type Direction, type Fault, type FaultPlan, type FaultSpec } from "@mark1russell7/rigor-chaos";
import type { MeshFilter } from "./testing.ts";

/** One fault that a filter applied. */
export interface AppliedFault {
  readonly direction: Direction;
  readonly frame: number;
  readonly kind: Fault["kind"];
  readonly at: number;
}

/** The filters of the two directions of a plan, and the record of the faults that they applied. */
export interface PlanFilters {
  readonly up: MeshFilter;
  readonly down: MeshFilter;
  readonly applied: readonly AppliedFault[];
}

/** The spec of the seeded plans of the fault test: drops, delays, copies and reorders in both directions. */
export const MESH_FAULT_SPEC: FaultSpec = {
  connections: 1,
  perConnection: 30,
  kinds: { cut: 3, delay: 2, duplicate: 2, reorder: 2 },
  // A run of a gate has 15 to 40 frames in each direction. Thus most faults of a plan come in a run.
  within: { frame: 30 },
  ranges: { delayMs: [1_000, 20_000], delayForMs: [1_000, 30_000], reorderCount: [2, 4], reorderHoldMs: [1_000, 15_000], duplicateCopies: [1, 3] },
};

/** The longest time that the spec holds a frame: the longest delay, or the longest hold of a reorder. */
export const MESH_FAULT_HOLD_MS = 20_000;

/** This function gives the seeded plan of the fault test. */
export function meshFaultPlan(seed: number): FaultPlan {
  return faultPlan(MESH_FAULT_SPEC, seed);
}

/** This function gives the filters that apply the faults of a plan on the clock. */
export function planFilters(plan: FaultPlan, clock: Pick<WallClock, "now" | "after">): PlanFilters {
  const applied: AppliedFault[] = [];
  const faults = faultsOf(plan, 0);

  const filterOf = (direction: Direction): MeshFilter => {
    const own = faults.filter((fault) => fault.direction === direction);
    let frame = 0;
    // The delay of the frames until a time.
    let delayUntil = Number.NEGATIVE_INFINITY;
    let delayMs = 0;
    // The frames that a reorder holds, and the count that releases them.
    let held: { text: string; deliver: (text: string) => void }[] = [];
    let holdCount = 0;
    let cancelHold: (() => void) | undefined;

    const release = (): void => {
      cancelHold?.();
      cancelHold = undefined;
      const out = held.reverse();
      held = [];
      holdCount = 0;
      for (const item of out) item.deliver(item.text);
    };

    const send = (text: string, deliver: (text: string) => void, copies: number): void => {
      const out = (): void => {
        for (let index = 0; index <= copies; index += 1) deliver(text);
      };
      if (clock.now() < delayUntil) clock.after(delayMs, out);
      else out();
    };

    return (text, deliver) => {
      const index = frame;
      frame += 1;
      const now = clock.now();
      const here = own.filter((fault) => "frame" in fault.at && fault.at.frame === index);
      for (const fault of here) applied.push({ direction, frame: index, kind: fault.kind, at: now });
      if (here.some((fault) => fault.kind === "cut" || fault.kind === "reset")) return;
      let copies = 0;
      for (const fault of here) {
        if (fault.kind === "duplicate") copies += fault.copies;
        if (fault.kind === "delay") {
          delayUntil = now + fault.forMs;
          delayMs = fault.ms;
        }
        if (fault.kind === "stall") {
          delayUntil = now + fault.ms;
          delayMs = fault.ms;
        }
        if (fault.kind === "reorder" && holdCount === 0) {
          holdCount = fault.count;
          cancelHold = clock.after(fault.holdMs, release);
        }
      }
      if (holdCount > 0) {
        held.push({ text, deliver: (copy) => send(copy, deliver, copies) });
        if (held.length >= holdCount) release();
        return;
      }
      send(text, deliver, copies);
    };
  };

  return { up: filterOf("up"), down: filterOf("down"), applied };
}
