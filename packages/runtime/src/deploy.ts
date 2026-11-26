/**
 * This file deploys new code to the live checkout through two slots (AL-89, `slots.ts`). The install does not change
 * the code under the running runtime. Start this file through the live path, thus with the code of the live slot:
 * `node <live>/packages/runtime/src/deploy.ts <command>`.
 *
 * - `status` gives the kind of the live path, the live slot, and the commit and the stage of each slot.
 * - `adopt` makes the checkout at the live path slot `a`, and the live path a link to it. Start it one time.
 *   On Windows, stop the boot task first, because a folder in use cannot move.
 * - `stage <commit> [--page]` checks out the commit in the other slot and installs its dependencies with the lockfile.
 *   Then it checks the private files and the load of the code, with the new code. `--page` also builds the local page.
 *   The live slot does not change.
 * - `swap <a|b> <commit>` points the live path at the staged slot in one step. The runtime takes the new code at its next start.
 *   `node src/install.ts restart` from the live path starts it at once. A swap to the old slot goes back to it.
 *   A swap refuses a slot with a package link outside its folder (AL-144). It is a compare and swap (AL-167). It refuses
 *   a target slot that the live link names already, or a target slot with another commit.
 * - `stage`, `swap`, `relink`, `adopt` and `fold` hold the deploy lock in the host folder (AL-167). A second deploy on
 *   the host stops at its start. `status` takes no lock. It also tells the slot and the commit of the running runtime.
 * - Each command that takes the deploy lock also writes the deploy mark `DEPLOY_MARK_FILE` (AL-208). The runtime tells the
 *   other copies its end. Thus a deploy of another copy does not stop its runtime while this host deploys.
 * - `relink [a|b]` removes the `node_modules` folders of a slot and installs them again at its own path. With no
 *   name, it takes the other slot. For the live slot, stop the boot task first.
 * - On Windows, `adopt` also relinks slot a, because the junctions of pnpm name the old path of the checkout.
 * - `fold` folds the log with the code of the live slot, and writes the snapshot of the start (AL-153). Start it while the
 *   runtime is stopped, after a swap that changes the fold version. The stage and the swap tell when the version changes.
 *   The stage also tells when the snapshot key changes for the next start (AL-169): a new source, for example.
 *
 * - `deploy <commit> [--page] [--alone]` does the whole deploy in one command (AL-186). Its steps are the stage and the swap.
 *   Then it folds when the fold version or the snapshot key changes, and it starts the new code. It stops the runtime only for a fold, or before the
 *   stage on a host with less free memory than `STAGE_MEMORY_FLOOR`. It stops the runtime only when each other copy had a
 *   read in the last `COPY_MAX_AGE`, each other copy is steady (AL-204), and no other copy deploys (AL-208). A restart takes the runtime down too, thus
 *   the check comes before the swap. A host with no other copy stops only with `--alone`. At the end, the runtime must run
 *   the new commit, with a start after the begin of the deploy. On Windows, a stop and a start change the boot task.
 *
 * A swap back to older code is a rollback. Do it only when the new code wrote no new kind of event to the log.
 * When the files of the supervisor change, the stage and the swap tell it. The supervisor takes them only at a restart
 * of the boot task.
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`, and `PNPM`, the program of pnpm (`slots.ts`, `pnpmCall`).
 * `ALERTS_LIVE` names the live path in place of the path of this file (`slots.ts`, `liveRoot`). Use it only for a first
 * deploy, when the live slot has no `deploy.ts`. Then check out and install the commit in the other slot. Start
 * `ALERTS_LIVE=<live> node <other slot>/packages/runtime/src/deploy.ts stage <commit>`, and then `swap`.
 * The exit code is 0 for success, 1 for a refusal or a failed step, and 2 for a wrong command. The output holds no value of a private file.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { constants, freemem, setPriority, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { writeFileAtomic } from "@procedures/fs/files";
import { runCommand, type CommandResult } from "@procedures/shell/command";
import { valueIn } from "@mark1russell7/quantity";
import { nodeHostPorts, probeOnce, startService, stopService, type ServiceOutcome } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import { createPrinter } from "@mark1russell7/text/print";
import { alertsHome, readText as readFileText } from "./config.ts";
import { COPY_MAX_AGE, EXCHANGE_LIMIT } from "./copy.ts";
import { HOST_PORTS, hostFileText, hostFolder, hostReadyWindow, hostTask, PROBE_TIMEOUT, readinessProbe, supervisorDiscovery } from "./host.ts";
import { GOOD_FILE } from "./reload.ts";
import {
  adoptLive,
  checkoutOf,
  copyReadsOf,
  DEPLOY_FILE,
  DEPLOY_LOCK_FILE,
  DEPLOY_MARK_FILE,
  DEPLOY_MARK_SPAN,
  DEPLOY_MARK_TAIL,
  deployMarkText,
  FOLD_FILE,
  foldChange,
  foldHeapLimit,
  foldStep,
  foldVersionOf,
  foreignLinks,
  liveRoot,
  installArgs,
  keyChange,
  keyStep,
  loadStep,
  memInfoOf,
  otherSlot,
  parseDeployArgs,
  parseDeployFile,
  parseSwapTarget,
  pnpmCall,
  readLive,
  readPackageLinks,
  runStep,
  SERVICE_PACKAGE,
  STAGE_MEMORY_FLOOR,
  slotsOfCheckout,
  STAGE_CHECKS,
  startKeysOf,
  stageScope,
  stepsAfterStage,
  stopBeforeStage,
  stopRefusal,
  SUPERVISOR_FILES,
  supervisorChanges,
  swapLink,
  swapRefusal,
  takesDown,
  textHash,
  withDeployLock,
  withMark,
  type DeployFile,
  type FoldMemory,
  type CopyReadStatus,
  type DeployArgs,
  type DeployMark,
  type ForeignLinks,
  type SlotName,
  type StartKeys,
  type SwapTarget,
} from "./slots.ts";
import { codeReport, deployEndProblem, readRunningCode } from "./running.ts";

// The output of this command for a person goes through one printer, which removes the shapes of tokens (no raw console).
const print = createPrinter({ out: process.stdout, err: process.stderr });

const USAGE = "The command is: node src/deploy.ts status | adopt | stage <commit> [--page] | swap <a|b> <commit> | relink [a|b] | fold | deploy <commit> [--page] [--alone]";

const root = liveRoot(process.env, process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const slots = await slotsOfCheckout(checkoutOf(root));
const home = alertsHome(process.env, process.cwd());
const deployPath = join(hostFolder(home), DEPLOY_FILE);
// The deploy mark of this host (AL-208), and the time of its write by this command.
const writeMark = (mark: DeployMark): Promise<void> => writeFileAtomic(join(hostFolder(home), DEPLOY_MARK_FILE), deployMarkText(mark));
let markedAt: number | undefined;

const readText = async (path: string): Promise<string | undefined> => {
  const file = await readFileText(() => readFile(path, "utf8"));
  return "text" in file ? file.text : undefined;
};
const readMarks = async (): Promise<DeployFile> => parseDeployFile(await readText(deployPath));
const writeMarks = (file: DeployFile): Promise<void> => writeFileAtomic(deployPath, `${JSON.stringify(file, null, 2)}\n`);

const step = runStep;

/**
 * This function gives the arguments of `systemd-run` for the heavy steps of a stage, or undefined when no scope of the user
 * manager can start. On a host with no scope, the stage runs only at the lowest priority of the processor.
 */
async function scopeOf(): Promise<readonly string[] | undefined> {
  if (process.platform !== "linux") return undefined;
  const scope = stageScope(totalmem());
  const probe = await runCommand("systemd-run", { args: [...scope, "true"], timeout: 60_000 });
  return probe.success ? scope : undefined;
}

const git = (cwd: string, ...args: string[]): Promise<CommandResult> => step(`git ${args[0] ?? ""}`, "git", args, cwd);

/** This function gives the commit of a slot, or undefined for a slot with no checkout. */
async function headOf(folder: string): Promise<string | undefined> {
  const result = await runCommand("git", { args: ["rev-parse", "HEAD"], cwd: folder, timeout: 60_000 });
  return result.success ? result.stdout.trim() : undefined;
}

/** This function tells if the tree of a slot has no change. */
async function cleanOf(folder: string): Promise<boolean> {
  const result = await runCommand("git", { args: ["status", "--porcelain"], cwd: folder, timeout: 60_000 });
  return result.success && result.stdout.trim() === "";
}

/** This function reads the parts of the supervisor of one slot: its files and the version of the service package. */
async function supervisorParts(folder: string): Promise<Record<string, string | undefined>> {
  const parts: Record<string, string | undefined> = {};
  for (const file of SUPERVISOR_FILES) parts[file] = textHash(await readText(join(folder, file)));
  const manifest = await readText(join(folder, "packages", "runtime", "node_modules", ...SERVICE_PACKAGE.split("/"), "package.json"));
  let version: string | undefined;
  try {
    version = manifest === undefined ? undefined : (JSON.parse(manifest) as { version?: string }).version;
  } catch {
    version = undefined;
  }
  parts[SERVICE_PACKAGE] = version;
  return parts;
}

/** This function prints the parts of the supervisor that change from the live slot to `slot`. */
async function tellSupervisor(live: SlotName, slot: SlotName): Promise<void> {
  const changes = supervisorChanges(await supervisorParts(slots[live]), await supervisorParts(slots[slot]));
  print.line(
    changes.length === 0
      ? "The supervisor does not change."
      : `The supervisor changes: ${changes.join(", ")}. The supervisor takes the change only at a restart of the boot task.`,
  );
  // A supervisor older than AL-89 starts each runtime from the real path of its slot, thus from the old slot (AL-144).
  const own = await readText(join(slots[live], ...SUPERVISOR_FILES[0].split("/")));
  if (own !== undefined && !own.includes("entryRoot")) {
    print.line(`The supervisor of slot ${live} is older than AL-89: it starts each runtime from slot ${live} until the restart of the boot task.`);
  }
}

/**
 * This function prints the line about the fold version from slot `from` to slot `to`, when the version changes (AL-153).
 * It gives `true` when the version changes.
 */
async function tellFold(from: SlotName, to: SlotName): Promise<boolean> {
  const line = foldChange(foldVersionOf(await readText(join(slots[from], ...FOLD_FILE.split("/")))), foldVersionOf(await readText(join(slots[to], ...FOLD_FILE.split("/")))));
  if (line !== undefined) print.line(line);
  return line !== undefined;
}

/**
 * This function folds the log with the code of the live slot, and writes the snapshot of the start (AL-153). It folds for
 * each set that the next start can use: the private files, and the last good set (AL-169). The start marker picks the set
 * at the start, thus each set needs its snapshot. The lock of the home folder refuses the fold while a runtime runs.
 */
async function foldLive(): Promise<void> {
  const live = await liveSlot();
  setPriority(constants.priority.PRIORITY_LOW);
  const runtime = join(slots[live], "packages", "runtime");
  const sets = (await readText(join(home, GOOD_FILE))) === undefined ? (["files"] as const) : (["files", "good"] as const);
  for (const set of sets) {
    // Each fold reads the memory again: the fold before it gave its memory back (AL-175).
    const heap = foldHeapLimit(await hostMemory(), Math.floor(getHeapStatistics().heap_size_limit / MIB));
    if (heap !== undefined) print.line(`The fold ${set} has a heap limit of ${String(heap)} MiB, from the free memory and swap of the host (AL-175).`);
    const fold = foldStep(runtime, home, process.execPath, set, heap);
    const result = await step(`fold ${set}`, fold.program, fold.args, runtime, fold.env);
    print.line(result.stdout.trim().split("\n").slice(-2).join("\n"));
  }
  if (sets.length === 1) print.line(`The home folder has no ${GOOD_FILE}, thus the fold was only for the private files.`);
}

const MIB = 1024 * 1024;

/** This function gives the free memory of the host: `/proc/meminfo` on Linux, the free memory and no swap on other hosts (AL-175). */
async function hostMemory(): Promise<FoldMemory> {
  const linux = process.platform === "linux" ? memInfoOf((await readText("/proc/meminfo")) ?? "") : undefined;
  return linux ?? { available: Math.floor(freemem() / MIB), swap: 0 };
}

const PROBE_TIMEOUT_MS = valueIn(PROBE_TIMEOUT, "ms");
// The boot task or the user unit of the supervisor, as `install.ts` makes it. A stop and a start of the deploy use it (AL-186).
const spec = hostTask({ home, root, node: process.execPath });

/**
 * This function reads the reads of the other copies from the status of the live runtime (AL-186). A runtime that refuses
 * the connection is `"down"`. A time-out or a bad answer gives `undefined`, thus the deploy does not stop the runtime.
 */
async function liveCopies(): Promise<readonly CopyReadStatus[] | "down" | undefined> {
  let reply: Response;
  try {
    reply = await fetch(`http://127.0.0.1:${String(HOST_PORTS.port)}/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? undefined : "down";
  }
  if (!reply.ok) return undefined;
  try {
    return copyReadsOf(await reply.json());
  } catch {
    return undefined;
  }
}

/** This function gives the problem of an outcome of the service host, or `undefined` for success. */
function outcomeProblem(outcome: ServiceOutcome): string | undefined {
  switch (outcome.kind) {
    case "done":
      return undefined;
    case "failed":
      return outcome.problem;
    case "refused":
      return outcome.problems.join(" ");
    case "unsupported":
      return `The platform ${outcome.platform} has no boot task.`;
  }
}

/**
 * This function stops the deploy when a stop of the runtime is not safe at this time (AL-186, AL-204, AL-208). It first
 * waits up to `COPY_MAX_AGE` for a read of each other copy that started after the deploy mark of this host. The middle of a
 * read is `readAt`, thus a read with `readAt` after the mark plus `EXCHANGE_LIMIT` started after the mark.
 */
async function checkCopies(alone: boolean): Promise<void> {
  const readAfter = markedAt === undefined ? undefined : markedAt + EXCHANGE_LIMIT;
  const end = Date.now() + COPY_MAX_AGE;
  let copies = await liveCopies();
  const waits = (): boolean => readAfter !== undefined && copies !== undefined && copies !== "down" && copies.some((read) => read.readAt === null || read.readAt <= readAfter);
  while (waits() && Date.now() < end) {
    await sleep(2000);
    copies = await liveCopies();
  }
  const refusal = stopRefusal(copies, Date.now(), COPY_MAX_AGE, alone, readAfter);
  if (refusal !== undefined) throw new Error(refusal);
}

/** This function stops the runtime and keeps it stopped, after the check of the other copies (AL-186). */
async function stopLive(alone: boolean): Promise<void> {
  await checkCopies(alone);
  const problem = outcomeProblem(await stopService(spec, nodeHostPorts(), { discovery: supervisorDiscovery(home) }));
  if (problem !== undefined) throw new Error(`The stop of the runtime failed: ${problem}`);
  print.line("The runtime is stopped. The other copies send the alerts until it is ready again.");
}

/** This function starts the runtime, and waits for its readiness for the ready window of the host (AL-186). */
async function startLive(): Promise<void> {
  const ports = nodeHostPorts();
  const problem = outcomeProblem(await startService(spec, ports));
  if (problem !== undefined) throw new Error(`The start of the runtime failed: ${problem}`);
  const window = hostReadyWindow(home, hostFileText).ms;
  const end = Date.now() + window;
  for (;;) {
    if ((await probeOnce(readinessProbe(), PROBE_TIMEOUT_MS, ports)).ok) {
      print.line("The runtime is ready.");
      return;
    }
    if (Date.now() >= end) throw new Error(`The runtime is not ready after ${String(Math.ceil(window / 1000))} s. A runtime that is not ready sends no alert: read its output.`);
    await sleep(2000);
  }
}

/** This function restarts the runtime on the code of the live path with `install.ts restart`. The restart waits for the readiness. */
async function restartLive(): Promise<void> {
  const runtime = join(slots.live, "packages", "runtime");
  const result = await step("restart", process.execPath, [join(runtime, "src", "install.ts"), "restart"], runtime, { ALERTS_HOME: home });
  print.line(result.stdout.trim());
}

/**
 * This function does the whole deploy of a commit (AL-186). Call it with the deploy lock. When a step fails after a stop,
 * it starts the runtime again on the code of the live path. Thus the deploy does not leave the runtime stopped.
 */
async function deploy(args: DeployArgs): Promise<void> {
  const began = Date.now();
  let running = (await liveCopies()) !== "down";
  let stopped = false;
  let sha = "";
  try {
    if (running && stopBeforeStage(await hostMemory())) {
      print.line(`The host has less than ${String(STAGE_MEMORY_FLOOR)} MiB of free memory, thus the runtime stops before the stage.`);
      await stopLive(args.alone);
      running = false;
      stopped = true;
      const after = await hostMemory();
      if (stopBeforeStage(after)) throw new Error(`The host has ${String(after.available)} MiB of free memory after the stop. The stage needs ${String(STAGE_MEMORY_FLOOR)} MiB.`);
    }
    const staged = await stage(args.commit, args.page);
    sha = staged.sha;
    const steps = stepsAfterStage(running, staged.fold);
    print.line(`The next steps of the deploy: ${steps.join(", ")}.`);
    // A restart also takes the runtime down for its start. The check comes before the swap, thus a refusal changes nothing (AL-204).
    if (takesDown(steps)) await checkCopies(args.alone);
    for (const next of steps) {
      if (next === "stop") {
        await stopLive(args.alone);
        stopped = true;
      } else if (next === "swap") await swap({ slot: staged.slot, commit: staged.sha });
      else if (next === "fold") await foldLive();
      else if (next === "start") {
        await startLive();
        stopped = false;
      } else await restartLive();
    }
  } catch (error) {
    if (stopped) {
      print.error(`A step failed after the stop of the runtime. The deploy starts the runtime again on the code of the live path.`);
      try {
        await startLive();
      } catch (again) {
        print.error(`The start failed too: ${errorMessage(again)}`);
      }
    }
    throw error;
  }
  const problem = deployEndProblem(await readRunningCode(hostFolder(home)), sha, began);
  if (problem !== undefined) throw new Error(`The deploy did not end on the new code. ${problem}`);
  print.line(`The deploy of ${sha.slice(0, 7)} is done: ${codeReport(await readLive(slots), await readRunningCode(hostFolder(home))).line}`);
}

/** The runner of one step of a stage. */
type StepRun = (name: string, program: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<CommandResult>;

/**
 * This function prints the lines about the context keys of the fold from slot `from` to slot `to` (AL-169). The mode key
 * of each slot reads the live home with the code of that slot. A failed step gives no keys, and the line tells it.
 * It gives `true` when the next start can fold the whole log: a key changes, or a slot gave no key.
 */
async function tellKeys(from: SlotName, to: SlotName, run: StepRun): Promise<boolean> {
  const keysOf = async (slot: SlotName): Promise<StartKeys | undefined> => {
    const runtime = join(slots[slot], "packages", "runtime");
    const key = keyStep(runtime, home, process.execPath);
    try {
      return startKeysOf((await run(`key ${slot}`, key.program, key.args, runtime, key.env)).stdout);
    } catch {
      return undefined;
    }
  };
  const lines = keyChange(await keysOf(from), await keysOf(to));
  for (const line of lines) print.line(line);
  return lines.length > 0;
}

/** This function reads the live slot, or throws when the live path is not a link to a slot. */
async function liveSlot(): Promise<SlotName> {
  const live = await readLive(slots);
  if (live.kind !== "link" || live.slot === undefined) throw new Error("The live path is not a link to a slot. Start `deploy.ts adopt` first.");
  return live.slot;
}

async function status(): Promise<void> {
  const live = await readLive(slots);
  print.line(live.kind === "link" ? `The live path is a link to slot ${live.slot ?? "(no slot)"}.` : `The live path is ${live.kind === "folder" ? "a folder: start adopt" : "missing"}.`);
  const marks = await readMarks();
  for (const name of ["a", "b"] as const) {
    const head = await headOf(slots[name]);
    const mark = marks.marks[name];
    const stage = mark === undefined ? "no stage" : `staged ${mark.sha.slice(0, 7)} at ${mark.at}, checks ${mark.checks.join(" ")}${mark.sha === head ? "" : " (not the commit of the slot)"}`;
    print.line(`slot ${name}: ${head === undefined ? "no checkout" : head.slice(0, 7)}, ${stage}`);
  }
  // The probes do not tell the code of the runtime. The record of its last start tells it (AL-167).
  const report = codeReport(live, await readRunningCode(hostFolder(home)));
  if (report.kind === "other") print.error(report.line);
  else print.line(report.line);
}

/** The end of a stage: the staged slot, its commit, and if the next start folds the whole log. */
interface Staged {
  readonly slot: SlotName;
  readonly sha: string;
  readonly fold: boolean;
}

async function stage(commit: string, page: boolean): Promise<Staged> {
  const live = await liveSlot();
  // The stage and each program that it starts run at the lowest priority of the processor.
  setPriority(constants.priority.PRIORITY_LOW);
  // A nice value does not count against another cgroup. A scope next to the runtime caps the memory and the weight of each heavy step.
  const scope = await scopeOf();
  const heavy = (name: string, program: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<CommandResult> =>
    scope === undefined ? step(name, program, args, cwd, env) : step(name, "systemd-run", [...scope, program, ...args], cwd, env);
  print.line(scope === undefined ? "The stage runs with no scope: only its priority is low." : `The heavy steps run in a scope: ${scope.slice(4).join(" ")}.`);
  const slot = otherSlot(live);
  const folder = slots[slot];
  const call = pnpmCall(process.env, process.execPath);
  if ("refused" in call) throw new Error(call.refused);
  // The old mark goes first: a stage that stops in its middle leaves no mark, thus no swap.
  await writeMarks(withMark(await readMarks(), slot, undefined));
  if ((await headOf(folder)) === undefined) {
    await git(slots[live], "clone", "--quiet", slots[live], folder);
    const origin = await git(slots[live], "remote", "get-url", "origin");
    await git(folder, "remote", "set-url", "origin", origin.stdout.trim());
  } else if (!(await cleanOf(folder))) {
    throw new Error(`Slot ${slot} has changes. Look at them, and clean the slot first.`);
  }
  await git(folder, "fetch", "--quiet", "origin");
  await git(folder, "checkout", "--quiet", "--detach", commit);
  const sha = (await headOf(folder)) ?? "";
  print.line(`Slot ${slot} has the commit ${sha.slice(0, 7)}.`);
  const env = { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  await heavy("install", call.program, [...call.prefix, ...installArgs(page)], folder, env);
  if (page) await heavy("page", call.program, [...call.prefix, "--filter", "./packages/site", "build"], folder, env);
  const runtime = join(folder, "packages", "runtime");
  // The bundles of the outage Functions go to a file of the slot. A deploy of the runtime reads the file, thus it starts no esbuild (AL-112).
  const bundles = await heavy("bundles", process.execPath, [join(runtime, "src", "outage-bundles.ts")], runtime);
  print.line(bundles.stdout.trim());
  const config = await heavy("config", process.execPath, [join(runtime, "src", "check.ts")], runtime);
  print.line(config.stdout.trim());
  // The load needs no private file. An empty home keeps each write of a module away from the live home.
  const scratch = await mkdtemp(join(tmpdir(), "alerts-load-"));
  try {
    const load = loadStep(runtime, scratch, process.execPath);
    await heavy("load", load.program, load.args, runtime, load.env);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeMarks(withMark(await readMarks(), slot, { sha, at: new Date().toISOString(), checks: [...STAGE_CHECKS] }));
  print.line(`Slot ${slot} is staged at ${sha.slice(0, 7)}: ${STAGE_CHECKS.join(", ")} passed.`);
  await tellSupervisor(live, slot);
  const version = await tellFold(live, slot);
  const keys = await tellKeys(live, slot, heavy);
  print.line(`Start \`deploy.ts swap ${slot} ${sha.slice(0, 7)}\` to put it live.`);
  return { slot, sha, fold: version || keys };
}

/** This function gives the package links of a slot that resolve outside the slot (AL-144). */
const foreignOf = async (slot: SlotName): Promise<ForeignLinks["live"]> => foreignLinks(slots[slot], await readPackageLinks(slots[slot]));

/**
 * This function removes the `node_modules` folders of a slot and installs them again at the path of the slot (AL-144).
 * A removal does not follow a link. Thus it does not touch the folder that a junction names.
 */
async function relink(slot: SlotName): Promise<void> {
  const folder = slots[slot];
  if ((await headOf(folder)) === undefined) throw new Error(`Slot ${slot} has no checkout.`);
  const call = pnpmCall(process.env, process.execPath);
  if ("refused" in call) throw new Error(call.refused);
  setPriority(constants.priority.PRIORITY_LOW);
  const packages = await readdir(join(folder, "packages")).catch(() => [] as string[]);
  for (const path of [join(folder, "node_modules"), ...packages.map((name) => join(folder, "packages", name, "node_modules"))]) {
    await rm(path, { recursive: true, force: true });
  }
  await step("install", call.program, [...call.prefix, ...installArgs(false)], folder, { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  const left = await foreignOf(slot);
  if (left.length > 0) throw new Error(`Slot ${slot} still has ${left.length} package links outside its folder after the install.`);
  print.line(`Slot ${slot} is installed again at its path: each package link resolves in the slot.`);
}

/** This function swaps the live link to `target`, after the compare of the target with the slots (AL-167). Call it with the deploy lock. */
async function swap(target: SwapTarget): Promise<void> {
  const live = await readLive(slots);
  const from = live.kind === "link" ? live.slot : undefined;
  const slot = from === undefined ? undefined : otherSlot(from);
  const head = slot === undefined ? undefined : await headOf(slots[slot]);
  const mark = slot === undefined ? undefined : (await readMarks()).marks[slot];
  const clean = slot !== undefined && (await cleanOf(slots[slot]));
  const foreign = from === undefined || slot === undefined ? undefined : { live: await foreignOf(from), target: await foreignOf(slot) };
  const refusal = swapRefusal({ target, live, mark, head, clean, foreign });
  if (refusal !== undefined) throw new Error(refusal);
  if (from === undefined || slot === undefined) throw new Error("The live path is not a link to a slot.");
  await swapLink(slots.live, slots[slot]);
  print.line(`The live path is a link to slot ${slot} (${(head ?? "").slice(0, 7)}) now. Slot ${from} stays for a rollback.`);
  await tellSupervisor(from, slot);
  await tellFold(from, slot);
  print.line("The runtime takes the new code at its next start. `node src/install.ts restart` from the live path starts it now.");
}

const [command, ...rest] = process.argv.slice(2);
const target = command === "swap" ? parseSwapTarget(rest) : undefined;
const deployArgs = command === "deploy" ? parseDeployArgs(rest) : undefined;
// Each command that changes a slot or the live link holds the deploy lock (AL-167). Thus two deploys do not cross.
// The command also writes the deploy mark (AL-208). At the release, the mark ends `DEPLOY_MARK_TAIL` later.
const locked = (work: () => Promise<void>): Promise<void> =>
  withDeployLock(join(hostFolder(home), DEPLOY_LOCK_FILE), nodeHostPorts(), async () => {
    const since = Date.now();
    await writeMark({ since, until: since + DEPLOY_MARK_SPAN });
    markedAt = since;
    try {
      await work();
    } finally {
      await writeMark({ since, until: Date.now() + DEPLOY_MARK_TAIL }).catch((error: unknown) => print.error(`The write of the deploy mark failed: ${errorMessage(error)}`));
    }
  });
let code = 0;
try {
  if (command === "status" && rest.length === 0) await status();
  else if (command === "adopt" && rest.length === 0) await locked(adopt);
  else if (command === "stage" && rest.length >= 1 && rest.length <= 2 && (rest[1] === undefined || rest[1] === "--page") && rest[0] !== "--page") {
    await locked(async () => {
      await stage(rest[0] ?? "", rest[1] === "--page");
    });
  } else if (target !== undefined) await locked(() => swap(target));
  else if (command === "relink" && rest.length <= 1 && (rest[0] === undefined || rest[0] === "a" || rest[0] === "b")) {
    await locked(async () => relink((rest[0] as SlotName | undefined) ?? otherSlot(await liveSlot())));
  } else if (command === "fold" && rest.length === 0) await locked(foldLive);
  else if (command === "deploy" && deployArgs !== undefined) await locked(() => deploy(deployArgs));
  else {
    print.error(USAGE);
    code = 2;
  }
} catch (error) {
  print.error(errorMessage(error));
  code = 1;
}
process.exitCode = code;

/** This function makes the checkout slot `a`, and relinks it when its package links name its old path. */
async function adopt(): Promise<void> {
  await adoptLive(slots);
  print.line("The checkout is slot a now, and the live path is a link to it.");
  const foreign = await foreignOf("a");
  if (foreign.length > 0) {
    print.line(`Slot a has ${foreign.length} package links to its old path. The install of slot a starts again.`);
    await relink("a");
  }
}
