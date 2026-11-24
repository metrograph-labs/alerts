/**
 * This module records the code that the runtime runs (AL-167). The probes of a deploy tell only that a runtime is ready.
 * They do not tell its code. On 2026-11-24 two swaps crossed, and the restarted runtime ran the old slot with good probes.
 *
 * - Each start writes the file `running.json` in the host folder. The file has the process, the time and the slot of
 *   the real path. It also has the commit of the stage of that slot.
 * - `install.ts restart` and `deploy.ts status` read the file, and compare its slot to the target of the live link.
 * - The file holds no path. The real path of the checkout names the folder of the user.
 */
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@procedures/fs/files";
import { readText } from "./config.ts";
import { DEPLOY_FILE, parseDeployFile, samePath, SLOT_NAMES, type DeployFile, type LiveState, type SlotName, type Slots } from "./slots.ts";

/** The name of the file of the running code in the host folder. */
export const RUNNING_FILE = "running.json";

/** The record of the code that one start of the runtime runs. */
export interface RunningCode {
  readonly format: 1;
  /** The process ID of the runtime. */
  readonly pid: number;
  /** The time of the start, as an ISO 8601 text. */
  readonly at: string;
  /** The slot of the real path of the checkout, or `undefined` for a checkout that is not a slot. */
  readonly slot: SlotName | undefined;
  /** The commit of the stage of that slot, or `undefined` when the slot has no stage. */
  readonly commit: string | undefined;
}

/** This function gives the record of the code of a start from the real path of its checkout and the marks of the stages. */
export function runningCode(slots: Slots, realCheckout: string, marks: DeployFile, pid: number, at: string, platform: NodeJS.Platform = process.platform): RunningCode {
  const slot = SLOT_NAMES.find((name) => samePath(slots[name], realCheckout, platform));
  return { format: 1, pid, at, slot, commit: slot === undefined ? undefined : marks.marks[slot]?.sha };
}

/** This function reads a record of the running code from the text of the file, or gives `undefined` for a bad text. */
export function parseRunningCode(text: string | undefined): RunningCode | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { format, pid, at, slot, commit } = record;
  if (format !== 1 || typeof pid !== "number" || !Number.isInteger(pid) || typeof at !== "string") return undefined;
  if (slot !== undefined && slot !== "a" && slot !== "b") return undefined;
  if (commit !== undefined && typeof commit !== "string") return undefined;
  return { format: 1, pid, at, slot, commit };
}

/** The outcome of a comparison of the running code and the live link. */
export interface CodeReport {
  /** `same`: the runtime runs the slot of the live link. `other`: it runs the other slot. `unknown`: no record tells. */
  readonly kind: "same" | "other" | "unknown";
  readonly line: string;
}

/** This function gives the first seven characters of a commit, or a word for no commit. */
const short = (commit: string | undefined): string => (commit === undefined ? "no stage" : commit.slice(0, 7));

/**
 * This function compares the running code with the target of the live link. With `pid`, a record of another process
 * is old: the runtime with that process wrote no record.
 */
export function codeReport(live: LiveState, running: RunningCode | undefined, pid?: number): CodeReport {
  if (running === undefined || (pid !== undefined && running.pid !== pid)) {
    return { kind: "unknown", line: "The runtime wrote no record of its code. Code older than AL-167 writes no record." };
  }
  if (running.slot === undefined) return { kind: "unknown", line: `The runtime (process ${String(running.pid)}) runs a checkout that is not a slot.` };
  const runs = `The runtime (process ${String(running.pid)}, started ${running.at}) runs slot ${running.slot} (${short(running.commit)})`;
  if (live.kind !== "link" || live.slot === undefined) return { kind: "unknown", line: `${runs}. The live path is not a link to a slot.` };
  if (live.slot !== running.slot) {
    return { kind: "other", line: `${runs}, but the live path is a link to slot ${live.slot}. Start \`node src/install.ts restart\` from the live path.` };
  }
  return { kind: "same", line: `${runs}, the slot of the live path.` };
}

/** This function gives the path of the file of the running code in the host folder `host`. */
export const runningPath = (host: string): string => join(host, RUNNING_FILE);

/** This function reads the record of the running code from the host folder `host`. */
export async function readRunningCode(host: string): Promise<RunningCode | undefined> {
  const file = await readText(() => readFile(runningPath(host), "utf8"));
  return parseRunningCode("text" in file ? file.text : undefined);
}

/**
 * This function writes the record of the code of this start. `checkout` is the checkout as the command line gave it,
 * with the live link not resolved. The function resolves it to find the slot.
 */
export async function recordRunningCode(slots: Slots, checkout: string, host: string, pid: number, now: Date): Promise<RunningCode> {
  const marks = await readText(() => readFile(join(host, DEPLOY_FILE), "utf8"));
  const record = runningCode(slots, await realpath(checkout), parseDeployFile("text" in marks ? marks.text : undefined), pid, now.toISOString());
  await writeFileAtomic(runningPath(host), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
