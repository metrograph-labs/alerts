import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Integrity } from "@mark1russell7/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { LOG_CHECK_PERIOD, logChecker, logCheckPath, logCheckText, parseLogCheck, type LogCheckPorts, type LogCheckState } from "./log-check.ts";
import { openCheckedRuntimeLog, openRuntimeLog } from "./log.ts";

const T0 = Date.UTC(2026, 11, 1, 12);
const HOUR = 3_600_000;
const LOG_FILE = "runtime.sqlite";
// The index on the type of the events. Its broken root page leaves the table readable with no index.
const TYPE_INDEX = "events_type";

// This function writes 0 in the first byte of the root page of the type index. Then only an integrity check finds the fault.
function breakTypeIndex(path: string): void {
  const db = openDatabase(path);
  let page: number;
  let size: number;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    size = Number(db.prepare("PRAGMA page_size").get()?.["page_size"]);
    page = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?").get(TYPE_INDEX)?.["rootpage"]);
  } finally {
    db.close();
  }
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Uint8Array.of(0), 0, 1, (page - 1) * size);
  } finally {
    closeSync(fd);
  }
}

describe("the open of the log with the state file of the check (AL-223)", () => {
  let folder: string;
  let path: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "alerts-log-check-"));
    path = join(folder, LOG_FILE);
    // A log with three events, closed.
    const log = openRuntimeLog(path);
    const events: RuntimeEvent[] = [0, 1, 2].map((index) => ({ ...envelope("started", `started:run-${String(index)}`, T0 + index), run: `run-${String(index)}` }));
    log.appendAll(events, () => undefined);
    log.close();
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const writeState = (state: LogCheckState): void => writeFileSync(logCheckPath(path), logCheckText(state));
  const open = (at = T0 + HOUR) => openCheckedRuntimeLog(path, { now: () => at });

  it("does the blocking check with no state file", () => {
    const opened = open();
    try {
      expect(opened.checked).toBe(true);
      expect(opened.log.count()).toBe(3);
    } finally {
      opened.log.close();
    }
  });

  it("does no blocking check after a passed check, thus a broken index stays in place", () => {
    writeState({ state: "passed", at: T0 });
    breakTypeIndex(path);
    const opened = open();
    try {
      expect(opened.checked).toBe(false);
      expect(opened.recovered).toBeUndefined();
    } finally {
      opened.log.close();
    }
    expect(readdirSync(folder).filter((name) => name.includes(".broken-"))).toEqual([]);
  });

  it.each(["running", "failed"] as const)("does the blocking check after %s, and recovers a broken file", (state) => {
    writeState({ state, at: T0, ...(state === "failed" ? { problems: ["a problem"] } : {}) });
    breakTypeIndex(path);
    const opened = open();
    try {
      expect(opened.checked).toBe(true);
      expect(opened.recovered).toMatchObject({ type: "recovered", fault: "corrupt", added: 3, lost: 0 });
      expect(opened.log.count()).toBe(4);
    } finally {
      opened.log.close();
    }
    expect(readdirSync(folder).filter((name) => name.includes(".broken-"))).toHaveLength(1);
  });

  it("does the blocking check with a bad state file", () => {
    writeFileSync(logCheckPath(path), "{ not json");
    const opened = open();
    try {
      expect(opened.checked).toBe(true);
    } finally {
      opened.log.close();
    }
  });

  it("still recovers a file that is not a database with no blocking check", () => {
    writeState({ state: "passed", at: T0 });
    writeFileSync(path, "This file is not a database. ".repeat(200));
    const opened = open();
    try {
      expect(opened.recovered).toMatchObject({ fault: "not-a-database" });
      expect(opened.checked).toBe(true);
    } finally {
      opened.log.close();
    }
  });
});

describe("the state file of the check (AL-223)", () => {
  it("reads back each state that it writes, and refuses a bad text", () => {
    const failed: LogCheckState = { state: "failed", at: T0, problems: ["one", "two"] };
    expect(parseLogCheck(logCheckText(failed))).toEqual(failed);
    expect(parseLogCheck(logCheckText({ state: "passed", at: T0 }))).toEqual({ state: "passed", at: T0 });
    expect(JSON.parse(logCheckText({ state: "running", at: T0 }))).toEqual({ state: "running", at: "2026-12-01T12:00:00.000Z" });
    expect(parseLogCheck("[]")).toBeUndefined();
    expect(parseLogCheck(JSON.stringify({ state: "done", at: "2026-12-01T12:00:00.000Z" }))).toBeUndefined();
    expect(parseLogCheck(JSON.stringify({ state: "passed", at: "not a time" }))).toBeUndefined();
  });
});

describe("the check of the log after the start (AL-223)", () => {
  // The fake ports: a clock, a state file in memory, and a check that gives the result of `result`.
  function harness(options: { readonly file?: LogCheckState; readonly checkedAt?: number; readonly result?: Integrity | Error | "hang" } = {}) {
    let now = T0;
    let file = options.file === undefined ? undefined : logCheckText(options.file);
    const writes: LogCheckState[] = [];
    const failures: unknown[] = [];
    const errors: string[] = [];
    let checks = 0;
    const stop = new AbortController();
    const ports: LogCheckPorts = {
      now: () => now,
      read: () => Promise.resolve(file),
      write: (text) => {
        file = text;
        writes.push(parseLogCheck(text)!);
        return Promise.resolve();
      },
      check: (signal) => {
        checks += 1;
        const result = options.result ?? { ok: true, problems: [] };
        if (result === "hang") {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason as Error));
          });
        }
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
      onFailed: (integrity) => failures.push(integrity),
      onError: (message) => errors.push(message),
    };
    const checker = logChecker(ports, { checkedAt: options.checkedAt, signal: stop.signal });
    return {
      checker,
      stop,
      writes,
      failures,
      errors,
      checks: () => checks,
      state: () => (file === undefined ? undefined : parseLogCheck(file)),
      move: (to: number) => {
        now = to;
      },
    };
  }

  it("writes passed with the time of the open after a blocking check of the start, and checks one period later", async () => {
    const run = harness({ checkedAt: T0 - 1_000 });
    expect(await run.checker.step()).toEqual({ kind: "start-check" });
    expect(run.state()).toEqual({ state: "passed", at: T0 - 1_000 });
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    run.move(T0 - 1_000 + LOG_CHECK_PERIOD);
    expect(await run.checker.step()).toEqual({ kind: "passed" });
    expect(run.checks()).toBe(1);
  });

  it("starts no check when the last pass is less than one period old", async () => {
    const run = harness({ file: { state: "passed", at: T0 - LOG_CHECK_PERIOD + HOUR } });
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    run.move(T0 + HOUR - 1);
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    expect(run.checks()).toBe(0);
    expect(run.writes).toEqual([]);
  });

  it("checks after an older pass: it writes running, then passed with the time of the start of the check", async () => {
    const run = harness({ file: { state: "passed", at: T0 - LOG_CHECK_PERIOD } });
    expect(await run.checker.step()).toEqual({ kind: "passed" });
    expect(run.writes).toEqual([
      { state: "running", at: T0 },
      { state: "passed", at: T0 },
    ]);
    expect(run.checker.failed()).toBeNull();
    // The next step in the period starts no second check.
    run.move(T0 + HOUR);
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    expect(run.checks()).toBe(1);
  });

  it("writes failed with the problems, and gives one failure for the system report", async () => {
    const run = harness({ file: { state: "passed", at: T0 - 2 * LOG_CHECK_PERIOD }, result: { ok: false, problems: ["Tree 4 page 9: a bad page"] } });
    const outcome = await run.checker.step();
    expect(outcome).toEqual({ kind: "failed", integrity: { at: T0, problems: ["Tree 4 page 9: a bad page"] } });
    expect(run.state()).toEqual({ state: "failed", at: T0, problems: ["Tree 4 page 9: a bad page"] });
    expect(run.failures).toEqual([{ at: T0, problems: ["Tree 4 page 9: a bad page"] }]);
    // The failure stays the same at each later step, thus the system report has one line with the same facts.
    run.move(T0 + HOUR);
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    expect(run.checker.failed()).toEqual({ at: T0, problems: ["Tree 4 page 9: a bad page"] });
    expect(run.failures).toHaveLength(1);
  });

  it("keeps running after a fault of the check, and tells the fault", async () => {
    const run = harness({ file: { state: "passed", at: T0 - LOG_CHECK_PERIOD }, result: new Error("disk I/O error") });
    expect(await run.checker.step()).toMatchObject({ kind: "error" });
    expect(run.state()).toEqual({ state: "running", at: T0 });
    expect(run.errors).toEqual(["The integrity check of the log failed: disk I/O error"]);
    // A fault starts no second check in the period.
    expect(await run.checker.step()).toEqual({ kind: "not-due" });
    expect(run.checks()).toBe(1);
  });

  it("keeps running after an abort at the stop, thus the next start does the blocking check", async () => {
    const run = harness({ file: { state: "passed", at: T0 - LOG_CHECK_PERIOD }, result: "hang" });
    const step = run.checker.step();
    // A second step while the check runs starts no check.
    expect(await run.checker.step()).toEqual({ kind: "busy" });
    run.stop.abort(new Error("The runtime stops."));
    expect(await step).toEqual({ kind: "aborted" });
    expect(run.state()).toEqual({ state: "running", at: T0 });
    expect(run.errors).toEqual([]);
    run.move(T0 + 2 * LOG_CHECK_PERIOD);
    expect(await run.checker.step()).toEqual({ kind: "aborted" });
    expect(run.checks()).toBe(1);
  });

  it("checks at once when the state file is not there after an open with no check", async () => {
    const run = harness();
    expect(await run.checker.step()).toEqual({ kind: "passed" });
    expect(run.checks()).toBe(1);
  });

  it("writes the state file next to the log", () => {
    expect(logCheckPath(join("home", LOG_FILE))).toBe(join("home", `${LOG_FILE}.check.json`));
  });
});
