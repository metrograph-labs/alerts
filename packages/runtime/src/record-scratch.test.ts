import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { FetchOutcome, PlaceId, SourceDescriptor, SourceId, SourceProcedures, WatchedPlace } from "@mark1russell7/alerts";
import type { FoldSnapshot } from "@mark1russell7/sqlite";
import { describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";
import { readSnapshot } from "./start-snapshot.ts";
import { EMPTY_RUNTIME, fold, recordBatch, recordScratch, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const COUNT = 300;

function descriptor(id: SourceId): SourceDescriptor {
  return {
    id,
    title: `The source ${id}`,
    origins: ["nws"],
    dependsOn: [`provider:${id}`],
    uses: ["internet"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10_000,
    auth: "none",
  };
}

const ids = Array.from({ length: COUNT }, (_, n) => `feed-${String(n)}` as SourceId);
const CONTEXT: FoldContext = { sources: ids.map(descriptor) };

// The fetch of the source `n` in the round `round`, with a cursor. Each tenth fetch fails.
const fetchOf = (n: number, round: number): RuntimeEvent => {
  const at = T0 + round * MINUTE + n;
  const failure = n % 10 === 9 ? { failure: { kind: "server" as const, message: "The fake server failed." } } : {};
  return { ...envelope("fetch", `fetch:${String(round)}:${String(n)}`, at), record: { source: ids[n]!, at, took: 50, fresh: 0, fatal: 0, ...failure }, cursor: { seen: String(at) }, reports: [], problems: [] };
};
const round = (number: number): RuntimeEvent[] => ids.map((_, n) => fetchOf(n, number));
const started: RuntimeEvent = { ...envelope("started", "started:run-0", T0), run: "run-0" };

// The count of the different objects of each record of each source in a list of states: the first record and each copy.
const records = (states: readonly RuntimeState[]): Record<"cursors" | "fetched" | "health", number> => ({
  cursors: new Set(states.map((state) => state.cursors)).size,
  fetched: new Set(states.map((state) => state.fetched)).size,
  health: new Set(states.map((state) => state.health)).size,
});

describe("the folds of the fetches of one pass with one record scratch (AL-136)", () => {
  const before = round(0).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT), fold(EMPTY_RUNTIME, started, CONTEXT));

  it("gives the state of the folds with no scratch, and leaves the state before the pass as it was", () => {
    const copy = structuredClone(before);
    const plain = round(1).reduce((state: RuntimeState, event) => fold(state, event, CONTEXT), before);
    const scratch = recordScratch();
    const fast = round(1).reduce((state: RuntimeState, event) => recordBatch(scratch, () => fold(state, event, CONTEXT, undefined, undefined, scratch)), before);
    expect(fast).toEqual(plain);
    expect(Object.keys(fast.health)).toHaveLength(COUNT);
    expect(before).toEqual(copy);
  });

  it("copies each record one time in a pass of 300 fetches, not one time for each fetch (the gate of the O(n) pass)", () => {
    const scratch = recordScratch();
    const states = [before];
    for (const event of round(1)) states.push(recordBatch(scratch, () => fold(states.at(-1)!, event, CONTEXT, undefined, undefined, scratch)));
    // The first record comes from the state before the pass. The first fetch makes the one copy, and each later fetch changes it in place.
    expect(records(states)).toEqual({ cursors: 2, fetched: 2, health: 2 });
    expect(states[2]!.health).toBe(states.at(-1)!.health);
    // With no scratch, each fetch copies each record.
    const plain = [before];
    for (const event of round(1)) plain.push(fold(plain.at(-1)!, event, CONTEXT));
    expect(records(plain)).toEqual({ cursors: COUNT + 1, fetched: COUNT + 1, health: COUNT + 1 });
  });

  it("puts back each record that a failed batch changed in place", () => {
    const scratch = recordScratch();
    const events = round(1);
    const last = recordBatch(scratch, () => fold(before, events[0]!, CONTEXT, undefined, undefined, scratch));
    const kept = structuredClone(last);
    let draft = last;
    expect(() =>
      recordBatch(scratch, () => {
        draft = fold(fold(last, events[1]!, CONTEXT, undefined, undefined, scratch), events[2]!, CONTEXT, undefined, undefined, scratch);
        throw new Error("The write failed.");
      }),
    ).toThrow("The write failed.");
    // The folds of the failed batch changed the records of the last state in place. The batch puts back each old value and drops each new key.
    expect(draft.health).toBe(last.health);
    expect(last).toEqual(kept);
  });

  it("keeps the records of a cut when a new scratch starts at the cut (the seal)", () => {
    const events = round(1);
    let scratch = recordScratch();
    let state = before;
    for (const event of events.slice(0, 100)) state = recordBatch(scratch, () => fold(state, event, CONTEXT, undefined, undefined, scratch));
    const cut = state;
    const kept = structuredClone(cut);
    scratch = recordScratch();
    for (const event of events.slice(100)) state = recordBatch(scratch, () => fold(state, event, CONTEXT, undefined, undefined, scratch));
    expect(cut).toEqual(kept);
    expect(state.health).not.toBe(cut.health);
    expect(state).toEqual(events.reduce((last: RuntimeState, event) => fold(last, event, CONTEXT), before));
  });
});

describe("the record scratch of a pass of the runtime (AL-136)", () => {
  const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
  const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };
  const A = "feed-a" as SourceId;
  const B = "feed-b" as SourceId;
  const map = () => ({ reports: [], problems: [] });

  // A source whose fetch of each pass after the first waits for `release`.
  function gated(id: SourceId) {
    let passes = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source: SourceProcedures = {
      describe: () => descriptor(id),
      map,
      fetch: async (): Promise<FetchOutcome> => {
        passes += 1;
        if (passes > 1) await gate;
        return { ok: true, observations: [], complete: true, cursor: { pass: String(passes) } };
      },
    };
    return { source, release: () => release() };
  }

  // This function waits for a condition in the turns of the loop.
  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 200 && !condition(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(condition()).toBe(true);
  }

  function open(sources: readonly SourceProcedures[], extra: Partial<RuntimeOptions> = {}, wrap: (log: RuntimeLog) => RuntimeLog = (log) => log) {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const runtime = openRuntime({ log: wrap(log), clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", ...extra });
    return { clock, log, runtime };
  }

  it("writes the cut of a snapshot that a pass takes between two fetches, with no change from the later fetch", async () => {
    const a = gated(A);
    const b = gated(B);
    let rows: { readonly part: string; readonly value: string }[] = [];
    let readRows = (): void => undefined;
    // The store reads the rows of the cut only after the fetch of B. Thus a change of a record of the cut shows in the rows.
    const store = {
      writeInChunks: async (_key: string, _mark: unknown, cut: Iterable<{ readonly part: string; readonly value: string }>) => {
        await new Promise<void>((resolve) => (readRows = resolve));
        rows = [...cut];
        return rows.length;
      },
    } as unknown as FoldSnapshot;
    const { clock, log, runtime } = open([a.source, b.source], { startSnapshot: store });
    try {
      await runtime.pass();
      await clock.advance(MINUTE);
      const passing = runtime.pass();
      a.release();
      await until(() => runtime.state().cursors[A]?.["pass"] === "2");
      const kept = structuredClone(runtime.state());
      const writing = runtime.writeStartSnapshot();
      b.release();
      await passing;
      expect(runtime.state().cursors[B]?.["pass"]).toBe("2");
      readRows();
      expect(await writing).toBeGreaterThan(0);
      const cut = readSnapshot(rows).state;
      expect(cut.cursors).toEqual(kept.cursors);
      expect(cut.fetched).toEqual(kept.fetched);
      expect(cut.health).toEqual(kept.health);
      expect(cut.cursors[B]?.["pass"]).toBe("1");
    } finally {
      await runtime.close();
      log.close();
    }
  });

  it("keeps the records of the state when the write of a later fetch of the pass fails", async () => {
    const a = gated(A);
    const b = gated(B);
    let failing = false;
    // The write of a fetch of B fails after its fold, as a write that the file refuses.
    const wrap = (inner: RuntimeLog): RuntimeLog => ({
      ...inner,
      appendAll: (events, accept) =>
        inner.appendAll(events, (event) => {
          accept(event);
          if (failing && event.type === "fetch" && event.record.source === B) throw new Error("The write failed.");
        }),
    });
    const { clock, log, runtime } = open([a.source, b.source], {}, wrap);
    try {
      await runtime.pass();
      await clock.advance(MINUTE);
      failing = true;
      const passing = runtime.pass();
      a.release();
      await until(() => runtime.state().cursors[A]?.["pass"] === "2");
      const kept = structuredClone(runtime.state());
      b.release();
      await expect(passing).rejects.toThrow("The write failed.");
      const state = runtime.state();
      expect(state.cursors).toEqual(kept.cursors);
      expect(state.fetched).toEqual(kept.fetched);
      expect(state.health).toEqual(kept.health);
      expect(state.cursors[B]?.["pass"]).toBe("1");
    } finally {
      await runtime.close();
      log.close();
    }
  });
});
