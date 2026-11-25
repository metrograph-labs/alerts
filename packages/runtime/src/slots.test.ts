import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHostPorts } from "@mark1russell7/service/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLD_VERSION } from "./start-snapshot.ts";
import {
  adoptLive,
  checkoutOf,
  entryRoot,
  FOLD_FILE,
  foldChange,
  keyChange,
  keyStep,
  startKeysOf,
  foldStep,
  foldVersionOf,
  foreignLinks,
  insideFolder,
  installArgs,
  liveRoot,
  loadStep,
  otherSlot,
  parseDeployFile,
  parseSwapTarget,
  pnpmCall,
  readLive,
  readPackageLinks,
  runStep,
  samePath,
  SERVICE_PACKAGE,
  stageScope,
  slotOfTarget,
  slotsOf,
  slotsOfCheckout,
  STAGE_CHECKS,
  SUPERVISOR_FILES,
  supervisorChanges,
  swapLink,
  swapRefusal,
  withDeployLock,
  withMark,
  type LiveState,
  type StageMark,
} from "./slots.ts";

const SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const goodMark: StageMark = { sha: SHA, at: "2026-11-19T02:00:00.000Z", checks: [...STAGE_CHECKS] };
const linkTo = (slot: "a" | "b" | undefined): LiveState => ({ kind: "link", target: "live-x", slot });
const TO_B = { slot: "b", commit: SHA.slice(0, 7) } as const;

describe("the names and paths of the slots (AL-89)", () => {
  it("gives two slots next to the live path, and the other slot of each", () => {
    expect(slotsOf(join("top", "live"))).toEqual({ live: join("top", "live"), a: join("top", "live-a"), b: join("top", "live-b") });
    expect(otherSlot("a")).toBe("b");
    expect(otherSlot("b")).toBe("a");
  });

  it("gives the folder of the package from the path of an entry, and the fallback for another path", () => {
    const entry = join("top", "live", "packages", "runtime", "src", "main.ts");
    expect(entryRoot(entry, "fallback")).toBe(join("top", "live", "packages", "runtime"));
    expect(entryRoot(undefined, "fallback")).toBe("fallback");
    expect(entryRoot(join("top", "live", "packages", "runtime", "main.ts"), "fallback")).toBe("fallback");
    expect(entryRoot(join("top", "src", "notes.txt"), "fallback")).toBe("fallback");
    expect(checkoutOf(join("top", "live", "packages", "runtime"))).toBe(join("top", "live"));
  });

  it("takes the live path from ALERTS_LIVE in place of the path of the entry, for a first deploy", () => {
    const entry = join("top", "live-b", "packages", "runtime", "src", "deploy.ts");
    const live = join("top", "live");
    expect(liveRoot({ ALERTS_LIVE: live }, entry, "fallback")).toBe(join(live, "packages", "runtime"));
    expect(checkoutOf(liveRoot({ ALERTS_LIVE: live }, entry, "fallback"))).toBe(live);
    // With no variable, or an empty one, the entry gives the folder, as before.
    expect(liveRoot({}, entry, "fallback")).toBe(join("top", "live-b", "packages", "runtime"));
    expect(liveRoot({ ALERTS_LIVE: "" }, entry, "fallback")).toBe(join("top", "live-b", "packages", "runtime"));
    expect(liveRoot({ ALERTS_LIVE: live }, undefined, "fallback")).toBe(join(live, "packages", "runtime"));
  });

  it("compares paths with no case on Windows, and with the case elsewhere", () => {
    expect(samePath("C:\\Git\\Live-A\\", "\\\\?\\c:\\git\\live-a", "win32")).toBe(true);
    expect(samePath("/srv/Live-a", "/srv/live-a", "linux")).toBe(false);
    expect(samePath("/srv/live-a/", "/srv/live-a", "linux")).toBe(true);
  });

  it("finds the slot of a relative or a full target, and no slot for another folder", () => {
    const slots = slotsOf(join(tmpdir(), "live"));
    expect(slotOfTarget(slots, "live-b")).toBe("b");
    expect(slotOfTarget(slots, slots.a)).toBe("a");
    expect(slotOfTarget(slots, join(tmpdir(), "elsewhere"))).toBeUndefined();
  });
});

describe("the swap of the live link on the file system (AL-89)", () => {
  let top = "";
  beforeEach(async () => {
    top = await mkdtemp(join(tmpdir(), "alerts-slots-"));
  });
  afterEach(async () => {
    await rm(top, { recursive: true, force: true });
  });

  it("adopts a checkout as slot a, and swaps the link to slot b and back with each slot kept", async () => {
    const slots = slotsOf(join(top, "live"));
    await mkdir(slots.live);
    await writeFile(join(slots.live, "marker"), "a");
    expect(await readLive(slots)).toEqual({ kind: "folder" });

    await adoptLive(slots);
    expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "a" });
    expect(await readFile(join(slots.live, "marker"), "utf8")).toBe("a");

    await mkdir(slots.b);
    await writeFile(join(slots.b, "marker"), "b");
    await swapLink(slots.live, slots.b);
    expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "b" });
    expect(await readFile(join(slots.live, "marker"), "utf8")).toBe("b");
    expect(await readFile(join(slots.a, "marker"), "utf8")).toBe("a");

    await swapLink(slots.live, slots.a);
    expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "a" });
    // The swap leaves no temporary link.
    expect((await readdir(top)).sort()).toEqual(["live", "live-a", "live-b"]);
  });

  it("finds the live link of a checkout that is the real path of a slot (AL-169)", async () => {
    const slots = slotsOf(join(top, "live"));
    await mkdir(slots.a);
    await mkdir(slots.b);
    await swapLink(slots.live, slots.b);
    // A unit in the live folder runs in the real path of slot b.
    expect(await slotsOfCheckout(slots.b)).toEqual(slots);
    expect(await slotsOfCheckout(slots.live)).toEqual(slots);
    // Slot a is not the target of the link, thus it is a checkout of its own.
    expect(await slotsOfCheckout(slots.a)).toEqual(slotsOf(slots.a));
    // A folder with a name like a slot and no link next to it is a checkout of its own.
    const other = join(top, "repo-b");
    await mkdir(other);
    expect(await slotsOfCheckout(other)).toEqual(slotsOf(other));
  });

  it("starts each process through the link in the slot that the link names at its start", async () => {
    const slots = slotsOf(join(top, "live"));
    for (const name of ["a", "b"] as const) {
      await mkdir(slots[name]);
      await writeFile(join(slots[name], "marker"), name);
    }
    // The supervisor gives each start the live path as its folder, as `hostGroup` does with the root of `entryRoot`.
    const start = (): string => spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync('marker', 'utf8'))"], { cwd: slots.live, encoding: "utf8" }).stdout;
    await swapLink(slots.live, slots.a);
    expect(start()).toBe("a");
    await swapLink(slots.live, slots.b);
    expect(start()).toBe("b");
  });

  it("refuses to swap a live path that is a folder, and to adopt a link or over an existing slot a", async () => {
    const slots = slotsOf(join(top, "live"));
    await mkdir(slots.live);
    await mkdir(slots.b);
    await expect(swapLink(slots.live, slots.b)).rejects.toThrow("not a link");
    await mkdir(slots.a);
    await expect(adoptLive(slots)).rejects.toThrow("Slot a exists");
    await rm(slots.live, { recursive: true });
    await swapLink(slots.live, slots.a);
    await expect(adoptLive(slots)).rejects.toThrow("a link already");
  });
});

describe("the marks of a stage and the swap rule (AL-89)", () => {
  it("reads no mark from no file, a bad text or a bad form, and keeps only the good marks", () => {
    expect(parseDeployFile(undefined)).toEqual({ format: 1, marks: {} });
    expect(parseDeployFile("{")).toEqual({ format: 1, marks: {} });
    expect(parseDeployFile(JSON.stringify({ format: 2, marks: { a: goodMark } }))).toEqual({ format: 1, marks: {} });
    const text = JSON.stringify({ format: 1, marks: { a: goodMark, b: { sha: SHA, at: "x", checks: "install" } } });
    expect(parseDeployFile(text)).toEqual({ format: 1, marks: { a: goodMark } });
  });

  it("sets and removes the mark of one slot", () => {
    const file = withMark({ format: 1, marks: {} }, "b", goodMark);
    expect(file.marks.b).toEqual(goodMark);
    expect(withMark(file, "b", undefined)).toEqual({ format: 1, marks: {} });
  });

  it("swaps only to a slot staged at its commit with each check and no change", () => {
    const facts = { target: TO_B, live: linkTo("a"), mark: goodMark, head: SHA, clean: true };
    expect(swapRefusal(facts)).toBeUndefined();
    expect(swapRefusal({ ...facts, live: { kind: "folder" } })).toContain("adopt");
    expect(swapRefusal({ ...facts, live: linkTo(undefined) })).toContain("adopt");
    expect(swapRefusal({ ...facts, head: undefined })).toContain("Slot b has no checkout");
    expect(swapRefusal({ ...facts, mark: undefined })).toContain("no stage");
    expect(swapRefusal({ ...facts, head: OTHER_SHA })).toContain("Slot b has the commit 2222222");
    expect(swapRefusal({ ...facts, head: OTHER_SHA, target: { slot: "b", commit: OTHER_SHA.slice(0, 7) } })).toContain("no stage");
    expect(swapRefusal({ ...facts, mark: { ...goodMark, checks: ["install", "config"] } })).toContain("load");
    // A stage of the code before AL-112 step 2 wrote no file of the outage bundles. Thus a swap refuses its mark.
    expect(swapRefusal({ ...facts, mark: { ...goodMark, checks: ["install", "config", "load"] } })).toContain("bundles");
    expect(swapRefusal({ ...facts, clean: false })).toContain("changes");
  });

  it("refuses a swap when a package link of either slot resolves outside its slot (AL-144)", () => {
    const facts = { target: TO_B, live: linkTo("a"), mark: goodMark, head: SHA, clean: true };
    const bad = [{ path: "/x/live-a/node_modules/pkg", target: "/x/live/node_modules/.pnpm/pkg" }];
    expect(swapRefusal({ ...facts, foreign: { live: [], target: [] } })).toBeUndefined();
    expect(swapRefusal({ ...facts, foreign: { live: [], target: bad } })).toContain("Slot b has 1 package links outside its folder");
    expect(swapRefusal({ ...facts, foreign: { live: bad, target: [] } })).toContain("relink a");
  });
});

describe("the swap as a compare and swap with the deploy lock (AL-167)", () => {
  it("reads the target of a swap only from a slot name and the start of a commit", () => {
    expect(parseSwapTarget(["a", "09f542f"])).toEqual({ slot: "a", commit: "09f542f" });
    expect(parseSwapTarget(["b", SHA])).toEqual({ slot: "b", commit: SHA });
    expect(parseSwapTarget([])).toBeUndefined();
    expect(parseSwapTarget(["a"])).toBeUndefined();
    expect(parseSwapTarget(["c", "09f542f"])).toBeUndefined();
    expect(parseSwapTarget(["a", "09f5"])).toBeUndefined();
    expect(parseSwapTarget(["a", "main"])).toBeUndefined();
    expect(parseSwapTarget(["a", "09f542f", "x"])).toBeUndefined();
  });

  it("refuses a target that the live link names already, and a target slot with another commit", () => {
    const facts = { target: TO_B, live: linkTo("a"), mark: goodMark, head: SHA, clean: true };
    expect(swapRefusal(facts)).toBeUndefined();
    // The crossed swaps of 2026-11-24: the link names slot b after a swap of another operator, and this swap wants slot b.
    expect(swapRefusal({ ...facts, live: linkTo("b") })).toContain("a link to slot b already");
    expect(swapRefusal({ ...facts, target: { slot: "b", commit: OTHER_SHA.slice(0, 7) } })).toContain(`not ${OTHER_SHA.slice(0, 7)}`);
  });

  describe("on the file system", () => {
    let top = "";
    beforeEach(async () => {
      top = await mkdtemp(join(tmpdir(), "alerts-swap-lock-"));
    });
    afterEach(async () => {
      await rm(top, { recursive: true, force: true });
    });

    /** This function is the swap of `deploy.ts` with no stage facts: the lock, the read of the link, the compare and the change. */
    const lockedSwap = (slots: ReturnType<typeof slotsOf>, lock: string, slot: "a" | "b"): Promise<void> =>
      withDeployLock(lock, nodeHostPorts(), async () => {
        const live = await readLive(slots);
        const refusal = swapRefusal({ target: { slot, commit: SHA.slice(0, 7) }, live, mark: goodMark, head: SHA, clean: true });
        if (refusal !== undefined) throw new Error(refusal);
        await swapLink(slots.live, slots[slot]);
      });

    it("lets one of two swaps at once change the link, and refuses the other", async () => {
      const slots = slotsOf(join(top, "live"));
      await mkdir(slots.a);
      await mkdir(slots.b);
      await swapLink(slots.live, slots.b);
      const lock = join(top, "host", "deploy.lock");
      const results = await Promise.allSettled([lockedSwap(slots, lock, "a"), lockedSwap(slots, lock, "a")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(String(refused?.status === "rejected" ? refused.reason : "")).toMatch(/deploy lock|already/u);
      expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "a" });
      // The lock goes at the end of each swap. Thus the next deploy takes it.
      await expect(lockedSwap(slots, lock, "b")).resolves.toBeUndefined();
      expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "b" });
    });

    it("refuses the second of two crossed swaps, thus the link keeps the slot of the first", async () => {
      const slots = slotsOf(join(top, "live"));
      await mkdir(slots.a);
      await mkdir(slots.b);
      await swapLink(slots.live, slots.b);
      const lock = join(top, "host", "deploy.lock");
      // Two operators read slot b as live, and each wants slot a. The first swap goes. The second finds slot a live.
      await lockedSwap(slots, lock, "a");
      await expect(lockedSwap(slots, lock, "a")).rejects.toThrow("a link to slot a already");
      expect(await readLive(slots)).toMatchObject({ kind: "link", slot: "a" });
    });

    it("does no work while another live process holds the lock", async () => {
      const lock = join(top, "host", "deploy.lock");
      let ran = 0;
      await withDeployLock(lock, nodeHostPorts(), async () => {
        await expect(withDeployLock(lock, nodeHostPorts(), async () => void ran++)).rejects.toThrow("holds the deploy lock");
      });
      expect(ran).toBe(0);
      await withDeployLock(lock, nodeHostPorts(), async () => void ran++);
      expect(ran).toBe(1);
    });
  });
});

describe("the package links of a slot (AL-144)", () => {
  it("tells a path in a folder from a path next to it, on each platform", () => {
    expect(insideFolder("/x/live-a", "/x/live-a/node_modules/pkg", "linux")).toBe(true);
    expect(insideFolder("/x/live-a", "/x/live-a", "linux")).toBe(true);
    // The live path is a prefix of the name of the slot, but not a folder of it.
    expect(insideFolder("/x/live", "/x/live-a/node_modules", "linux")).toBe(false);
    expect(insideFolder("/x/live-a", "/x/live/node_modules", "linux")).toBe(false);
    expect(insideFolder("D:\\git\\live-a", "\\\\?\\d:\\GIT\\live-a\\node_modules\\pkg", "win32")).toBe(true);
    expect(insideFolder("D:\\git\\live-a", "D:\\git\\live\\node_modules\\pkg", "win32")).toBe(false);
  });

  it("gives the links whose target is outside the slot, and starts a relative target at the folder of the link", () => {
    const links = [
      { path: "/x/live-a/node_modules/one", target: "/x/live-a/node_modules/.pnpm/one" },
      { path: "/x/live-a/node_modules/two", target: ".pnpm/two" },
      { path: "/x/live-a/node_modules/three", target: "/x/live/node_modules/.pnpm/three" },
      { path: "/x/live-a/packages/core/node_modules/four", target: "../../../../live-b/node_modules/.pnpm/four" },
    ];
    expect(foreignLinks("/x/live-a", links, "linux").map((link) => link.path)).toEqual([
      "/x/live-a/node_modules/three",
      "/x/live-a/packages/core/node_modules/four",
    ]);
  });

  describe("on the file system", () => {
    let top = "";
    beforeEach(async () => {
      top = await mkdtemp(join(tmpdir(), "alerts-links-"));
    });
    afterEach(async () => {
      await rm(top, { recursive: true, force: true });
    });

    it("finds the links that an adopt leaves on the old path of the checkout", async () => {
      const slots = slotsOf(join(top, "live"));
      const store = join(slots.live, "node_modules", ".pnpm", "pkg");
      await mkdir(store, { recursive: true });
      await mkdir(join(slots.live, "node_modules", "@scope"), { recursive: true });
      await mkdir(join(slots.live, "packages", "core", "node_modules"), { recursive: true });
      // An install on Windows makes junctions with absolute targets, as these links.
      await symlink(store, join(slots.live, "node_modules", "pkg"), "junction");
      await symlink(store, join(slots.live, "node_modules", "@scope", "inner"), "junction");
      await symlink(store, join(slots.live, "packages", "core", "node_modules", "pkg"), "junction");
      expect(foreignLinks(slots.live, await readPackageLinks(slots.live))).toEqual([]);

      await adoptLive(slots);
      const links = await readPackageLinks(slots.a);
      expect(links).toHaveLength(3);
      // Each link still names the live path. After a swap to slot b, it names slot b.
      expect(foreignLinks(slots.a, links)).toHaveLength(3);
    });

    it("reads no link from a slot with no node_modules", async () => {
      await mkdir(join(top, "empty"));
      expect(await readPackageLinks(join(top, "empty"))).toEqual([]);
    });
  });
});

describe("the parts of the supervisor and the calls of pnpm (AL-89)", () => {
  const parts = Object.fromEntries([...SUPERVISOR_FILES.map((file) => [file, `hash of ${file}`]), [SERVICE_PACKAGE, "0.10.0"]]);

  it("gives each part of the supervisor that changes, and counts a missing part as a change", () => {
    expect(supervisorChanges(parts, { ...parts })).toEqual([]);
    expect(supervisorChanges(parts, { ...parts, "packages/runtime/src/host.ts": "new" })).toEqual(["packages/runtime/src/host.ts"]);
    expect(supervisorChanges(parts, { ...parts, [SERVICE_PACKAGE]: undefined })).toEqual([SERVICE_PACKAGE]);
  });

  it("starts a script of pnpm with Node, a program by its name, and refuses no program on Windows", () => {
    expect(pnpmCall({ PNPM: "/opt/pnpm/pnpm.cjs" }, "/usr/bin/node", "linux")).toEqual({ program: "/usr/bin/node", prefix: ["/opt/pnpm/pnpm.cjs"] });
    expect(pnpmCall({ PNPM: "/opt/pnpm/pnpm" }, "/usr/bin/node", "linux")).toEqual({ program: "/opt/pnpm/pnpm", prefix: [] });
    expect(pnpmCall({}, "/usr/bin/node", "linux")).toEqual({ program: "pnpm", prefix: [] });
    expect(pnpmCall({}, "node.exe", "win32")).toHaveProperty("refused");
  });

  it("installs with the lockfile: the runtime only, or each package for the local page", () => {
    expect(installArgs(false).slice(0, 2)).toEqual(["install", "--frozen-lockfile"]);
    expect(installArgs(false)).toEqual(expect.arrayContaining(["--prod", "--filter", "@mark1russell7/alerts-runtime..."]));
    expect(installArgs(true)).not.toContain("--prod");
  });

  it("caps a stage at a quarter of the memory of the host, with a floor, and a low weight for the processor", () => {
    expect(stageScope(1024 * 2 ** 20)).toEqual(["--user", "--scope", "--quiet", "-p", `MemoryHigh=${256 * 2 ** 20}`, "-p", "CPUWeight=10"]);
    expect(stageScope(100 * 2 ** 20)).toContain(`MemoryHigh=${64 * 2 ** 20}`);
  });
});

describe("the load step of a stage (AL-89)", () => {
  const saved = { home: process.env["ALERTS_HOME"], keep: process.env["ALERTS_STEP_KEEP"] };
  afterEach(() => {
    for (const [name, value] of [["ALERTS_HOME", saved.home], ["ALERTS_STEP_KEEP", saved.keep]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("loads the slot in the scratch home, and not in the live home of the process", () => {
    process.env["ALERTS_HOME"] = join(tmpdir(), "alerts-live-home");
    const runtime = join("slot-b", "packages", "runtime");
    const scratch = join(tmpdir(), "alerts-load-x");
    const step = loadStep(runtime, scratch, "/usr/bin/node");
    expect(step.program).toBe("/usr/bin/node");
    expect(step.args).toEqual([join(runtime, "src", "main.ts"), "load"]);
    expect(step.env).toEqual({ ALERTS_HOME: scratch });
    expect(Object.values(step.env)).not.toContain(process.env["ALERTS_HOME"]);
  });

  it("merges the env of a step over process.env: the scratch home wins, and the other variables of the process stay", async () => {
    const live = await mkdtemp(join(tmpdir(), "alerts-live-"));
    const scratch = await mkdtemp(join(tmpdir(), "alerts-load-"));
    process.env["ALERTS_HOME"] = live;
    process.env["ALERTS_STEP_KEEP"] = "kept";
    try {
      const step = loadStep(scratch, scratch, process.execPath);
      const print = "process.stdout.write(JSON.stringify([process.env.ALERTS_HOME, process.env.ALERTS_STEP_KEEP]))";
      const result = await runStep("load", step.program, ["-e", print], scratch, step.env);
      expect(JSON.parse(result.stdout)).toEqual([scratch, "kept"]);
    } finally {
      await rm(live, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("throws with the name and the exit code of a failed step", async () => {
    await expect(runStep("load", process.execPath, ["-e", "process.exit(3)"], tmpdir())).rejects.toThrow('The step "load" failed with the code 3.');
  });
});

describe("the fold version of a slot (AL-153)", () => {
  it("reads FOLD_VERSION from the fold file of this checkout", async () => {
    const text = await readFile(new URL(`../../../${FOLD_FILE}`, import.meta.url), "utf8");
    expect(foldVersionOf(text)).toBe(FOLD_VERSION);
  });

  it("gives no version for no text or a text with no version line", () => {
    expect(foldVersionOf(undefined)).toBeUndefined();
    expect(foldVersionOf("export const OTHER = 3;\n")).toBeUndefined();
    expect(foldVersionOf("// export const FOLD_VERSION = 4;\n")).toBeUndefined();
  });

  it("tells a change of the version with the steps, and nothing for the same version", () => {
    expect(foldChange(2, 2)).toBeUndefined();
    expect(foldChange(undefined, undefined)).toBeUndefined();
    const line = foldChange(1, 2) ?? "";
    expect(line).toContain("from 1 to 2");
    expect(line).toContain("deploy.ts fold");
    expect(foldChange(undefined, 2)).toContain("from none to 2");
  });

  it("folds with the live slot on the live home, with the profile of the supervised runtime", () => {
    const runtime = join("slot-b", "packages", "runtime");
    const home = join(tmpdir(), "alerts-home");
    const step = foldStep(runtime, home, "/usr/bin/node", "good");
    expect(step.args).toEqual([join(runtime, "src", "main.ts"), "fold", "good"]);
    expect(step.env).toEqual({ ALERTS_HOME: home, SERVICE_PROFILE: "daemon" });
  });
});

describe("the key step of a stage (AL-169)", () => {
  it("runs the mode key of the slot on the live home with the profile daemon", () => {
    const step = keyStep(join("slot", "packages", "runtime"), "home", "node");
    expect(step).toEqual({ program: "node", args: [join("slot", "packages", "runtime", "src", "main.ts"), "key"], env: { ALERTS_HOME: "home", SERVICE_PROFILE: "daemon" } });
  });

  it("reads the last line of the output, and refuses another form", () => {
    expect(startKeysOf('a line
{"files":"3:a","good":null}
')).toEqual({ files: "3:a", good: null });
    expect(startKeysOf('{"files":"3:a","good":"3:b"}')).toEqual({ files: "3:a", good: "3:b" });
    expect(startKeysOf("")).toBeUndefined();
    expect(startKeysOf("not json")).toBeUndefined();
    expect(startKeysOf('{"files":3,"good":null}')).toBeUndefined();
    expect(startKeysOf('{"files":"3:a","good":1}')).toBeUndefined();
    expect(startKeysOf("null")).toBeUndefined();
  });

  it("tells a change of the key of each set, and no line for the same keys", () => {
    const keys = { files: "3:a", good: "3:b" };
    expect(keyChange(keys, keys)).toEqual([]);
    expect(keyChange(keys, { files: "3:c", good: "3:b" })[0]).toContain("for the private files:");
    expect(keyChange(keys, { files: "3:a", good: "3:c" })[0]).toContain("for the last good set:");
    expect(keyChange(keys, { files: "3:c", good: "3:d" })[0]).toContain("the private files and the last good set");
    expect(keyChange(keys, { files: "3:c", good: "3:d" })[1]).toContain("deploy.ts fold");
    expect(keyChange({ files: "3:a", good: null }, { files: "3:a", good: null })).toEqual([]);
  });

  it("tells when a slot gave no keys", () => {
    expect(keyChange(undefined, { files: "3:a", good: null })[0]).toContain("cannot tell");
    expect(keyChange({ files: "3:a", good: null }, undefined)[0]).toContain("gave no key");
  });
});
