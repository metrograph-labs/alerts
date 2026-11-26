import { machineProblems, replay } from "@mark1russell7/algebra";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { CanaryResult, FetchRecord, HealthState, Instant, SourceDescriptor, SourceId } from "./contracts.ts";
import {
  advanceHealth,
  DEFAULT_FAIL_AFTER,
  DEFAULT_STALE_INTERVALS,
  health,
  HEALTH_MACHINE,
  type HealthOptions,
  type HealthStep,
  observeFetch,
  startHealth,
} from "./health.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

const SOURCE = "test-source" as SourceId;
const MINUTE = 60_000;
const START: Instant = Date.UTC(2026, 0, 1);

const BASE: SourceDescriptor = {
  id: SOURCE,
  title: "A test source",
  origins: ["https://example.test"],
  dependsOn: ["provider:test"],
  uses: ["internet", "dns", "power"],
  kinds: ["met"],
  coverage: "global",
  transport: "poll",
  interval: MINUTE,
  slowAfter: 10_000,
  auth: "none",
};
const QUIET: SourceDescriptor = { ...BASE, maxQuiet: 60 * MINUTE };

const failed = { kind: "server", message: "503" } as const;

// A fetch that starts `minutes` after the start and takes `took` milliseconds.
function fetchAt(minutes: number, extra: Partial<FetchRecord> = {}): FetchRecord {
  return { source: SOURCE, at: START + minutes * MINUTE, took: 1_000, fresh: 1, fatal: 0, ...extra };
}

function run(descriptor: SourceDescriptor, records: readonly FetchRecord[], now: Instant, options: HealthOptions = {}): HealthStep {
  const step = health(descriptor, START, records, now, options);
  expect(replay(HEALTH_MACHINE, step.transitions)).toEqual([]);
  return step;
}

describe("the health machine document", () => {
  it("has no problems", () => {
    expect(machineProblems(HEALTH_MACHINE)).toEqual([]);
  });

  it("has a state for each health state of the contracts", () => {
    const states: HealthState[] = ["unknown", "healthy", "slow", "failing", "silent", "changed"];
    expect(Object.keys(HEALTH_MACHINE.states).sort()).toEqual([...states].sort());
  });
});

describe("the health of a source", () => {
  it("starts unknown, and wakes at the stale time", () => {
    const step = advanceHealth(startHealth(SOURCE, START), START, BASE);
    expect(step.health).toMatchObject({ source: SOURCE, state: "unknown", since: START });
    expect(step.transitions).toEqual([]);
    expect(step.wakeAt).toBe(START + DEFAULT_STALE_INTERVALS * MINUTE);
  });

  it("is healthy after a fetch that passed", () => {
    const step = run(BASE, [fetchAt(0)], START + 2 * MINUTE);
    expect(step.health).toMatchObject({ state: "healthy", since: START + 1_000, lastSuccess: START });
    expect(step.transitions).toEqual([
      { machine: "alerts.health", instance: SOURCE, from: "unknown", on: "app.fetch-passed", to: "healthy", at: START + 1_000 },
    ]);
  });

  it("is slow after a fetch that took slowAfter or more, and healthy after a quick one", () => {
    const slow = run(BASE, [fetchAt(0), fetchAt(1, { took: 10_000 })], START + 2 * MINUTE);
    expect(slow.health.state).toBe("slow");
    expect(slow.health.reason).toBe("The last fetch took 10 s, and the limit is 10 s.");
    expect(run(BASE, [fetchAt(0), fetchAt(1, { took: 10_000 }), fetchAt(2)], START + 3 * MINUTE).health.state).toBe("healthy");
  });

  it("is failing after failAfter failures in a row, and not after fewer", () => {
    const one = run(BASE, [fetchAt(0), fetchAt(1, { failure: failed })], START + 2 * MINUTE);
    expect(one.health.state).toBe("healthy");
    expect(one.health.lastFailure).toEqual({ at: START + MINUTE, failure: failed });
    const two = run(BASE, [fetchAt(0), fetchAt(1, { failure: failed }), fetchAt(2, { failure: failed })], START + 2.5 * MINUTE);
    expect(DEFAULT_FAIL_AFTER).toBe(2);
    expect(two.health).toMatchObject({ state: "failing", reason: "The last 2 fetches failed: server." });
    const back = run(BASE, [fetchAt(0), fetchAt(1, { failure: failed }), fetchAt(2, { failure: failed }), fetchAt(3)], START + 4 * MINUTE);
    expect(back.health.state).toBe("healthy");
    expect(back.transitions.map((t) => t.to)).toEqual(["healthy", "failing", "healthy"]);
  });

  it("obeys the option failAfter", () => {
    const records = [fetchAt(0), fetchAt(1, { failure: failed })];
    expect(run(BASE, records, START + 2 * MINUTE, { failAfter: 1 }).health.state).toBe("failing");
  });

  it("is failing when no fetch passes for the stale time: a stuck loop sends no record", () => {
    const stuck = run(BASE, [fetchAt(0)], START + 10 * MINUTE);
    expect(stuck.health).toMatchObject({ state: "failing", since: START + 1_000 + 3 * MINUTE });
    expect(stuck.health.reason).toBe("No fetch passed in 599 s, and the limit is 180 s.");
    expect(stuck.transitions.at(-1)).toMatchObject({ from: "healthy", on: "timer.stale", to: "failing" });
    expect(stuck.wakeAt).toBeUndefined();
    const never = run(BASE, [], START + 3 * MINUTE);
    expect(never.transitions).toEqual([
      { machine: "alerts.health", instance: SOURCE, from: "unknown", on: "timer.stale", to: "failing", at: START + 3 * MINUTE },
    ]);
  });

  it("obeys the option staleAfter", () => {
    expect(run(BASE, [fetchAt(0)], START + 10 * MINUTE, { staleAfter: 20 * MINUTE }).health.state).toBe("healthy");
  });

  it("is changed when the map gives fatal problems, and healthy after a clean fetch", () => {
    const changed = run(BASE, [fetchAt(0), fetchAt(1, { fatal: 3 })], START + 2 * MINUTE);
    expect(changed.health).toMatchObject({ state: "changed", reason: "The map gave 3 fatal problems for the last passed fetch." });
    expect(run(BASE, [fetchAt(0), fetchAt(1, { fatal: 3 }), fetchAt(2)], START + 3 * MINUTE).health.state).toBe("healthy");
  });

  it("is changed when the map gives lossy problems, and tells the two counts", () => {
    const at = START + 2 * MINUTE;
    expect(run(BASE, [fetchAt(0), fetchAt(1, { lossy: 5 })], at).health).toMatchObject({
      state: "changed",
      reason: "The map gave 5 lossy problems for the last passed fetch.",
    });
    expect(run(BASE, [fetchAt(0), fetchAt(1, { fatal: 1, lossy: 2 })], at).health).toMatchObject({
      state: "changed",
      reason: "The map gave 1 fatal problems and 2 lossy problems for the last passed fetch.",
    });
    expect(run(BASE, [fetchAt(0), fetchAt(1, { lossy: 0 })], at).health.state).toBe("healthy");
    expect(run(BASE, [fetchAt(0), fetchAt(1, { lossy: 5 }), fetchAt(2)], START + 3 * MINUTE).health.state).toBe("healthy");
  });

  it("stays healthy when the map skips messages by design, and tells the count of the last passed fetch (AL-94)", () => {
    const at = START + 2 * MINUTE;
    expect(run(BASE, [fetchAt(0), fetchAt(1, { skipped: 2 })], at).health).toMatchObject({
      state: "healthy",
      reason: "The last fetch passed. The map skipped 2 messages of the last passed fetch by design.",
    });
    expect(run(BASE, [fetchAt(0), fetchAt(1, { skipped: 1, lossy: 1 })], at).health).toMatchObject({
      state: "changed",
      reason: "The map gave 1 lossy problems for the last passed fetch. The map skipped 1 message of the last passed fetch by design.",
    });
    expect(run(BASE, [fetchAt(0), fetchAt(1, { skipped: 0 })], at).health.reason).toBe("The last fetch passed.");
    expect(run(BASE, [fetchAt(0), fetchAt(1, { skipped: 2 }), fetchAt(2)], START + 3 * MINUTE).health.reason).toBe("The last fetch passed.");
  });

  it("is failing while the last canary failed, through fetches with no canary", () => {
    const bad: CanaryResult = { pass: false, reason: "The newest test message is 40 minutes old." };
    const good: CanaryResult = { pass: true, reason: "The newest test message is 2 minutes old." };
    const failing = run(BASE, [fetchAt(0), fetchAt(1, { canary: bad }), fetchAt(2)], START + 3 * MINUTE);
    expect(failing.health).toMatchObject({ state: "failing", reason: `The canary failed: ${bad.reason}` });
    expect(failing.transitions.at(-1)).toMatchObject({ from: "healthy", on: "app.canary-failed", to: "failing" });
    const back = run(BASE, [fetchAt(0), fetchAt(1, { canary: bad }), fetchAt(2, { canary: good, took: 20_000 })], START + 3 * MINUTE);
    expect(back.health.state).toBe("slow");
    expect(back.transitions.at(-1)).toMatchObject({ from: "failing", on: "app.canary-passed", to: "slow" });
  });

  it("is silent after maxQuiet with no fresh observation, and healthy after a fresh one", () => {
    const quiet = Array.from({ length: 70 }, (_, minute) => fetchAt(minute, { fresh: minute === 0 ? 1 : 0 }));
    const silent = run(QUIET, quiet, START + 70 * MINUTE);
    expect(silent.health).toMatchObject({ state: "silent", since: START + 1_000 + 60 * MINUTE });
    expect(silent.transitions.at(-1)).toMatchObject({ from: "healthy", on: "timer.quiet", to: "silent" });
    expect(run(QUIET, [...quiet, fetchAt(70)], START + 71 * MINUTE).health.state).toBe("healthy");
    // A source with no maxQuiet is never silent.
    expect(run(BASE, quiet, START + 70 * MINUTE).health.state).toBe("healthy");
  });
});

// The oracle: the state at `now` from the whole list of records, without timers.
function oracle(descriptor: SourceDescriptor, records: readonly FetchRecord[], now: Instant, options: HealthOptions): HealthState {
  const end = (record: FetchRecord): Instant => record.at + record.took;
  const passed = records.filter((record) => record.failure === undefined);
  let failures = 0;
  for (let index = records.length - 1; index >= 0 && records[index]!.failure !== undefined; index -= 1) failures += 1;
  const last = passed.at(-1);
  const staleFrom = last === undefined ? START : end(last);
  const canary = passed.filter((record) => record.canary !== undefined).at(-1)?.canary;
  if (failures >= (options.failAfter ?? DEFAULT_FAIL_AFTER)) return "failing";
  if (now - staleFrom >= (options.staleAfter ?? DEFAULT_STALE_INTERVALS * descriptor.interval)) return "failing";
  if (canary !== undefined && !canary.pass) return "failing";
  if (last === undefined) return "unknown";
  if (last.fatal + (last.lossy ?? 0) > 0) return "changed";
  const fresh = passed.filter((record) => record.fresh > 0).at(-1) ?? passed[0]!;
  if (descriptor.maxQuiet !== undefined && now - end(fresh) >= descriptor.maxQuiet) return "silent";
  if (last.took >= descriptor.slowAfter) return "slow";
  return "healthy";
}

function randomRecords(r: Random): FetchRecord[] {
  const records: FetchRecord[] = [];
  let time = START + r.int(0, 2 * MINUTE);
  for (let index = r.int(0, 40); index > 0; index -= 1) {
    const took = r.int(0, 20_000);
    const record: FetchRecord = {
      source: SOURCE,
      at: time,
      took,
      fresh: r.chance(0.4) ? r.int(1, 5) : 0,
      fatal: r.chance(0.1) ? r.int(1, 3) : 0,
      ...(r.chance(0.1) ? { lossy: r.int(1, 3) } : {}),
      ...(r.chance(0.25) ? { failure: r.pick([failed, { kind: "timeout", message: "30 s" } as const]) } : {}),
      ...(r.chance(0.2) ? { canary: { pass: r.chance(0.6), reason: "test" } } : {}),
    };
    records.push(record);
    time += took + r.int(0, r.chance(0.1) ? 30 * MINUTE : 2 * MINUTE);
  }
  return records;
}

describe("the health over random records", () => {
  const descriptors = [BASE, { ...BASE, maxQuiet: 15 * MINUTE }];

  it.each(SEEDS)("agrees with the oracle and replays against the document (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const descriptor = r.pick(descriptors);
      const options: HealthOptions = r.chance(0.5) ? {} : { failAfter: r.int(1, 4), staleAfter: r.int(1, 20) * MINUTE };
      const records = randomRecords(r);
      const lastEnd = records.reduce((latest, record) => Math.max(latest, record.at + record.took), START);
      const now = lastEnd + r.int(0, 90 * MINUTE);
      const whole = health(descriptor, START, records, now, options);
      expect(replay(HEALTH_MACHINE, whole.transitions), `seed ${seed} round ${round}`).toEqual([]);
      expect(whole.health.state, `seed ${seed} round ${round}`).toBe(oracle(descriptor, records, now, options));
      // Each transition goes to a new state, so a step never reports a change that did not occur.
      expect(whole.transitions.every((t) => t.from !== t.to)).toBe(true);
      expect(whole.health.since).toBe(whole.transitions.at(-1)?.at ?? START);

      // The steps one by one, with advances of the time between them, give the same transitions.
      let track = startHealth(SOURCE, START);
      const steps: HealthStep[] = [];
      for (const record of records) {
        if (r.chance(0.3)) {
          const step = advanceHealth(track, r.int(track.time, record.at + record.took), descriptor, options);
          steps.push(step);
          track = step.track;
        }
        const step = observeFetch(track, record, descriptor, options);
        steps.push(step);
        track = step.track;
      }
      const final = advanceHealth(track, now, descriptor, options);
      steps.push(final);
      expect(steps.flatMap((step) => step.transitions)).toEqual(whole.transitions);
      expect(final.health).toEqual(whole.health);

      // No timer fires before `wakeAt`.
      if (final.wakeAt !== undefined) {
        expect(final.wakeAt).toBeGreaterThan(now);
        expect(advanceHealth(final.track, final.wakeAt - 1, descriptor, options).transitions).toEqual([]);
      }
    }
  });
});
