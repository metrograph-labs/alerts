/**
 * This module gives the two slots of a deploy (AL-89). The live path of the checkout is a link to one of two
 * checkouts, the slots `<live>-a` and `<live>-b`. A deploy installs the new code in the slot that the link does not
 * name, and checks it there. Then it points the link at that slot in one step. The old slot stays as it is, for a
 * rollback.
 *
 * - The supervisor starts each runtime from the live path as the command line gave it (`entryRoot`). Thus each start
 *   takes the slot that the link names at that time, with no restart of the supervisor.
 * - On Linux the link is a symbolic link, and a rename replaces it in one step. On Windows the link is a junction.
 *   Windows cannot rename a link over a junction, thus the swap removes the junction and makes the new one. A start
 *   in that short gap fails, and the supervisor starts the runtime again.
 * - The supervisor loads its own files only at its start. Thus a change of them needs a restart of the boot task.
 * - A supervisor older than AL-89 starts each runtime from the real path of its slot, not through the link. Thus it
 *   starts the old code until the restart of the boot task.
 * - The package links of a slot must resolve in the slot (AL-144). On Windows, pnpm makes junctions with absolute
 *   targets. Thus `adopt` installs slot a again at its new path, and a swap refuses a slot with a link outside it.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { runCommand, type CommandResult } from "@procedures/shell/command";

/** The names of the two slots. */
export const SLOT_NAMES = ["a", "b"] as const;

/** The name of one slot. */
export type SlotName = (typeof SLOT_NAMES)[number];

/** The live path and the folder of each slot. */
export interface Slots {
  readonly live: string;
  readonly a: string;
  readonly b: string;
}

/** This function gives the slots of a live path: the folders `<live>-a` and `<live>-b` next to it. */
export function slotsOf(live: string): Slots {
  return { live, a: `${live}-a`, b: `${live}-b` };
}

/** This function gives the other slot. */
export const otherSlot = (slot: SlotName): SlotName => (slot === "a" ? "b" : "a");

/**
 * This function gives the folder of the package `runtime` from the path of an entry file `<root>/src/<file>.ts`, as
 * the command line gave it. Node resolves the links in the URL of a module, but not in this path. Thus a supervisor
 * that starts through the live link starts each runtime through the link too. Another path gives `fallback`.
 */
export function entryRoot(entry: string | undefined, fallback: string): string {
  if (entry === undefined || !/\.[cm]?[jt]s$/u.test(entry) || basename(dirname(entry)) !== "src") return fallback;
  return dirname(dirname(entry));
}

/** The variable that names the live path for `deploy.ts` and `install.ts`, in place of the path of their entry file. */
export const LIVE_VARIABLE = "ALERTS_LIVE";

/**
 * This function gives the folder of the package `runtime` of the live path. The variable `ALERTS_LIVE` names the live
 * path. It is for a first deploy, when the live slot has no `deploy.ts`: the staged slot starts its own `deploy.ts`
 * and `install.ts` with it. With no variable, the path of the entry file gives the folder (`entryRoot`).
 */
export function liveRoot(env: Readonly<Record<string, string | undefined>>, entry: string | undefined, fallback: string): string {
  const live = env[LIVE_VARIABLE];
  return live !== undefined && live !== "" ? join(live, "packages", "runtime") : entryRoot(entry, fallback);
}

/** This function gives the checkout of the folder of the package `runtime`: two folders up. */
export const checkoutOf = (root: string): string => dirname(dirname(root));

/**
 * This function tells if two paths name the same folder. On Windows, the case, a long-path prefix `\\?\` and an end
 * separator do not count.
 */
export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const plain = (path: string): string => {
    const full = resolve(path.replace(/^\\\\\?\\/u, "")).replace(/(.)[\\/]+$/u, "$1");
    return platform === "win32" ? full.toLowerCase() : full;
  };
  return plain(left) === plain(right);
}

/** This function gives the slot that a target of the live link names. A relative target starts at the folder of the live path. */
export function slotOfTarget(slots: Slots, target: string, platform: NodeJS.Platform = process.platform): SlotName | undefined {
  const full = resolve(dirname(slots.live), target.replace(/^\\\\\?\\/u, ""));
  return SLOT_NAMES.find((name) => samePath(slots[name], full, platform));
}

/** The kind of the live path: no file, a folder (a checkout before `adopt`), or a link with its target and its slot. */
export type LiveState =
  | { readonly kind: "none" }
  | { readonly kind: "folder" }
  | { readonly kind: "link"; readonly target: string; readonly slot: SlotName | undefined };

/** This function reads the kind of the live path. */
export async function readLive(slots: Slots, platform: NodeJS.Platform = process.platform): Promise<LiveState> {
  const stat = await lstatOrNone(slots.live);
  if (stat === undefined) return { kind: "none" };
  if (!stat.isSymbolicLink()) return { kind: "folder" };
  const target = await readlink(slots.live);
  return { kind: "link", target, slot: slotOfTarget(slots, target, platform) };
}

/**
 * This function points the live link at `target` in one step. It makes the link when it does not exist, and it refuses
 * a live path that is a folder. On Linux it makes a new symbolic link with a temporary name, and renames it over the
 * live link. On Windows it removes the junction and makes a new one.
 */
export async function swapLink(live: string, target: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const state = await lstatOrNone(live);
  if (state !== undefined && !state.isSymbolicLink()) throw new Error("The live path is a folder, not a link. Start `deploy.ts adopt` first.");
  if (platform === "win32") {
    if (state !== undefined) await removeJunction(live);
    await symlink(resolve(target), live, "junction");
    return;
  }
  // A target next to the live path stays relative, thus the link stays good when the parent folder moves.
  const text = samePath(dirname(resolve(target)), dirname(resolve(live)), platform) ? basename(target) : resolve(target);
  const temporary = `${live}.swap-${process.pid}`;
  await symlink(text, temporary);
  await rename(temporary, live);
}

/** This function gives the facts of a path itself, not of the target of a link, or undefined when the path does not exist. */
async function lstatOrNone(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** This function removes a junction, and not the folder that it names. */
async function removeJunction(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    await rmdir(path);
  }
}

/**
 * This function makes the checkout at the live path slot `a`, and the live path a link to it. On Linux a running
 * supervisor keeps its path, thus its next start of the runtime goes through the link. On Windows the rename fails
 * while a process uses the folder. A failed link puts the folder back.
 */
export async function adoptLive(slots: Slots, platform: NodeJS.Platform = process.platform): Promise<void> {
  const state = await readLive(slots, platform);
  if (state.kind !== "folder") throw new Error(state.kind === "none" ? "The live path does not exist." : "The live path is a link already.");
  if ((await lstatOrNone(slots.a)) !== undefined) throw new Error("Slot a exists already. Move it away first.");
  await rename(slots.live, slots.a);
  try {
    await swapLink(slots.live, slots.a, platform);
  } catch (error) {
    await rename(slots.a, slots.live);
    throw error;
  }
}

/**
 * The checks of a stage, in their order (AL-112 added the bundles). They are the install, the file of the outage bundles,
 * the check of the private files and the load of the code.
 */
export const STAGE_CHECKS = ["install", "bundles", "config", "load"] as const;

/** The record of a staged slot: its commit, the time of the stage, and the checks that passed with its code. */
export interface StageMark {
  readonly sha: string;
  readonly at: string;
  readonly checks: readonly string[];
}

/** The name of the file of the marks, in the folder of the host. */
export const DEPLOY_FILE = "deploy.json";

/** The file of the marks: one mark for each staged slot. */
export interface DeployFile {
  readonly format: 1;
  readonly marks: Partial<Record<SlotName, StageMark>>;
}

/** This function reads the file of the marks. No file, or a file with a bad form, gives no mark. */
export function parseDeployFile(text: string | undefined): DeployFile {
  const empty: DeployFile = { format: 1, marks: {} };
  if (text === undefined) return empty;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null || (value as { format?: unknown }).format !== 1) return empty;
  const marks: Partial<Record<SlotName, StageMark>> = {};
  const raw = (value as { marks?: unknown }).marks;
  for (const name of SLOT_NAMES) {
    const mark = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[name] : undefined;
    if (typeof mark !== "object" || mark === null) continue;
    const { sha, at, checks } = mark as Record<string, unknown>;
    if (typeof sha === "string" && typeof at === "string" && Array.isArray(checks) && checks.every((check): check is string => typeof check === "string")) {
      marks[name] = { sha, at, checks };
    }
  }
  return { format: 1, marks };
}

/** This function gives the file of the marks with the mark of `slot` set, or removed when `mark` is undefined. */
export function withMark(file: DeployFile, slot: SlotName, mark: StageMark | undefined): DeployFile {
  const marks = { ...file.marks };
  if (mark === undefined) delete marks[slot];
  else marks[slot] = mark;
  return { format: 1, marks };
}

/** A package link of a slot: the path of the link, and its target as `readlink` gives it. */
export interface PackageLink {
  readonly path: string;
  readonly target: string;
}

/**
 * This function tells if `path` is the folder `folder` or a path in it. On Windows, the case and a long-path prefix do
 * not count.
 */
export function insideFolder(folder: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const plain = (value: string): string => {
    const full = resolve(value.replace(/^\\\\\?\\/u, "")).replace(/(.)[\\/]+$/u, "$1");
    return platform === "win32" ? full.toLowerCase().replace(/\//gu, "\\") : full;
  };
  const root = plain(folder);
  const full = plain(path);
  const separator = platform === "win32" ? "\\" : "/";
  return full === root || full.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

/**
 * This function gives the package links of a slot that resolve outside the folder of the slot (AL-144). A relative
 * target starts at the folder of the link. On Windows, pnpm makes junctions with absolute targets. Thus a checkout that
 * moves to a slot keeps links to its old path, and a link at that path can name the other slot.
 */
export function foreignLinks(slot: string, links: readonly PackageLink[], platform: NodeJS.Platform = process.platform): readonly PackageLink[] {
  return links.filter((link) => !insideFolder(slot, resolve(dirname(link.path), link.target.replace(/^\\\\\?\\/u, "")), platform));
}

/**
 * This function reads the package links of a slot. They are the links in `node_modules` of the checkout and of each
 * package, also in each scope folder. It does not go into the store of pnpm.
 */
export async function readPackageLinks(slot: string): Promise<readonly PackageLink[]> {
  const folders = [join(slot, "node_modules")];
  for (const name of await namesIn(join(slot, "packages"))) folders.push(join(slot, "packages", name, "node_modules"));
  const links: PackageLink[] = [];
  const add = async (path: string): Promise<boolean> => {
    const stat = await lstatOrNone(path);
    if (stat?.isSymbolicLink() !== true) return false;
    links.push({ path, target: await readlink(path) });
    return true;
  };
  for (const folder of folders) {
    for (const name of await namesIn(folder)) {
      if (name.startsWith(".")) continue;
      const path = join(folder, name);
      if ((await add(path)) || !name.startsWith("@")) continue;
      for (const inner of await namesIn(path)) await add(join(path, inner));
    }
  }
  return links;
}

/** This function gives the names in a folder, or no name when the folder does not exist. */
async function namesIn(folder: string): Promise<readonly string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** The package links of the two slots that resolve outside their own slot (`foreignLinks`). */
export interface ForeignLinks {
  readonly live: readonly PackageLink[];
  readonly target: readonly PackageLink[];
}

/** The facts that decide a swap: the live slot, the mark of the target slot, its commit, its changes and the foreign links. */
export interface SwapFacts {
  readonly live: LiveState;
  readonly mark: StageMark | undefined;
  readonly head: string | undefined;
  readonly clean: boolean;
  readonly foreign?: ForeignLinks | undefined;
}

/** This function gives one example of a foreign link for a message. */
const linkExample = (links: readonly PackageLink[]): string => {
  const first = links[0];
  return first === undefined ? "" : `, for example ${first.path} -> ${first.target}`;
};

/**
 * This function gives the reason that a swap to the other slot cannot go, or undefined. The live path must be a link to
 * a slot. The other slot needs a mark of its present commit with each check, and no change in its tree.
 * No package link of the two slots can resolve outside its own slot (AL-144). After a swap, such a link names the
 * other slot, and a start from that slot fails.
 */
export function swapRefusal(facts: SwapFacts): string | undefined {
  if (facts.live.kind !== "link" || facts.live.slot === undefined) return "The live path is not a link to a slot. Start `deploy.ts adopt` first.";
  const from = facts.live.slot;
  const slot = otherSlot(from);
  const foreign = facts.foreign;
  if (foreign !== undefined && foreign.target.length > 0) {
    return `Slot ${slot} has ${foreign.target.length} package links outside its folder${linkExample(foreign.target)}. Start \`deploy.ts relink\` first.`;
  }
  if (foreign !== undefined && foreign.live.length > 0) {
    return `Slot ${from} has ${foreign.live.length} package links outside its folder${linkExample(foreign.live)}. After the swap, a start from slot ${from} fails. Stop the boot task, start \`deploy.ts relink ${from}\`, and start the task.`;
  }
  if (facts.head === undefined) return `Slot ${slot} has no checkout. Start \`deploy.ts stage <commit>\` first.`;
  if (facts.mark === undefined || facts.mark.sha !== facts.head) return `Slot ${slot} has no stage of its commit. Start \`deploy.ts stage <commit>\` first.`;
  const missing = STAGE_CHECKS.filter((check) => !facts.mark?.checks.includes(check));
  if (missing.length > 0) return `The stage of slot ${slot} did not pass these checks: ${missing.join(", ")}.`;
  if (!facts.clean) return `Slot ${slot} has changes after its stage.`;
  return undefined;
}

/** The files of the supervisor, from the checkout. The supervisor loads them only at its own start. */
export const SUPERVISOR_FILES = ["packages/runtime/src/supervise.ts", "packages/runtime/src/host.ts"] as const;

/** The name of the service package. Its version is a part of the supervisor too. */
export const SERVICE_PACKAGE = "@mark1russell7/service";

/** This function gives the SHA-256 of a text, or undefined for no text. */
export const textHash = (text: string | undefined): string | undefined => (text === undefined ? undefined : createHash("sha256").update(text).digest("hex"));

/**
 * This function gives the parts of the supervisor that differ between two slots: each file of `SUPERVISOR_FILES` and the
 * version of the service package. A part with no value in a slot counts as a change.
 */
export function supervisorChanges(live: Readonly<Record<string, string | undefined>>, next: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [...SUPERVISOR_FILES, SERVICE_PACKAGE].filter((part) => live[part] === undefined || next[part] === undefined || live[part] !== next[part]);
}

/** The program of pnpm and its first arguments, or the reason that there is none. */
export type PnpmCall = { readonly program: string; readonly prefix: readonly string[] } | { readonly refused: string };

/**
 * This function gives the call of pnpm from the variable `PNPM`. A path that ends in `.cjs`, `.mjs` or `.js` starts with
 * Node. With no variable, the program is `pnpm`. On Windows the variable is necessary, because Node cannot start the
 * file `pnpm.cmd` with no shell.
 */
export function pnpmCall(env: Readonly<Record<string, string | undefined>>, node: string, platform: NodeJS.Platform = process.platform): PnpmCall {
  const value = env["PNPM"];
  if (value !== undefined && value !== "") return /\.[cm]?js$/u.test(value) ? { program: node, prefix: [value] } : { program: value, prefix: [] };
  if (platform === "win32") return { refused: "On Windows, give PNPM: the path of pnpm.cjs (or pnpm.exe). Node cannot start pnpm.cmd with no shell." };
  return { program: "pnpm", prefix: [] };
}

/** The part of the memory of the host that the programs of a stage can use before the kernel takes their pages back. */
export const STAGE_MEMORY_SHARE = 0.25;

/** The weight of a stage for the processor, against the weight 100 of the runtime in the same slice. */
export const STAGE_CPU_WEIGHT = 10;

/**
 * This function gives the arguments of `systemd-run` that start a program of a stage in a scope of the user manager.
 * The scope caps the memory of the program at a share of the memory of the host.
 * It also gives the program a low weight for the processor.
 * Thus a stage on a small host pays for its own memory with its own pages, and the live runtime keeps its pages.
 */
export function stageScope(totalMemory: number): readonly string[] {
  const high = Math.max(64 * 2 ** 20, Math.floor(totalMemory * STAGE_MEMORY_SHARE));
  return ["--user", "--scope", "--quiet", "-p", `MemoryHigh=${high}`, "-p", `CPUWeight=${STAGE_CPU_WEIGHT}`];
}

/** This function gives the arguments of the install of a stage: the runtime and its packages, or each package for the local page. */
export function installArgs(page: boolean): readonly string[] {
  const scope = page ? [] : ["--prod", "--filter", "@mark1russell7/alerts-runtime..."];
  return ["install", "--frozen-lockfile", ...scope, "--prefer-offline", "--network-concurrency=2", "--child-concurrency=1", "--reporter=silent"];
}

/** The time limit of one step of a stage: 20 minutes. */
export const STEP_TIMEOUT_MS: number = 20 * 60_000;

/** This interface is one program of a stage: its arguments, and the variables that go over the environment of the stage. */
export interface StageStep {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * This function gives the load step of a stage. The load runs `main.ts load` of the slot in the empty home `scratch`.
 * The variable `ALERTS_HOME` of the step goes over the live home of the environment. Thus no module of the new code writes to the live home.
 */
export function loadStep(runtime: string, scratch: string, node: string): StageStep {
  return { program: node, args: [join(runtime, "src", "main.ts"), "load"], env: { ALERTS_HOME: scratch } };
}

/**
 * This function runs one program of a stage to its end. The variables of `env` go over the environment of this process.
 * A failure throws with the end of the output.
 */
export async function runStep(name: string, program: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<CommandResult> {
  const result = await runCommand(program, { args: [...args], cwd, env: { ...env }, timeout: STEP_TIMEOUT_MS });
  if (!result.success) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-12).join("\n");
    throw new Error(`The step "${name}" failed with the code ${result.exitCode}${result.timedOut === true ? " (time-out)" : ""}.\n${tail}`);
  }
  return result;
}
