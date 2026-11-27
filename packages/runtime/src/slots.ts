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
import { lstat, mkdir, readdir, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { runCommand, type CommandResult } from "@procedures/shell/command";
import { isRecord } from "@mark1russell7/optional/read";
import { acquireInstanceLock, type HostPorts } from "@mark1russell7/service/host";

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

/**
 * This function gives the slots of a checkout (AL-169). A process that starts in a slot folder has the real path of the
 * slot, not the live path. An example is a service unit with the live path as its folder: the operating system resolves
 * the link. The name of a slot checkout ends with `-a` or `-b`. When the path without that end is a link to the
 * checkout, the live path is that link. Each other checkout is a live path.
 */
export async function slotsOfCheckout(checkout: string, platform: NodeJS.Platform = process.platform): Promise<Slots> {
  const match = /^(.+)-([ab])$/u.exec(basename(checkout));
  if (match?.[1] !== undefined) {
    const slots = slotsOf(join(dirname(checkout), match[1]));
    const live = await readLive(slots, platform).catch(() => undefined);
    if (live?.kind === "link" && live.slot === match[2]) return slots;
  }
  return slotsOf(checkout);
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

/**
 * The target of a swap (AL-167): the slot that the live link names after the swap, and the start of its commit. The swap
 * compares the two with the slots before it changes the link. Thus a second swap of the same target, or a stage after
 * the read of the operator, changes nothing.
 */
export interface SwapTarget {
  readonly slot: SlotName;
  readonly commit: string;
}

/** This function reads the target of a swap from the arguments `<a|b> <commit>`, or gives undefined for bad arguments. */
export function parseSwapTarget(args: readonly string[]): SwapTarget | undefined {
  const [slot, commit, ...rest] = args;
  if (rest.length > 0 || (slot !== "a" && slot !== "b") || commit === undefined || !/^[0-9a-f]{7,40}$/u.test(commit)) return undefined;
  return { slot, commit };
}

/** The facts that decide a swap: the target, the live slot, the mark of the target slot, its commit, its changes and the foreign links. */
export interface SwapFacts {
  readonly target: SwapTarget;
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
  if (facts.target.slot === from) return `The live path is a link to slot ${from} already. Another deploy swapped it, or the swap is done. Read \`deploy.ts status\`.`;
  const foreign = facts.foreign;
  if (foreign !== undefined && foreign.target.length > 0) {
    return `Slot ${slot} has ${foreign.target.length} package links outside its folder${linkExample(foreign.target)}. Start \`deploy.ts relink\` first.`;
  }
  if (foreign !== undefined && foreign.live.length > 0) {
    return `Slot ${from} has ${foreign.live.length} package links outside its folder${linkExample(foreign.live)}. After the swap, a start from slot ${from} fails. Stop the boot task, start \`deploy.ts relink ${from}\`, and start the task.`;
  }
  if (facts.head === undefined) return `Slot ${slot} has no checkout. Start \`deploy.ts stage <commit>\` first.`;
  if (!facts.head.startsWith(facts.target.commit)) {
    return `Slot ${slot} has the commit ${facts.head.slice(0, 7)}, not ${facts.target.commit}. Another stage changed it. Read \`deploy.ts status\`.`;
  }
  if (facts.mark === undefined || facts.mark.sha !== facts.head) return `Slot ${slot} has no stage of its commit. Start \`deploy.ts stage <commit>\` first.`;
  const missing = STAGE_CHECKS.filter((check) => !facts.mark?.checks.includes(check));
  if (missing.length > 0) return `The stage of slot ${slot} did not pass these checks: ${missing.join(", ")}.`;
  if (!facts.clean) return `Slot ${slot} has changes after its stage.`;
  return undefined;
}

/** The name of the deploy lock in the host folder (AL-167). */
export const DEPLOY_LOCK_FILE = "deploy.lock";

/**
 * This function does `work` while this process holds the deploy lock at `path` (AL-167). A stage, a swap, a relink and a
 * fold each take the lock. Thus two deploys on one host do not cross. A lock of a process that stopped is stale, and
 * the take removes it. The function throws when a live process holds the lock, and the work does not start.
 */
export async function withDeployLock<T>(path: string, ports: HostPorts, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const result = await acquireInstanceLock(path, ports);
  if (result.kind === "held") {
    throw new Error(`The process ${String(result.owner.pid)} holds the deploy lock: another deploy runs. Wait for its end, then read \`deploy.ts status\`.`);
  }
  if (result.kind === "failed") throw new Error(`The deploy lock is not free: ${result.problem.split(dirname(path)).join("<host>")}`);
  try {
    return await work();
  } finally {
    await result.lock.release();
  }
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

/** The file of a slot that holds `FOLD_VERSION` (AL-153). */
export const FOLD_FILE = "packages/runtime/src/start-snapshot.ts";

/** This function reads `FOLD_VERSION` from the text of `FOLD_FILE`. It gives undefined for no text or a text with no version. */
export function foldVersionOf(text: string | undefined): number | undefined {
  const match = text === undefined ? null : /^export const FOLD_VERSION = (\d+);$/m.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * This function gives the line about the fold version from the live slot to the other slot. It gives undefined for the same
 * version. A new version makes the next start ignore the snapshot of the old fold. Then the fold of the whole log can take
 * longer than the ready window (AL-153).
 */
export function foldChange(live: number | undefined, next: number | undefined): string | undefined {
  if (live === next) return undefined;
  return [
    `The fold version changes from ${live === undefined ? "none" : String(live)} to ${next === undefined ? "none" : String(next)}.`,
    "If the new code does not upgrade the old snapshot, the next start folds the whole log.",
    "Stop the runtime, swap, start `deploy.ts fold`, and then start the runtime.",
  ].join(" ");
}

/**
 * This function gives the fold step: `main.ts fold <set>` of the live slot on the live home. The profile is the profile of
 * the supervised runtime, thus the fold has the configuration and the key of a start with that set (AL-169).
 */
export function foldStep(runtime: string, home: string, node: string, set: "files" | "good", heap?: number): StageStep {
  const limit = heap === undefined ? [] : [`--max-old-space-size=${String(heap)}`];
  return { program: node, args: [...limit, join(runtime, "src", "main.ts"), "fold", set], env: { ALERTS_HOME: home, SERVICE_PROFILE: "daemon" } };
}

/** The memory in MiB that the fold leaves to the host (AL-175). */
export const FOLD_HEAP_RESERVE = 128;

/** The free memory of a host in MiB, for the heap limit of the fold (AL-175). */
export interface FoldMemory {
  /** The memory that the host gives with no swap: `MemAvailable` on Linux, the free memory on other hosts. */
  readonly available: number;
  /** The free swap. A host with no reading has 0. */
  readonly swap: number;
}

/**
 * This function reads the free memory of a Linux host from the text of `/proc/meminfo` (AL-175). It gives `undefined` when
 * the text has no `MemAvailable` line. A text with no `SwapFree` line gives a swap of 0.
 */
export function memInfoOf(text: string): FoldMemory | undefined {
  const mib = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    return match?.[1] === undefined ? undefined : Math.floor(Number(match[1]) / 1024);
  };
  const available = mib("MemAvailable");
  return available === undefined ? undefined : { available, swap: mib("SwapFree") ?? 0 };
}

/**
 * This function gives the heap limit of the fold in MiB, from the free memory and swap of the host (AL-175). It gives
 * `undefined` when the default limit of node is as large. The runtime is stopped during the fold, thus the fold can use
 * the free memory and swap, less `FOLD_HEAP_RESERVE`.
 *
 * - A heap limit below the need of the fold makes the garbage collector work with no end. On 2026-11-24 a small host
 *   with the default limit of 530 MB did not fold a log of 287 000 events in 12 min.
 * - A limit above the memory of the host moves the end of the heap into swap. That is slow, but the fold ends.
 */
export function foldHeapLimit(memory: FoldMemory, defaultLimit: number): number | undefined {
  const limit = Math.floor(memory.available + memory.swap - FOLD_HEAP_RESERVE);
  return limit > defaultLimit ? limit : undefined;
}

/** The memory in MiB that a stage needs next to the live runtime (AL-186). On a host with less, the deploy stops the runtime first. */
export const STAGE_MEMORY_FLOOR = 400;

/** This function tells if the deploy stops the runtime before the stage, because the host has too little free memory (AL-186). */
export const stopBeforeStage = (memory: FoldMemory): boolean => memory.available < STAGE_MEMORY_FLOOR;

/** The read of another copy in the status of the live runtime (AL-186). `readAt` is the time of the last read, or `null`. */
export interface CopyReadStatus {
  readonly copy: string;
  readonly readAt: number | null;
  /** The first read that told that the copy is not steady, or `null` (AL-204). A status of an older build gives `null`. */
  readonly unsteadySince: number | null;
  /** The end of the deploy mark of the copy on the clock of this host, or `null` (AL-208). A status of an older build gives `null`. */
  readonly deployUntil: number | null;
}

/**
 * This function reads the reads of the other copies from the answer of `GET /status` (AL-186). A status with no field
 * `copies` has no other copy. A bad answer gives `undefined`.
 */
export function copyReadsOf(value: unknown): readonly CopyReadStatus[] | undefined {
  if (!isRecord(value)) return undefined;
  const copies = value["copies"];
  if (copies === undefined) return [];
  if (!Array.isArray(copies)) return undefined;
  const reads: CopyReadStatus[] = [];
  for (const item of copies as unknown[]) {
    if (!isRecord(item) || typeof item["copy"] !== "string") return undefined;
    const readAt = item["readAt"];
    if (readAt !== null && typeof readAt !== "number") return undefined;
    const unsteadySince = item["unsteadySince"] ?? null;
    if (unsteadySince !== null && typeof unsteadySince !== "number") return undefined;
    const deployUntil = item["deployUntil"] ?? null;
    if (deployUntil !== null && typeof deployUntil !== "number") return undefined;
    reads.push({ copy: item["copy"], readAt, unsteadySince, deployUntil });
  }
  return reads;
}

/**
 * This function gives the reason that the deploy does not stop the live runtime, or `undefined` (AL-186). A stop is safe
 * when each other copy had a read in the last `maxAge`. Then another copy sends the alerts during the stop.
 *
 * - `"down"` is a runtime that does not answer. A stop of it removes no copy, thus the function gives `undefined`.
 * - A host with no other copy stops only with `alone`: no copy sends the alerts during the stop.
 * - Each other copy must be steady (AL-204). A copy that started a short time ago is not steady. Thus a deploy of the
 *   second copy waits until the first copy has its passes and its heartbeats again. One bad release then stops one copy only.
 * - No other copy can have a deploy mark that did not end (AL-208). A copy that stages is up and steady, but it stops soon.
 * - With `readAfter`, each other copy needs a read after that time (AL-208). The deploy gives the time of its own mark.
 *   Then two deploys that start at about the same time see the marks of each other, and both refuse.
 */
export function stopRefusal(copies: readonly CopyReadStatus[] | "down" | undefined, now: number, maxAge: number, alone: boolean, readAfter?: number): string | undefined {
  if (copies === "down") return undefined;
  if (copies === undefined) return "The status of the live runtime has no good list of the other copies. The deploy does not stop the runtime.";
  if (copies.length === 0) return alone ? undefined : "This runtime has no other copy, thus a stop leaves no copy up. Add `--alone` to accept the gap.";
  const old = copies.filter((read) => read.readAt === null || now - read.readAt > maxAge).map((read) => read.copy);
  if (old.length > 0) {
    return `The copies ${old.join(", ")} had no read in the last ${String(Math.round(maxAge / 1000))} s, thus a stop can leave no copy up. The deploy does not stop the runtime.`;
  }
  const unread = readAfter === undefined ? [] : copies.filter((read) => read.readAt === null || read.readAt <= readAfter).map((read) => read.copy);
  if (unread.length > 0) return `The copies ${unread.join(", ")} had no read after the deploy mark of this host. The deploy does not stop the runtime.`;
  const deploying = copies.filter((read) => read.deployUntil !== null && read.deployUntil > now).map((read) => read.copy);
  if (deploying.length > 0) return `The copies ${deploying.join(", ")} deploy at this time. The deploy does not stop the runtime. Deploy again after their deploy ends.`;
  const unsteady = copies.filter((read) => read.unsteadySince !== null).map((read) => read.copy);
  if (unsteady.length === 0) return undefined;
  return `The copies ${unsteady.join(", ")} are not steady: they started a short time ago. The deploy does not stop the runtime. Deploy again when they are steady.`;
}

/** The name of the deploy mark in the host folder (AL-208). The runtime tells the other copies the end of the mark. */
export const DEPLOY_MARK_FILE = "deploying.json";

/** The end of a deploy mark while a deploy command holds the deploy lock: 1 hour after the take of the lock (AL-208). */
export const DEPLOY_MARK_SPAN: number = 60 * 60_000;

/**
 * The end of a deploy mark after the release of the deploy lock: 2 minutes (AL-208). The mark thus also covers a restart after a
 * swap. After that time, the other copies have no read of a stopped copy in their `maxAge`, or a read that is not steady.
 */
export const DEPLOY_MARK_TAIL: number = 2 * 60_000;

/** The deploy mark of a host (AL-208): the take of the deploy lock and the end of the mark, in milliseconds since the epoch. */
export interface DeployMark {
  readonly since: number;
  readonly until: number;
}

/** This function gives the text of the file of a deploy mark. */
export const deployMarkText = (mark: DeployMark): string => `${JSON.stringify(mark)}\n`;

/** This function gives the end of the deploy mark of a file text, when it is after `now`. No file, a bad file or an old mark give `undefined`. */
export function deployMarkEnd(text: string | undefined, now: number): number | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { since, until } = value;
  if (typeof since !== "number" || typeof until !== "number" || !Number.isFinite(since) || !Number.isFinite(until) || until < since) return undefined;
  return until > now ? until : undefined;
}

/** The arguments of `deploy.ts deploy` (AL-186): the commit, the build of the page, and the consent to a stop with no other copy. */
export interface DeployArgs {
  readonly commit: string;
  readonly page: boolean;
  readonly alone: boolean;
}

/** This function reads the arguments `<commit> [--page] [--alone]` of a deploy, or gives undefined for bad arguments. */
export function parseDeployArgs(args: readonly string[]): DeployArgs | undefined {
  const [commit, ...flags] = args;
  if (commit === undefined || !/^[0-9a-f]{7,40}$/u.test(commit)) return undefined;
  if (flags.some((flag) => flag !== "--page" && flag !== "--alone") || new Set(flags).size !== flags.length) return undefined;
  return { commit, page: flags.includes("--page"), alone: flags.includes("--alone") };
}

/** A step of the deploy after the stage (AL-186). `restart` is the restart of `install.ts`: the runtime stops and starts on the new code. */
export type DeployStep = "stop" | "swap" | "fold" | "start" | "restart";

/**
 * This function gives the steps of the deploy after the stage (AL-186). A fold needs a stopped runtime, because the fold
 * holds the lock of the home folder. With no fold, a running runtime takes the new code with one restart.
 */
export function stepsAfterStage(running: boolean, fold: boolean): readonly DeployStep[] {
  if (!running) return fold ? ["swap", "fold", "start"] : ["swap", "start"];
  return fold ? ["stop", "swap", "fold", "start"] : ["swap", "restart"];
}

/** This function tells if the steps take a running runtime down: a stop, or a restart for its start (AL-204). */
export const takesDown = (steps: readonly DeployStep[]): boolean => steps.includes("stop") || steps.includes("restart");

/**
 * This function gives the key step: `main.ts key` of a slot on the live home (AL-169). The step holds no lock and writes no
 * file, thus it runs next to the live runtime. The profile is the profile of the supervised runtime, as in `foldStep`.
 */
export function keyStep(runtime: string, home: string, node: string): StageStep {
  return { program: node, args: [join(runtime, "src", "main.ts"), "key"], env: { ALERTS_HOME: home, SERVICE_PROFILE: "daemon" } };
}

/** The context keys of the fold of the two sets of a start, from the mode key. The key of the good set is null with no good set. */
export interface StartKeys {
  readonly files: string;
  readonly good: string | null;
}

/** This function reads the last line of the output of the mode key. An output of another form gives undefined. */
export function startKeysOf(stdout: string): StartKeys | undefined {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { files, good } = value as Record<string, unknown>;
  if (typeof files !== "string" || (good !== null && typeof good !== "string")) return undefined;
  return { files, good };
}

/**
 * This function gives the lines about the context keys of the fold from the live slot to the other slot (AL-169). A changed
 * key makes the next start fold the whole log. On a small host, that fold takes longer than the ready window. No change
 * gives no line. With no keys of the live slot, the line tells that the stage cannot compare.
 */
export function keyChange(live: StartKeys | undefined, next: StartKeys | undefined): string[] {
  if (next === undefined) return ["The new code gave no key of the fold. Look at the output of `main.ts key` of the slot."];
  if (live === undefined) return ["The live code gave no key of the fold, thus the stage cannot tell if the next start folds the whole log."];
  const changed = [
    ...(live.files === next.files ? [] : ["the private files"]),
    ...(next.good === null || live.good === next.good ? [] : ["the last good set"]),
  ];
  if (changed.length === 0) return [];
  return [
    `The snapshot key changes for ${changed.join(" and ")}: a source, an expectation, the link policy, the retention or the fold version changes.`,
    "The next start folds the whole log. On a small host, stop the runtime, swap, start `deploy.ts fold`, and then start the runtime.",
  ];
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

/** The arguments of `deploy.ts files` (AL-220): the name of the private file, the file of its new text and the flag `--alone`. */
export interface FilesArgs {
  readonly name: string;
  readonly source: string;
  readonly alone: boolean;
}

// The private files that `deploy.ts files` writes: the configuration, the keys, the settings of the copy and each part.
const PRIVATE_NAMES = new Set(["config.json", "secrets.env", "copy.json"]);
const PART_NAME_FORM = /^parts\/[a-z0-9][a-z0-9-]*\.json$/u;

/** This function reads the arguments `<name> <source> [--alone]` of `deploy.ts files`, or gives undefined for bad arguments. */
export function parseFilesArgs(args: readonly string[]): FilesArgs | undefined {
  const [name, source, ...flags] = args;
  if (name === undefined || source === undefined || source === "" || source.startsWith("--")) return undefined;
  if (!PRIVATE_NAMES.has(name) && !PART_NAME_FORM.test(name)) return undefined;
  if (flags.some((flag) => flag !== "--alone") || flags.length > 1) return undefined;
  return { name, source, alone: flags.includes("--alone") };
}

/** This function reads the arguments `--held [--alone]` of `deploy.ts files` (AL-179), or gives undefined for other arguments. */
export function parseHeldArgs(args: readonly string[]): { readonly alone: boolean } | undefined {
  const [held, ...flags] = args;
  if (held !== "--held" || flags.length > 1 || flags.some((flag) => flag !== "--alone")) return undefined;
  return { alone: flags.length === 1 };
}

/** This function gives the path of a private file from its name in the home folder. The name is a name that `parseFilesArgs` accepts. */
export function privatePath(home: string, name: string): string {
  return join(home, ...name.split("/"));
}

/**
 * The outcome of the keys of the fold before and after the write of a private file (AL-220). `same` needs no fold. `fold`
 * needs a fold before the start, because the start reads no snapshot of the new key. `bad` puts the old text back.
 */
export type FilesOutcome = "same" | "fold" | "bad";

/**
 * This function compares the keys of the fold before and after the write of a private file (AL-220). New files that give no key
 * are bad. With no key before the write, the write cannot tell, thus a fold comes before the start.
 */
export function filesOutcome(before: StartKeys | undefined, after: StartKeys | undefined): FilesOutcome {
  if (after === undefined) return "bad";
  if (before === undefined) return "fold";
  return before.files === after.files && before.good === after.good ? "same" : "fold";
}
