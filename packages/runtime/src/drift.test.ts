import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { DriftCommandConfig } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { DRIFT_EVERY, DRIFT_LIMIT, DRIFT_MAX_AGE, DRIFT_RETRY, DRIFT_STEPS_KEPT, driftOf, driftReader, driftWatch, type CommandOutput, type DriftRunner } from "./drift.ts";

const T0 = Date.UTC(2026, 10, 24, 12);
const SETUP: DriftCommandConfig = { name: "host-a", kind: "setup", argv: ["check-host", "--check"] };
const PLAN: DriftCommandConfig = { name: "plan-a", kind: "tofu", argv: ["plan-host", "-detailed-exitcode"] };
const signal = new AbortController().signal;

// A runner that gives the next output of a list for each command, and records each argv.
function scripted(outputs: Readonly<Record<string, readonly (CommandOutput | Error)[]>>) {
  const calls: string[][] = [];
  const counts = new Map<string, number>();
  const run: DriftRunner = async (argv) => {
    calls.push([...argv]);
    const key = argv[0] ?? "";
    const list = outputs[key] ?? [];
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const output = list[Math.min(index, list.length - 1)];
    if (output === undefined) throw new Error("no output");
    if (output instanceof Error) throw output;
    return output;
  };
  return { run, calls };
}

describe("the changes in the output of a drift check", () => {
  it("counts each step of a setup check that changes, and keeps only the safe names", () => {
    const stdout = ["ok: step.zero", "check: step.two: the unit is not enabled", "check: step.one: the file differs", "check: step.one: the mode differs", "check: bad name/with space: a reason", "check: step.three"].join("\n");
    expect(driftOf("setup", 0, stdout)).toEqual({ ok: true, changes: 4, steps: ["step.one", "step.three", "step.two"] });
    expect(driftOf("setup", 0, "ok: step.one\r\nok: step.two\r\n")).toEqual({ ok: true, changes: 0, steps: [] });
    expect(driftOf("setup", 3, "check: step.one: a reason")).toEqual({ ok: false, message: "The setup check gave the exit code 3." });
  });

  it("reads the exit code of a plan, and the resources and the summary of a plan with a change", () => {
    expect(driftOf("tofu", 0, "No changes.")).toEqual({ ok: true, changes: 0, steps: [] });
    const plan = ["\u001b[1m  # res_a.one\u001b[0m will be updated in-place", '  # res_b.list["key"] must be replaced', "  # res_c.two will be destroyed", "Plan: 1 to add, 1 to change, 1 to destroy."].join("\n");
    expect(driftOf("tofu", 2, plan)).toEqual({ ok: true, changes: 3, steps: ["res_a.one", "res_c.two"] });
    expect(driftOf("tofu", 2, "Plan: 2 to add, 3 to change, 0 to destroy.")).toEqual({ ok: true, changes: 5, steps: [] });
    // A plan with a change and no line that the function knows is one change.
    expect(driftOf("tofu", 2, "")).toEqual({ ok: true, changes: 1, steps: [] });
    expect(driftOf("tofu", 1, "Error: the provider failed")).toEqual({ ok: false, message: "The plan gave the exit code 1." });
  });

  it("keeps at most the first names, and the count holds the others", () => {
    const stdout = Array.from({ length: DRIFT_STEPS_KEPT + 5 }, (_, index) => `check: step.${String(index).padStart(3, "0")}: a reason`).join("\n");
    const reading = driftOf("setup", 0, stdout);
    expect(reading).toMatchObject({ ok: true, changes: DRIFT_STEPS_KEPT + 5 });
    expect(reading.ok && reading.steps.length).toBe(DRIFT_STEPS_KEPT);
  });
});

describe("the reader of a drift check", () => {
  it("starts the argv of the command, and names the check in a failure with no output", async () => {
    const runner = scripted({
      "check-host": [
        { exitCode: 0, stdout: "check: step.one: a secret detail" },
        { exitCode: 1, stdout: "a secret detail" },
        { exitCode: 1, stdout: "", timedOut: true },
        { exitCode: 1, stdout: "", notStarted: true },
        { exitCode: 0, stdout: "", truncated: true },
        new Error("a secret detail"),
      ],
    });
    const read = driftReader(SETUP, runner.run);
    const readings = [];
    for (let index = 0; index < 6; index += 1) readings.push(await read(signal, T0));
    expect(runner.calls[0]).toEqual(["check-host", "--check"]);
    expect(readings[0]).toEqual({ ok: true, changes: 1, steps: ["step.one"] });
    expect(readings.slice(1).map((reading) => (reading.ok ? "" : reading.message))).toEqual([
      "The drift check host-a failed: The setup check gave the exit code 1.",
      `The drift check host-a took longer than ${String(DRIFT_LIMIT)} ms.`,
      "The program of the drift check host-a did not start.",
      "The output of the drift check host-a is longer than 4194304 bytes.",
      "The drift check host-a failed to run.",
    ]);
    expect(readings.some((reading) => JSON.stringify(reading).includes("secret"))).toBe(false);
  });
});

describe("the drift watch", () => {
  it("reads each check at the first check, then once in each day, and gives the checks as data of the core", async () => {
    const clock = fakeWallClock(T0);
    const runner = scripted({ "check-host": [{ exitCode: 0, stdout: "check: step.one: a reason" }, { exitCode: 0, stdout: "" }], "plan-host": [{ exitCode: 0, stdout: "No changes." }] });
    const watch = driftWatch({ commands: [SETUP, PLAN], run: runner.run });
    expect(watch.drift()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls.map((call) => call[0])).toEqual(["check-host", "plan-host"]);
    expect(watch.drift()).toEqual([
      { name: "host-a", maxAge: DRIFT_MAX_AGE, since: T0, read: { changes: 1, steps: ["step.one"], at: T0 } },
      { name: "plan-a", maxAge: DRIFT_MAX_AGE, since: T0, read: { changes: 0, steps: [], at: T0 } },
    ]);
    expect(watch.nextReadAt()).toBe(T0 + DRIFT_EVERY);
    clock.set(T0 + DRIFT_EVERY - 1);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls).toHaveLength(2);
    clock.set(T0 + DRIFT_EVERY);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls).toHaveLength(4);
    expect(watch.drift()?.[0]?.read).toEqual({ changes: 0, steps: [], at: T0 + DRIFT_EVERY });
    expect(watch.health()).toEqual([
      { what: "drift of host-a", at: T0 + DRIFT_EVERY, failed: false, next: T0 + 2 * DRIFT_EVERY },
      { what: "drift of plan-a", at: T0 + DRIFT_EVERY, failed: false, next: T0 + 2 * DRIFT_EVERY },
    ]);
  });

  it("does not wait for the commands, runs them one at a time, and starts no second run while one runs", async () => {
    const clock = fakeWallClock(T0);
    const releases: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const run: DriftRunner = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return { exitCode: 0, stdout: "" };
    };
    const watch = driftWatch({ commands: [SETUP, PLAN], run });
    await watch.check(clock);
    expect(releases).toHaveLength(1);
    // While the commands run, the next read is the latest end of the commands.
    expect(watch.nextReadAt()).toBe(T0 + 2 * DRIFT_LIMIT);
    await watch.check(clock);
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await watch.settled();
    expect(most).toBe(1);
    expect(watch.nextReadAt()).toBe(T0 + DRIFT_EVERY);
  });

  it("keeps the last read of a check after its failure, retries only that check, and moves its times at a step of the clock", async () => {
    const clock = fakeWallClock(T0);
    const runner = scripted({ "check-host": [{ exitCode: 0, stdout: "check: step.one: a reason" }, { exitCode: 4, stdout: "" }, { exitCode: 0, stdout: "" }], "plan-host": [{ exitCode: 0, stdout: "" }] });
    const watch = driftWatch({ commands: [SETUP, PLAN], run: runner.run });
    await watch.check(clock);
    await watch.settled();
    clock.set(T0 + DRIFT_EVERY);
    await watch.check(clock);
    await watch.settled();
    expect(watch.failure("host-a")).toBe("The drift check host-a failed: The setup check gave the exit code 4.");
    expect(watch.failure("plan-a")).toBeUndefined();
    expect(watch.drift()?.[0]?.read).toEqual({ changes: 1, steps: ["step.one"], at: T0 });
    expect(watch.health()[0]).toEqual({ what: "drift of host-a", at: T0, failed: true, next: T0 + DRIFT_EVERY + DRIFT_RETRY });
    clock.set(T0 + DRIFT_EVERY + DRIFT_RETRY);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls.map((call) => call[0])).toEqual(["check-host", "plan-host", "check-host", "plan-host", "check-host"]);
    expect(watch.failure("host-a")).toBeUndefined();
    watch.shift(60_000);
    expect(watch.drift()?.[0]).toMatchObject({ since: T0 + 60_000, read: { at: T0 + DRIFT_EVERY + DRIFT_RETRY + 60_000 } });
    expect(watch.nextReadAt()).toBe(T0 + 2 * DRIFT_EVERY + 60_000);
  });

  it("ends a command at the end of the life of the runtime, and the read is not a failure", async () => {
    const clock = fakeWallClock(T0);
    const life = new AbortController();
    const run: DriftRunner = (_argv, aborted) => new Promise((resolve) => aborted.addEventListener("abort", () => resolve({ exitCode: 1, stdout: "" }), { once: true }));
    const watch = driftWatch({ commands: [SETUP], run });
    await watch.check(clock, undefined, life.signal);
    life.abort();
    await watch.settled();
    expect(watch.failure("host-a")).toBeUndefined();
    expect(watch.drift()).toEqual([{ name: "host-a", maxAge: DRIFT_MAX_AGE, since: T0 }]);
  });

  // The scope of a pass closes at the end of the pass. Its signal cut each command after 3 s on the home copy (AL-139).
  it("does not end a command at the end of the signal of its pass", async () => {
    const clock = fakeWallClock(T0);
    const pass = new AbortController();
    let release: () => void = () => undefined;
    const run: DriftRunner = (_argv, aborted) =>
      new Promise((resolve) => {
        release = () => resolve({ exitCode: 0, stdout: "ok: step.one\n" });
        aborted.addEventListener("abort", () => resolve({ exitCode: 1, stdout: "" }), { once: true });
      });
    const watch = driftWatch({ commands: [SETUP], run });
    await watch.check(clock, pass.signal, new AbortController().signal);
    pass.abort();
    release();
    await watch.settled();
    expect(watch.health()).toEqual([{ what: "drift of host-a", at: T0, failed: false, next: T0 + DRIFT_EVERY }]);
  });

  it("refuses a bad time and two checks with one name", () => {
    const { run } = scripted({});
    expect(() => driftWatch({ commands: [SETUP], run, every: 0 })).toThrow(/every/);
    expect(() => driftWatch({ commands: [SETUP], run, limit: 1.5 })).toThrow(/limit/);
    expect(() => driftWatch({ commands: [SETUP, { ...PLAN, name: "host-a" }], run })).toThrow(/same name/);
  });
});
