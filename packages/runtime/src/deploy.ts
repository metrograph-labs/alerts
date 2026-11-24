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
 * - `swap` points the live path at the staged slot in one step. The runtime takes the new code at its next start.
 *   `node src/install.ts restart` from the live path starts it at once. A second `swap` goes back to the old slot.
 *   A swap refuses a slot with a package link outside its folder (AL-144).
 * - `relink [a|b]` removes the `node_modules` folders of a slot and installs them again at its own path. With no
 *   name, it takes the other slot. For the live slot, stop the boot task first.
 * - On Windows, `adopt` also relinks slot a, because the junctions of pnpm name the old path of the checkout.
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
import { constants, setPriority, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@procedures/fs/files";
import { runCommand, type CommandResult } from "@procedures/shell/command";
import { errorMessage } from "@mark1russell7/text";
import { alertsHome, readText as readFileText } from "./config.ts";
import { hostFolder } from "./host.ts";
import {
  adoptLive,
  checkoutOf,
  DEPLOY_FILE,
  foreignLinks,
  liveRoot,
  installArgs,
  loadStep,
  otherSlot,
  parseDeployFile,
  pnpmCall,
  readLive,
  readPackageLinks,
  runStep,
  SERVICE_PACKAGE,
  slotsOf,
  STAGE_CHECKS,
  stageScope,
  SUPERVISOR_FILES,
  supervisorChanges,
  swapLink,
  swapRefusal,
  textHash,
  withMark,
  type DeployFile,
  type ForeignLinks,
  type SlotName,
} from "./slots.ts";

const USAGE = "The command is: node src/deploy.ts status | adopt | stage <commit> [--page] | swap | relink [a|b]";

const root = liveRoot(process.env, process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const slots = slotsOf(checkoutOf(root));
const home = alertsHome(process.env, process.cwd());
const deployPath = join(hostFolder(home), DEPLOY_FILE);

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
  console.log(
    changes.length === 0
      ? "The supervisor does not change."
      : `The supervisor changes: ${changes.join(", ")}. The supervisor takes the change only at a restart of the boot task.`,
  );
  // A supervisor older than AL-89 starts each runtime from the real path of its slot, thus from the old slot (AL-144).
  const own = await readText(join(slots[live], ...SUPERVISOR_FILES[0].split("/")));
  if (own !== undefined && !own.includes("entryRoot")) {
    console.log(`The supervisor of slot ${live} is older than AL-89: it starts each runtime from slot ${live} until the restart of the boot task.`);
  }
}

/** This function reads the live slot, or throws when the live path is not a link to a slot. */
async function liveSlot(): Promise<SlotName> {
  const live = await readLive(slots);
  if (live.kind !== "link" || live.slot === undefined) throw new Error("The live path is not a link to a slot. Start `deploy.ts adopt` first.");
  return live.slot;
}

async function status(): Promise<void> {
  const live = await readLive(slots);
  console.log(live.kind === "link" ? `The live path is a link to slot ${live.slot ?? "(no slot)"}.` : `The live path is ${live.kind === "folder" ? "a folder: start adopt" : "missing"}.`);
  const marks = await readMarks();
  for (const name of ["a", "b"] as const) {
    const head = await headOf(slots[name]);
    const mark = marks.marks[name];
    const stage = mark === undefined ? "no stage" : `staged ${mark.sha.slice(0, 7)} at ${mark.at}, checks ${mark.checks.join(" ")}${mark.sha === head ? "" : " (not the commit of the slot)"}`;
    console.log(`slot ${name}: ${head === undefined ? "no checkout" : head.slice(0, 7)}, ${stage}`);
  }
}

async function stage(commit: string, page: boolean): Promise<void> {
  const live = await liveSlot();
  // The stage and each program that it starts run at the lowest priority of the processor.
  setPriority(constants.priority.PRIORITY_LOW);
  // A nice value does not count against another cgroup. A scope next to the runtime caps the memory and the weight of each heavy step.
  const scope = await scopeOf();
  const heavy = (name: string, program: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<CommandResult> =>
    scope === undefined ? step(name, program, args, cwd, env) : step(name, "systemd-run", [...scope, program, ...args], cwd, env);
  console.log(scope === undefined ? "The stage runs with no scope: only its priority is low." : `The heavy steps run in a scope: ${scope.slice(4).join(" ")}.`);
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
  console.log(`Slot ${slot} has the commit ${sha.slice(0, 7)}.`);
  const env = { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  await heavy("install", call.program, [...call.prefix, ...installArgs(page)], folder, env);
  if (page) await heavy("page", call.program, [...call.prefix, "--filter", "./packages/site", "build"], folder, env);
  const runtime = join(folder, "packages", "runtime");
  // The bundles of the outage Functions go to a file of the slot. A deploy of the runtime reads the file, thus it starts no esbuild (AL-112).
  const bundles = await heavy("bundles", process.execPath, [join(runtime, "src", "outage-bundles.ts")], runtime);
  console.log(bundles.stdout.trim());
  const config = await heavy("config", process.execPath, [join(runtime, "src", "check.ts")], runtime);
  console.log(config.stdout.trim());
  // The load needs no private file. An empty home keeps each write of a module away from the live home.
  const scratch = await mkdtemp(join(tmpdir(), "alerts-load-"));
  try {
    const load = loadStep(runtime, scratch, process.execPath);
    await heavy("load", load.program, load.args, runtime, load.env);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeMarks(withMark(await readMarks(), slot, { sha, at: new Date().toISOString(), checks: [...STAGE_CHECKS] }));
  console.log(`Slot ${slot} is staged at ${sha.slice(0, 7)}: ${STAGE_CHECKS.join(", ")} passed.`);
  await tellSupervisor(live, slot);
  console.log("Start `deploy.ts swap` to put it live.");
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
  console.log(`Slot ${slot} is installed again at its path: each package link resolves in the slot.`);
}

async function swap(): Promise<void> {
  const live = await readLive(slots);
  const from = live.kind === "link" ? live.slot : undefined;
  const slot = from === undefined ? undefined : otherSlot(from);
  const head = slot === undefined ? undefined : await headOf(slots[slot]);
  const mark = slot === undefined ? undefined : (await readMarks()).marks[slot];
  const clean = slot !== undefined && (await cleanOf(slots[slot]));
  const foreign = from === undefined || slot === undefined ? undefined : { live: await foreignOf(from), target: await foreignOf(slot) };
  const refusal = swapRefusal({ live, mark, head, clean, foreign });
  if (refusal !== undefined) throw new Error(refusal);
  if (from === undefined || slot === undefined) throw new Error("The live path is not a link to a slot.");
  await swapLink(slots.live, slots[slot]);
  console.log(`The live path is a link to slot ${slot} (${(head ?? "").slice(0, 7)}) now. Slot ${from} stays for a rollback.`);
  await tellSupervisor(from, slot);
  console.log("The runtime takes the new code at its next start. `node src/install.ts restart` from the live path starts it now.");
}

const [command, ...rest] = process.argv.slice(2);
let code = 0;
try {
  if (command === "status" && rest.length === 0) await status();
  else if (command === "adopt" && rest.length === 0) {
    await adoptLive(slots);
    console.log("The checkout is slot a now, and the live path is a link to it.");
    const foreign = await foreignOf("a");
    if (foreign.length > 0) {
      console.log(`Slot a has ${foreign.length} package links to its old path. The install of slot a starts again.`);
      await relink("a");
    }
  } else if (command === "stage" && rest.length >= 1 && rest.length <= 2 && (rest[1] === undefined || rest[1] === "--page") && rest[0] !== "--page") {
    await stage(rest[0] ?? "", rest[1] === "--page");
  } else if (command === "swap" && rest.length === 0) await swap();
  else if (command === "relink" && rest.length <= 1 && (rest[0] === undefined || rest[0] === "a" || rest[0] === "b")) {
    await relink((rest[0] as SlotName | undefined) ?? otherSlot(await liveSlot()));
  }
  else {
    console.error(USAGE);
    code = 2;
  }
} catch (error) {
  console.error(errorMessage(error));
  code = 1;
}
process.exitCode = code;
