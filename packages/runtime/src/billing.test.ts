import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { NO_SYSTEM_LINES, systemReports, type CopyBillingConfig, type CopyPeer, type CopyWatch, type SystemLines } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { BILLING_LIMIT, BILLING_RETRY, BILLING_RETRY_CAP, billingOf, billingRetryAfter, billingWatch } from "./billing.ts";
import type { CommandOutput, DriftRunner } from "./drift.ts";

const T0 = Date.UTC(2026, 10, 24, 12);
const MAX_AGE = 5 * 60_000;
const UNREAD_AT = T0 + MAX_AGE;
const BILLING: CopyBillingConfig = { argv: ["cloudctl", "billing", "describe", "--format=json"], field: "billing.enabled", stoppedWhen: [false] };
const PEER: CopyPeer = { id: "cloud", url: "http://cloud.example:4751", billing: BILLING };
const PLAIN: CopyPeer = { id: "spare", url: "http://spare.example:4751" };
const json = (value: unknown): CommandOutput => ({ exitCode: 0, stdout: JSON.stringify(value) });
const STOPPED = json({ billing: { enabled: false } });
const ON = json({ billing: { enabled: true } });
const FAILED: CommandOutput = { exitCode: 2, stdout: "a secret detail" };

// The watch of a copy with no read that passed: it reaches `unread` at `UNREAD_AT`. A read at `readAt` ends the down time.
function copies(readAt?: () => number | undefined) {
  const watchOf = (copy: string): CopyWatch => {
    const at = readAt?.();
    return { copy, skewLimit: 2_000, maxAge: MAX_AGE, since: T0, ...(at === undefined ? {} : { read: { at, skew: 0, sameConfig: true } }) };
  };
  return { watches: () => [watchOf("cloud"), watchOf("spare")] };
}

// A runner that gives the next output of a list, and records each argv. The last output repeats.
function scripted(outputs: readonly (CommandOutput | Error)[]) {
  const calls: string[][] = [];
  const run: DriftRunner = async (argv) => {
    calls.push([...argv]);
    const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
    if (output === undefined || output instanceof Error) throw output ?? new Error("no output");
    return output;
  };
  return { run, calls };
}

describe("the billing state from the output of a billing read", () => {
  it("gives stopped for a value of the stop, on for each other value, and unread for a failed read", () => {
    expect(billingOf(BILLING, STOPPED)).toEqual({ state: "stopped" });
    expect(billingOf(BILLING, ON)).toEqual({ state: "on" });
    // Each provider command that prints JSON works: a text field, and more than one value of a stop.
    const status: CopyBillingConfig = { argv: ["cloudctl"], field: "account.status", stoppedWhen: ["CLOSED", "SUSPENDED"] };
    expect(billingOf(status, json({ account: { status: "SUSPENDED" } }))).toEqual({ state: "stopped" });
    expect(billingOf(status, json({ account: { status: "OPEN" } }))).toEqual({ state: "on" });
    expect(billingOf({ ...status, field: "code", stoppedWhen: [0] }, json({ code: 0 }))).toEqual({ state: "stopped" });
    expect(billingOf({ ...status, field: "code", stoppedWhen: [0] }, json({ code: "0" }))).toEqual({ state: "on" });
  });

  it("gives unread with a message that holds no output for each failed read", () => {
    const messages = [
      billingOf(BILLING, { exitCode: 1, stdout: "", notStarted: true }),
      billingOf(BILLING, { exitCode: 1, stdout: "", timedOut: true }),
      billingOf(BILLING, { ...STOPPED, truncated: true }),
      billingOf(BILLING, FAILED),
      billingOf(BILLING, { exitCode: 0, stdout: "a secret detail" }),
      billingOf(BILLING, json({ billing: {} })),
      billingOf(BILLING, json({ billing: "a secret detail" })),
      billingOf(BILLING, json({ billing: { enabled: null } })),
      billingOf(BILLING, json({ billing: { enabled: { secret: "detail" } } })),
      billingOf(BILLING, json([false])),
    ].map((reading) => (reading.state === "unread" ? reading.message : reading.state));
    expect(messages).toEqual([
      "The program of the billing read did not start.",
      "The billing read took longer than its limit.",
      "The output of the billing read is longer than 4194304 bytes.",
      "The billing read gave the exit code 2.",
      "The output of the billing read is not valid JSON.",
      "The output of the billing read has no value at its field.",
      "The output of the billing read has no value at its field.",
      "The value at the field of the billing read is not a text, a number or a boolean.",
      "The value at the field of the billing read is not a text, a number or a boolean.",
      "The output of the billing read has no value at its field.",
    ]);
    expect(messages.some((message) => message.includes("secret"))).toBe(false);
    // A field of the prototype is not a field of the output.
    expect(billingOf({ ...BILLING, field: "constructor" }, json({}))).toMatchObject({ state: "unread" });
  });

  it("doubles the time after each failed read, up to the cap", () => {
    expect([1, 2, 3, 4, 5, 100].map((failures) => billingRetryAfter(failures))).toEqual([BILLING_RETRY, 2 * BILLING_RETRY, 4 * BILLING_RETRY, 8 * BILLING_RETRY, BILLING_RETRY_CAP, BILLING_RETRY_CAP]);
  });
});

describe("the billing watch", () => {
  // The scope of a pass closes at the end of the pass. A read in the background stops only at the end of `life` (AL-139).
  it("does not end a read at the end of the signal of its pass, and ends it at the end of life", async () => {
    const clock = fakeWallClock(T0);
    let release: () => void = () => undefined;
    const signals: AbortSignal[] = [];
    const run: DriftRunner = (_argv, signal) =>
      new Promise((resolve) => {
        signals.push(signal);
        release = () => resolve(STOPPED);
        signal.addEventListener("abort", () => resolve({ exitCode: 1, stdout: "" }), { once: true });
      });
    const watch = billingWatch({ peers: [PEER], copies: copies(), run });
    clock.set(UNREAD_AT);
    const pass = new AbortController();
    const life = new AbortController();
    await watch.check(clock, pass.signal, life.signal);
    pass.abort();
    expect(signals[0]?.aborted).toBe(false);
    release();
    await watch.settled();
    expect(watch.watches()[0]).toEqual(expect.objectContaining({ copy: "cloud", billing: { state: "stopped", at: UNREAD_AT } }));
    const ended = billingWatch({ peers: [PEER], copies: copies(), run });
    await ended.check(clock, undefined, life.signal);
    life.abort();
    await ended.settled();
    expect(signals[1]?.aborted).toBe(true);
    expect(ended.health()).toEqual([{ what: "billing of cloud", at: null, failed: false, next: null }]);
  });

  it("reads only a down copy with a billing read, one time in its down time, and does not wait for the read", async () => {
    const clock = fakeWallClock(T0);
    const runner = scripted([STOPPED]);
    let reads = 0;
    const watch = billingWatch({ peers: [PEER, PLAIN], copies: copies(), run: runner.run, onRead: () => (reads += 1) });
    expect(watch.nextReadAt()).toBeUndefined();
    // The copy answers until its maximum age: no read.
    await watch.check(clock);
    expect(runner.calls).toEqual([]);
    expect(watch.nextReadAt()).toBeUndefined();
    clock.set(UNREAD_AT);
    await watch.check(clock);
    // The check started the read, and the watch keeps the time of its end as the next time of a pass.
    expect(watch.nextReadAt()).toBe(UNREAD_AT + BILLING_LIMIT);
    await watch.settled();
    expect(runner.calls).toEqual([["cloudctl", "billing", "describe", "--format=json"]]);
    expect(reads).toBe(1);
    expect(watch.watches()).toEqual([expect.objectContaining({ copy: "cloud", billing: { state: "stopped", at: UNREAD_AT } }), expect.not.objectContaining({ billing: expect.anything() })]);
    // A read that passed is the only read of the down time.
    clock.set(UNREAD_AT + BILLING_RETRY_CAP);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls).toHaveLength(1);
    expect(watch.nextReadAt()).toBeUndefined();
    expect(watch.health()).toEqual([{ what: "billing of cloud", at: UNREAD_AT, failed: false, next: null }]);
  });

  it("tries again after a failed read with a longer wait each time, and keeps the state unread until a read passes", async () => {
    const clock = fakeWallClock(UNREAD_AT);
    const runner = scripted([FAILED, new Error("a secret detail"), ON]);
    const watch = billingWatch({ peers: [PEER], copies: copies(), run: runner.run });
    await watch.check(clock);
    await watch.settled();
    expect(watch.watches()[0]?.billing).toEqual({ state: "unread", at: UNREAD_AT });
    expect(watch.failure("cloud")).toBe("The billing read gave the exit code 2.");
    expect(watch.nextReadAt()).toBe(UNREAD_AT + BILLING_RETRY);
    clock.set(UNREAD_AT + BILLING_RETRY - 1);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls).toHaveLength(1);
    clock.set(UNREAD_AT + BILLING_RETRY);
    await watch.check(clock);
    await watch.settled();
    expect(watch.failure("cloud")).toBe("The billing read failed to run.");
    const second = UNREAD_AT + BILLING_RETRY;
    expect(watch.nextReadAt()).toBe(second + 2 * BILLING_RETRY);
    expect(watch.health()).toEqual([{ what: "billing of cloud", at: null, failed: true, next: second + 2 * BILLING_RETRY }]);
    clock.set(second + 2 * BILLING_RETRY);
    await watch.check(clock);
    await watch.settled();
    expect(runner.calls).toHaveLength(3);
    expect(watch.watches()[0]?.billing).toEqual({ state: "on", at: second + 2 * BILLING_RETRY });
    expect(watch.failure("cloud")).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
  });

  it("ends the down time at a read of the copy that passes, drops a read in flight, and reads again in the next down time", async () => {
    const clock = fakeWallClock(UNREAD_AT);
    let readAt: number | undefined;
    const releases: ((output: CommandOutput) => void)[] = [];
    const run: DriftRunner = () => new Promise((resolve) => releases.push(resolve));
    const watch = billingWatch({ peers: [PEER], copies: copies(() => readAt), run });
    await watch.check(clock);
    expect(releases).toHaveLength(1);
    // A second check while the read runs starts no second read.
    await watch.check(clock);
    expect(releases).toHaveLength(1);
    // The copy answers before the read ends: the read changes nothing.
    readAt = UNREAD_AT + 1_000;
    clock.set(UNREAD_AT + 1_000);
    await watch.check(clock);
    releases[0]?.(STOPPED);
    await watch.settled();
    expect(watch.watches()[0]?.billing).toBeUndefined();
    // The next down time reads again.
    clock.set(readAt + MAX_AGE);
    await watch.check(clock);
    expect(releases).toHaveLength(2);
    releases[1]?.(STOPPED);
    await watch.settled();
    expect(watch.watches()[0]?.billing).toEqual({ state: "stopped", at: readAt + MAX_AGE });
  });

  it("gives unread after the time limit, ignores a read that the close of the runtime ended, and moves its times at a step of the clock", async () => {
    const clock = fakeWallClock(UNREAD_AT);
    const hang: DriftRunner = (_argv, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: 1, stdout: "" }), { once: true }));
    const late = billingWatch({ peers: [PEER], copies: copies(), run: hang });
    await late.check(clock);
    await clock.advance(BILLING_LIMIT);
    await late.settled();
    expect(late.failure("cloud")).toBe(`The billing read took longer than ${String(BILLING_LIMIT)} ms.`);
    late.shift(60_000);
    expect(late.watches()[0]?.billing).toEqual({ state: "unread", at: UNREAD_AT + BILLING_LIMIT + 60_000 });
    expect(late.nextReadAt()).toBe(UNREAD_AT + BILLING_LIMIT + BILLING_RETRY + 60_000);
    const life = new AbortController();
    const stopped = billingWatch({ peers: [PEER], copies: copies(), run: hang });
    await stopped.check(clock, undefined, life.signal);
    life.abort();
    await stopped.settled();
    expect(stopped.failure("cloud")).toBeUndefined();
    expect(stopped.watches()[0]?.billing).toBeUndefined();
  });

  it("refuses a bad time", () => {
    expect(() => billingWatch({ peers: [PEER], copies: copies(), retry: 0 })).toThrow(/retry/);
    expect(() => billingWatch({ peers: [PEER], copies: copies(), limit: 1.5 })).toThrow(/limit/);
  });
});

describe("the alarm of a down copy with the billing watch", () => {
  it("goes out at once with no billing state, and a billing stop follows as an update of the same line", async () => {
    const clock = fakeWallClock(UNREAD_AT);
    const releases: ((output: CommandOutput) => void)[] = [];
    const run: DriftRunner = () => new Promise((resolve) => releases.push(resolve));
    const watch = billingWatch({ peers: [PEER], copies: copies(), run });
    // The pass starts the check next to its fetches, and then it makes its view. The read is still in flight.
    let lines: SystemLines = NO_SYSTEM_LINES;
    const view = () => {
      const step = systemReports(lines, { sources: [], health: [], coverage: [], threats: [], copies: watch.watches().filter((one) => one.copy === "cloud") }, clock.now());
      lines = step.lines;
      return step.reports.map((report) => ({ op: report.op, code: report.kind.code, headline: report.headline, billing: report.parameters["billing"] }));
    };
    await watch.check(clock);
    const since = `No read of the copy cloud passed since the start of the watch at ${new Date(T0).toISOString()}.`;
    expect(view()).toEqual([{ op: "alert", code: "system.copy.unread", headline: since, billing: undefined }]);
    releases[0]?.(STOPPED);
    await watch.settled();
    clock.set(UNREAD_AT + 1_000);
    await watch.check(clock);
    expect(view()).toEqual([{ op: "update", code: "system.copy.unread", headline: `The copy cloud is down because of a billing stop of its host. ${since}`, billing: ["stopped"] }]);
    // The next passes send nothing more.
    expect(view()).toEqual([]);
  });
});
