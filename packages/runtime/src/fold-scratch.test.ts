import type { PersonId, ReportId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { EMPTY_RUNTIME, fold, foldScratch, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const CONTEXT: FoldContext = { sources: [] };
const PERSON = "person-1" as PersonId;

// The start of an escalation of the incident `n`, and the end of the escalations of the incident `n`.
const start = (n: number): RuntimeEvent => ({ ...envelope("escalation", `escalation:${String(n)}`, T0 + n), start: { incident: `r-${String(n)}` as ReportId, level: "urgent", person: PERSON, at: T0 + n } });
const end = (n: number): RuntimeEvent => ({ ...envelope("escalation-end", `end:${String(n)}`, T0 + n), end: { incident: `r-${String(n)}` as ReportId, person: PERSON, at: T0 + n } });

// The events of one batch: starts, and an end after each third start.
const batch = (from: number, count: number): RuntimeEvent[] => Array.from({ length: count }, (_, index) => (index % 3 === 2 ? end(from + index) : start(from + index)));

describe("a batch of folds with one scratch (AL-150)", () => {
  it("gives the state of the folds with no scratch, and leaves the state before the batch as it was", () => {
    const before = batch(0, 30).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME);
    const copy = structuredClone(before);
    const events = batch(30, 300);
    const plain = events.reduce((state: RuntimeState, event) => fold(state, event, CONTEXT), before);
    const scratch = foldScratch();
    const fast = events.reduce((state: RuntimeState, event) => fold(state, event, CONTEXT, undefined, scratch), before);
    expect(fast).toEqual(plain);
    expect(fast.starts).toHaveLength(220);
    expect(fast.escalationEnds).toHaveLength(110);
    // The lists of the state before the batch are not lists of the scratch, thus the batch adds nothing to them.
    expect(before).toEqual(copy);
  });

  it("starts each batch with a new scratch, thus the last state of a batch stays the same", () => {
    const first = batch(0, 30).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT, undefined, foldScratch()), EMPTY_RUNTIME);
    const scratch = foldScratch();
    const one = batch(0, 30).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT, undefined, scratch), EMPTY_RUNTIME);
    const kept = structuredClone(one);
    batch(30, 30).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT, undefined, foldScratch()), one);
    expect(one).toEqual(kept);
    expect(one).toEqual(first);
  });

  it("adds each start of the batch in place, with no copy of the list (the gate of the O(n) batch)", () => {
    const scratch = foldScratch();
    const second = [start(0), start(1)].reduce((state: RuntimeState, event) => fold(state, event, CONTEXT, undefined, scratch), EMPTY_RUNTIME);
    const third = fold(second, start(2), CONTEXT, undefined, scratch);
    const fourth = fold(third, end(3), CONTEXT, undefined, scratch);
    const fifth = fold(fourth, end(4), CONTEXT, undefined, scratch);
    expect(third.starts).toBe(second.starts);
    expect(fifth.own.escalationEnds).toBe(fourth.own.escalationEnds);
    expect(fifth.starts).toHaveLength(3);
  });

  it("gives the same state in a rebuild of many starts", () => {
    const events = batch(0, 3000);
    expect(rebuild(events, CONTEXT)).toEqual(events.reduce((state: RuntimeState, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME));
  });
});
