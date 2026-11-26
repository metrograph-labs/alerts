import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeReport, deployEndProblem, parseRunningCode, readRunningCode, recordRunningCode, runningCode, type RunningCode } from "./running.ts";
import { DEPLOY_FILE, slotsOf, STAGE_CHECKS, type LiveState } from "./slots.ts";

const SHA = "09f542f".padEnd(40, "0");
const marks = { format: 1 as const, marks: { a: { sha: SHA, at: "2026-11-24T18:58:17.430Z", checks: [...STAGE_CHECKS] } } };
const linkTo = (slot: "a" | "b" | undefined): LiveState => ({ kind: "link", target: "live-x", slot });
const record: RunningCode = { format: 1, pid: 42, at: "2026-11-24T19:01:48.000Z", slot: "a", commit: SHA };

describe("the record of the running code (AL-167)", () => {
  it("gives the slot of the real path of the checkout and the commit of its stage", () => {
    const slots = slotsOf("/x/live");
    expect(runningCode(slots, "/x/live-a", marks, 42, record.at, "linux")).toEqual(record);
    expect(runningCode(slots, "/x/live-b", marks, 42, record.at, "linux")).toEqual({ ...record, slot: "b", commit: undefined });
    expect(runningCode(slots, "/y/other", marks, 42, record.at, "linux")).toEqual({ ...record, slot: undefined, commit: undefined });
  });

  it("reads only a good record", () => {
    expect(parseRunningCode(JSON.stringify(record))).toEqual(record);
    expect(parseRunningCode(JSON.stringify({ ...record, slot: undefined, commit: undefined }))).toEqual({ ...record, slot: undefined, commit: undefined });
    expect(parseRunningCode(undefined)).toBeUndefined();
    expect(parseRunningCode("{")).toBeUndefined();
    expect(parseRunningCode("null")).toBeUndefined();
    expect(parseRunningCode(JSON.stringify({ ...record, format: 2 }))).toBeUndefined();
    expect(parseRunningCode(JSON.stringify({ ...record, pid: "42" }))).toBeUndefined();
    expect(parseRunningCode(JSON.stringify({ ...record, slot: "c" }))).toBeUndefined();
    expect(parseRunningCode(JSON.stringify({ ...record, commit: 7 }))).toBeUndefined();
  });

  it("tells a runtime of the other slot, as after the crossed swaps of 2026-11-24", () => {
    expect(codeReport(linkTo("a"), record, 42)).toMatchObject({ kind: "same" });
    expect(codeReport(linkTo("a"), record, 42).line).toContain("runs slot a (09f542f)");
    const other = codeReport(linkTo("b"), record, 42);
    expect(other.kind).toBe("other");
    expect(other.line).toContain("the live path is a link to slot b");
    // A record of another process is old: the new runtime wrote none.
    expect(codeReport(linkTo("a"), record, 43).kind).toBe("unknown");
    expect(codeReport(linkTo("a"), undefined).kind).toBe("unknown");
    expect(codeReport(linkTo("a"), { ...record, slot: undefined }).kind).toBe("unknown");
    expect(codeReport({ kind: "folder" }, record).kind).toBe("unknown");
    // With no process, the record of the last start counts.
    expect(codeReport(linkTo("a"), record).kind).toBe("same");
  });

  describe("on the file system", () => {
    let top = "";
    beforeEach(async () => {
      top = await mkdtemp(join(tmpdir(), "alerts-running-"));
    });
    afterEach(async () => {
      await rm(top, { recursive: true, force: true });
    });

    it("resolves the live link of the start, and writes a record that the deploy reads", async () => {
      const slots = slotsOf(join(top, "live"));
      await mkdir(slots.a);
      await symlink(slots.a, slots.live, "junction");
      const host = join(top, "host");
      await mkdir(host);
      await writeFile(join(host, DEPLOY_FILE), JSON.stringify(marks));
      const written = await recordRunningCode(slots, slots.live, host, 42, new Date(record.at));
      expect(written).toEqual(record);
      expect(await readRunningCode(host)).toEqual(record);
      expect(await readRunningCode(join(top, "none"))).toBeUndefined();
    });
  });
});

describe("the end of a deploy (AL-186)", () => {
  const record: RunningCode = { format: 1, pid: 7, at: "2026-11-26T04:00:00.000Z", slot: "b", commit: "f998797abcdef" };
  const began = Date.parse("2026-11-26T03:59:00.000Z");

  it("passes a runtime on the new commit with a start after the begin", () => {
    expect(deployEndProblem(record, "f998797", began)).toBeUndefined();
  });

  it("refuses old code, an old start and no record", () => {
    expect(deployEndProblem(record, "3d5aea2", began)).toBe("The runtime runs f998797, not 3d5aea2.");
    expect(deployEndProblem(record, "f998797", Date.parse("2026-11-26T04:01:00.000Z"))).toContain("before the deploy");
    expect(deployEndProblem({ ...record, commit: undefined }, "f998797", began)).toContain("no stage");
    expect(deployEndProblem(undefined, "f998797", began)).toContain("no record");
  });
});
