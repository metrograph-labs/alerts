/**
 * This script pairs two builds of the repository in one job (AL-116). The arm `base` is a checkout of a base commit, and
 * the arm `head` is the build of the job. Each child is a fresh process (`freshRun` of `@mark1russell7/rigor-bench`).
 * A child rebuilds one seeded log with the runtime and the core of its own build.
 *
 * - Each case is a retention variant: `off`, or a quiet horizon in hours.
 * - The A/A pairs `base~aa` and `head~aa` give the noise of each build.
 * - The two builds share one computer in each round, so the ratio `head / base` has no offset between runners.
 * - Each child gives the hash of its incidents and the fold version of its build. The verdict checks that two builds of one
 *   fold version give the same incidents. A head with a new fold version declares a change of the incidents (AL-172).
 *
 * Usage:
 *
 * - `node scripts/fold-pair.ts measure <job> <folder> <base> <cases> [size] [rounds]` seeds a log of `size` MB in the folder
 *   and checks out the base commit. It gives one JSON line for the computer and one for each pair of children.
 * - `node scripts/fold-pair.ts verdict <folder>` reads the lines of all the jobs in the folder. It gives the ratio of each
 *   case and the memory of each build. With `FOLD_RATIO_LIMITS` (`case=limit` pairs), the verdict is a gate.
 * - `node --expose-gc scripts/fold-pair.ts --tree <folder> --log <file> --case <case>` is one child. `measure` starts it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  gateLine,
  gateOf,
  pooledLimitVerdict,
  writeGateLine,
  writeGateVerdict,
  type JobRecords,
  type LimitOutcome,
  type PairedTime,
  type PooledLimitVerdict,
} from "@mark1russell7/rigor-bench";
import { checkoutArm, freshRun, heapAfterGc, peakRss, repoCommit } from "@mark1russell7/rigor-bench/fresh";

/** The id of the pair of the head build against the base build. */
export const PAIR = "head";
/** The id of the A/A pair of the base build. */
export const BASE_AA = "base~aa";
/** The id of the A/A pair of the head build. */
export const HEAD_AA = "head~aa";

const HOUR = 3_600_000;
const HORIZON = 168 * HOUR;
const LIFE = 720 * HOUR;
const SEED = "al105";
const MB = 1_000_000;
// The count of rounds of one job. An even count gives each order of each pair the same count of rounds.
const ROUNDS = 6;
// The fewest jobs of a gate read: the limit of a gate comes from 5 or more runs.
const MIN_JOBS = 5;
// The time limit of the install of the base checkout and of one child.
const SETUP_MS = 900_000;
// Each case has its own limit, so each verdict reads one case. The A/A rounds of that case give its noise.
const OWN_NOISE = { aaFrom: "rounds" } as const;

type Runtime = typeof import("@mark1russell7/alerts-runtime");
type Core = typeof import("@mark1russell7/alerts");
/** The fold version helpers of `slots.ts` in a tree (AL-153). The file of each tree gives the version of that build. */
interface FoldFile {
  readonly FOLD_FILE: string;
  foldVersionOf(text: string | undefined): number | undefined;
}

/** This function gives the retention options of a case: `off`, or a quiet horizon in hours. */
export function retentionOf(variant: string): { readonly horizon: number; readonly life: number; readonly every: number; readonly quiet: number } | undefined {
  if (variant === "off") return undefined;
  const hours = Number(variant);
  if (!(hours > 0) || !Number.isFinite(hours)) throw new RangeError(`The case ${JSON.stringify(variant)} is not off or a number of hours above 0.`);
  return { horizon: HORIZON, life: LIFE, every: HOUR, quiet: hours * HOUR };
}

/** This function gives the fold version of the build in `tree`, or undefined for a tree with no helpers of the fold version. */
async function foldVersionIn(tree: string): Promise<number | undefined> {
  try {
    const slots = (await import(pathToFileURL(join(tree, "packages/runtime/src/slots.ts")).href)) as FoldFile;
    return slots.foldVersionOf(readFileSync(join(tree, slots.FOLD_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * This function is one child. It imports the runtime and the core of the build in `tree` and rebuilds the log one time.
 * The time is the rebuild only. The peak RSS comes before the read of the incidents, and the heap comes after a full GC.
 */
async function child(tree: string, log: string, variant: string): Promise<void> {
  // A file URL in the tree loads the modules of that build. The runtime of the tree imports the core of the same tree.
  const runtime = (await import(pathToFileURL(join(tree, "packages/runtime/src/index.ts")).href)) as Runtime;
  const core = (await import(pathToFileURL(join(tree, "packages/core/src/index.ts")).href)) as Core;
  const retention = retentionOf(variant);
  const store = runtime.openRuntimeLog(log);
  let retirements = 0;
  const began = performance.now();
  const state = runtime.rebuild(store.read(runtime.FOLD_TYPES), { sources: [], ...(retention === undefined ? {} : { retention }) }, () => {
    retirements += 1;
  });
  const ms = performance.now() - began;
  store.close();
  const rss = peakRss();
  const list = core.incidents(state.merge, state.time);
  const incidents = createHash("sha256")
    .update(JSON.stringify(list.map((incident) => [incident.anchor, incident.reports])))
    .digest("hex")
    .slice(0, 16);
  const heap = heapAfterGc();
  // The child reads the fold version after the heap, thus the module of the slots is not in the measure.
  // A tree before AL-153 has no helpers in the slots: then the child gives no version.
  const fold = await foldVersionIn(tree);
  // The hash makes the runner refuse two different outputs of one build on one case. The field `incidents` goes to the record.
  console.log(JSON.stringify({ ms, hash: incidents, incidents, fold, count: list.length, reports: state.merge.reports.length, retirements, peakRss: rss, heap }));
}

/** This function seeds one log in the folder, checks out the base commit and starts the children of each pair, case and round. */
async function measure(job: number, folder: string, base: string, cases: readonly string[], size: number, rounds: number): Promise<void> {
  if (!Number.isInteger(job) || job < 0) throw new RangeError("The job is a whole number of 0 or more.");
  if (!(size > 0)) throw new RangeError("The size of the log is a number of MB above 0.");
  for (const variant of cases) retentionOf(variant);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  // Only the parent seeds, so a child loads no seed code.
  const { seedStore } = await import("../src/seed-store.ts");
  const seeded = await seedStore(folder, { log: size * MB, seed: SEED, retention: { horizon: HORIZON, life: LIFE, every: HOUR } });
  console.log(JSON.stringify({ record: "seed", job: String(job), size, events: seeded.events, days: (seeded.end - seeded.start) / 86_400_000 }));
  const script = fileURLToPath(import.meta.url);
  const root = resolve(dirname(script), "../../..");
  const commandOf = (tree: string): string[] => [process.execPath, "--expose-gc", script, "--tree", tree, "--log", seeded.path];
  const dir = join(mkdtempSync(join(tmpdir(), "fold-pair-")), "base");
  const baseArm = await checkoutArm({ id: "base", commit: base, dir, command: commandOf(dir), setup: [["pnpm", "install", "--frozen-lockfile"]], repo: root, timeoutMs: SETUP_MS });
  try {
    const head = { id: "head", command: commandOf(root), commit: await repoCommit("HEAD", { repo: root }) };
    const run = await freshRun({ base: baseArm, candidates: [head], cases, rounds, roundOffset: job * rounds, job: String(job), aa: "each", timeoutMs: SETUP_MS });
    console.log(JSON.stringify({ record: "env", job: run.job, rounds, env: run.env, skipped: run.skipped }));
    for (const [pair, records] of Object.entries(run.pairs)) {
      for (const { env: _env, ...record } of records) console.log(JSON.stringify({ record: "pair", pair, ...record }));
    }
  } finally {
    await baseArm.remove();
  }
}

/** The fields of the child line of one arm, in a pair record. The runner keeps each field that it does not read in `extra`. */
export interface ArmFields {
  readonly peakRss?: number;
  readonly extra?: { readonly incidents?: string; readonly fold?: number; readonly count?: number; readonly heap?: number };
}

/** One line of a job: a pair of children, or the computer and the skips of the job. */
export type BenchLine =
  | (PairedTime & { readonly record: "pair"; readonly pair: string; readonly job: string; readonly fields?: { readonly a?: ArmFields; readonly b?: ArmFields } })
  | { readonly record: "env"; readonly job: string; readonly skipped?: readonly { readonly case: string }[] };

/** This function gives the pair lines and the computer lines of each JSON-lines file of the folder. */
export function linesIn(folder: string): BenchLine[] {
  const out: BenchLine[] = [];
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(folder, name), "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      const value = JSON.parse(line) as { readonly record?: string };
      if (value.record === "pair" || value.record === "env") out.push(value as BenchLine);
    }
  }
  return out;
}

/** This function gives the records of each job: the pairs of the head, the A/A pairs of the arm `aa` and the skips. */
export function jobsOf(lines: readonly BenchLine[], aa: string = BASE_AA): JobRecords[] {
  const jobs = new Map<string, { candidate: PairedTime[]; aa: PairedTime[]; skipped: { readonly case: string }[] }>();
  for (const line of lines) {
    let job = jobs.get(line.job);
    if (job === undefined) jobs.set(line.job, (job = { candidate: [], aa: [], skipped: [] }));
    if (line.record === "env") job.skipped.push(...(line.skipped ?? []));
    else if (line.pair === PAIR) job.candidate.push(line);
    else if (line.pair === aa) job.aa.push(line);
  }
  return [...jobs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([job, records]) => ({ job, ...records }));
}

/** This function gives the limit of each case from a text of `case=limit` pairs, separated by commas. An empty text gives no limit. */
export function limitsOf(text: string | undefined): ReadonlyMap<string, number> {
  const limits = new Map<string, number>();
  for (const item of (text ?? "").split(",").map((part) => part.trim())) {
    if (item === "") continue;
    const [name, value, ...rest] = item.split("=");
    const limit = Number(value);
    if (name === undefined || name === "" || rest.length > 0 || !(limit > 0) || !Number.isFinite(limit)) throw new RangeError(`The limit ${JSON.stringify(item)} is not case=ratio with a ratio above 0.`);
    if (limits.has(name)) throw new RangeError(`The case ${name} has two limits.`);
    limits.set(name, limit);
  }
  return limits;
}

/** This function keeps only the records and the skips of one case in each job. */
function caseJobs(jobs: readonly JobRecords[], name: string): JobRecords[] {
  return jobs.map((job) => ({
    job: job.job,
    candidate: job.candidate.filter((record) => record.case === name),
    aa: job.aa.filter((record) => record.case === name),
    skipped: (job.skipped ?? []).filter((skip) => skip.case === name),
  }));
}

/** The read of one case over all the jobs. */
export interface CaseRead {
  readonly case: string;
  /** The limit of the ratio `head / base`. A case with no limit has the limit 1, and it only reports. */
  readonly limit: number | undefined;
  /** The verdict of the claim "the head takes at most the limit times the base" over the pool of the jobs. */
  readonly verdict: PooledLimitVerdict;
  /** The same verdict with the A/A pairs of the base as the candidate. Only a limit below 1 has it: the gate sees the old build then. */
  readonly flip: PooledLimitVerdict | undefined;
  /** The noise of the head build: the verdict of its A/A pairs at the limit 1. */
  readonly headNoise: PooledLimitVerdict;
}

/** This function gives the read of each case against its limit. The A/A rounds of the base on the case give the noise of the verdict. */
export function readOf(lines: readonly BenchLine[], limits: ReadonlyMap<string, number>): CaseRead[] {
  const jobs = jobsOf(lines);
  const headJobs = jobsOf(lines, HEAD_AA);
  const cases = [...new Set(lines.flatMap((line) => (line.record === "pair" ? [line.case] : [])))].sort();
  return cases.map((name) => {
    const limit = limits.get(name);
    const own = caseJobs(jobs, name);
    return {
      case: name,
      limit,
      verdict: pooledLimitVerdict(own, { ...OWN_NOISE, limit: limit ?? 1 }),
      flip: limit === undefined || limit >= 1 ? undefined : pooledLimitVerdict(own.map((job) => ({ ...job, candidate: job.aa })), { ...OWN_NOISE, limit }),
      headNoise: pooledLimitVerdict(
        caseJobs(headJobs, name).map((job) => ({ ...job, candidate: job.aa })),
        { ...OWN_NOISE, limit: 1 },
      ),
    };
  });
}

/** The incidents of the two builds on one case. */
export interface SameIncidents {
  readonly case: string;
  /** The count of pair records of the head with the hash of the incidents of each arm. */
  readonly records: number;
  /** The count of those records where two builds of one fold version give different incidents. */
  readonly differ: number;
  /**
   * The count of those records where the two builds have different fold versions and give different incidents. The new
   * fold version of the head declares the change, thus the gate does not count it as a fault.
   */
  readonly declared: number;
  /** The count of pair records of the head without a hash of each arm. */
  readonly missing: number;
}

/** This function compares the hash of the incidents of the base and the head in each pair record of the head. */
export function sameIncidents(lines: readonly BenchLine[]): SameIncidents[] {
  const byCase = new Map<string, { records: number; differ: number; declared: number; missing: number }>();
  for (const line of lines) {
    if (line.record !== "pair" || line.pair !== PAIR) continue;
    let item = byCase.get(line.case);
    if (item === undefined) byCase.set(line.case, (item = { records: 0, differ: 0, declared: 0, missing: 0 }));
    const a = line.fields?.a?.extra?.incidents;
    const b = line.fields?.b?.extra?.incidents;
    if (a === undefined || b === undefined) item.missing += 1;
    else {
      item.records += 1;
      // Two builds with no fold version have the same version.
      if (a !== b) {
        if (line.fields?.a?.extra?.fold === line.fields?.b?.extra?.fold) item.differ += 1;
        else item.declared += 1;
      }
    }
  }
  return [...byCase.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ case: name, ...item }));
}

/** The memory of one build on one case: the largest values over the pair records of the head. A memory limit reads the largest value. */
export interface CaseMemory {
  readonly case: string;
  readonly arm: "base" | "head";
  /** The largest peak RSS of the children, in MB. */
  readonly peakRssMb: number | undefined;
  /** The largest heap after a full GC at the end of the children, in MB. */
  readonly heapMb: number | undefined;
}

/** This function gives the largest memory of each build on each case. Arm `a` of the pair of the head is the base. */
export function memoryOf(lines: readonly BenchLine[]): CaseMemory[] {
  const values = new Map<string, { peak: number[]; heap: number[] }>();
  for (const line of lines) {
    if (line.record !== "pair" || line.pair !== PAIR) continue;
    for (const [side, arm] of [
      ["a", "base"],
      ["b", "head"],
    ] as const) {
      const key = JSON.stringify([line.case, arm]);
      let item = values.get(key);
      if (item === undefined) values.set(key, (item = { peak: [], heap: [] }));
      const fields = line.fields?.[side];
      if (fields?.peakRss !== undefined) item.peak.push(fields.peakRss);
      if (fields?.extra?.heap !== undefined) item.heap.push(fields.extra.heap);
    }
  }
  const mbOf = (list: readonly number[]): number | undefined => (list.length === 0 ? undefined : Number((Math.max(...list) / MB).toFixed(1)));
  return [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => {
      const [name, arm] = JSON.parse(key) as [string, "base" | "head"];
      return { case: name, arm, peakRssMb: mbOf(item.peak), heapMb: mbOf(item.heap) };
    });
}

/** This function gives the cases of the gate: the verdict and the flip of each case with a limit, and the same incidents. */
export function gateCases(reads: readonly CaseRead[], same: readonly SameIncidents[], jobs: number): { readonly case: string; readonly outcome: LimitOutcome }[] {
  const enough = jobs >= MIN_JOBS;
  const cases: { readonly case: string; readonly outcome: LimitOutcome }[] = [];
  for (const read of reads) {
    if (read.limit === undefined) continue;
    cases.push({ case: `${read.case} ratio`, outcome: enough ? read.verdict.outcome : "cannot decide" });
    // A gate that cannot see the old build is no read.
    if (read.flip !== undefined) cases.push({ case: `${read.case} flip`, outcome: read.flip.outcome === "beyond" ? "within" : "cannot decide" });
  }
  const differ = same.reduce((total, item) => total + item.differ, 0);
  const records = same.reduce((total, item) => total + item.records, 0);
  cases.push({ case: "same incidents", outcome: differ > 0 ? "beyond" : records === 0 ? "cannot decide" : "within" });
  return cases;
}

function verdict(folder: string): void {
  const limits = limitsOf(process.env["FOLD_RATIO_LIMITS"]);
  const lines = linesIn(folder);
  const jobs = jobsOf(lines).length;
  const reads = readOf(lines, limits);
  for (const read of reads) {
    for (const item of read.verdict.pooled.cases) {
      console.log(JSON.stringify({ record: "case", case: item.case, limit: read.limit ?? null, ratio: item.ratio, low: item.low, high: item.high, bound: item.bound, outcome: read.limit === undefined ? null : item.outcome }));
    }
    for (const item of read.headNoise.pooled.cases) console.log(JSON.stringify({ record: "head noise", case: item.case, ratio: item.ratio, low: item.low, high: item.high }));
    console.log(JSON.stringify({ record: "verdict", case: read.case, outcome: read.limit === undefined ? null : read.verdict.outcome, flip: read.flip?.outcome ?? null, reason: read.verdict.reason }));
  }
  const same = sameIncidents(lines);
  for (const item of same) console.log(JSON.stringify({ record: "same incidents", ...item }));
  for (const item of memoryOf(lines)) console.log(JSON.stringify({ record: "memory", ...item }));
  const cases = gateCases(reads, same, jobs);
  // A difference of the incidents is a fault of the head, with or without a limit.
  const differ = cases.some((item) => item.case === "same incidents" && item.outcome === "beyond");
  if (limits.size === 0) {
    console.log(`report: ${String(jobs)} jobs, no limit.${differ ? " The two builds give different incidents." : ""}`);
    if (differ) process.exitCode = 1;
    return;
  }
  const gate = gateOf(cases);
  const reason = [...limits].map(([name, limit]) => `${name} at most ${String(limit)} times the base`).join(", ");
  writeGateLine(gateLine(cases, { title: "fold pair ratio", enforced: true, reason: `${reason}, over ${String(jobs)} jobs` }));
  writeGateVerdict(gate.outcome);
  console.log(`gate: ${gate.outcome}. ${reason}.`);
  if (gate.outcome !== "pass") process.exitCode = 1;
}

// The test of the bench imports this file. Only a start of the file itself reads the arguments.
const args = import.meta.main === true ? process.argv.slice(2) : [];
const [mode] = args;
if (mode === "--tree" && args[2] === "--log" && args[4] === "--case" && args.length === 6) await child(args[1]!, args[3]!, args[5]!);
else if (mode === "measure" && args.length >= 5) {
  const [, job, folder, base, cases, size, rounds] = args;
  await measure(Number(job), folder!, base!, cases!.split(","), size === undefined ? 192 : Number(size), rounds === undefined ? ROUNDS : Number(rounds));
} else if (mode === "verdict" && args[1] !== undefined) verdict(args[1]);
else if (mode !== undefined) throw new Error("Usage: fold-pair.ts measure <job> <folder> <base> <cases> [size] [rounds] | verdict <folder> | --tree <folder> --log <file> --case <case>");
