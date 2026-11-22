/**
 * This script measures the time of one merge add as the merge state grows (AL-87). The state has 1,000, 10,000 or 100,000
 * reports, with one delivery and one end mark for each 10 reports. Each case adds one event: a new report or a new delivery.
 *
 * Two arms time each case, and each child is a fresh process (`freshRun` of `@mark1russell7/rigor-bench`):
 *
 * - `rebuild`: the `normalize` of all the parts and the event. This is the add before AL-75. It is the base arm `a`.
 * - `add`: the `add` of the event. It is the candidate arm `b`.
 *
 * The A/A pair `rebuild~aa` gives the noise. The ratio `b / a` of a case is the cost of one add as a part of a rebuild.
 * The ratio of the runner cancels, thus the claim holds on each computer. Time on a shared computer tells nothing, thus the
 * workflow `measure-merge.yml` starts the script in CI.
 *
 * Usage:
 *
 * - `node scripts/merge-add.ts measure <job> [rounds]` gives one JSON line for the computer and one for each pair of children.
 * - `node scripts/merge-add.ts verdict <folder>` reads the lines of all the jobs in the folder. It gives the ratio of each
 *   case, the run limit over the jobs and the growth of the add with the size. With `MERGE_RATIO_LIMIT`, the verdict is a gate.
 * - `node scripts/merge-add.ts --arm <arm> --case <kind>:<size>` is the child of one arm on one case. `measure` starts it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  add,
  normalize,
  reportId,
  type ChannelId,
  type Delivery,
  type EndMark,
  type MergeParts,
  type MergeState,
  type ObservationId,
  type PersonId,
  type Report,
  type SourceId,
} from "@mark1russell7/alerts";
import {
  gateLine,
  gateOf,
  growthVerdict,
  limitVerdict,
  pooledLimitVerdict,
  runLimit,
  timeArm,
  writeGateLine,
  writeGateVerdict,
  type GrowthVerdict,
  type JobRecords,
  type LimitOutcome,
  type PairedTime,
  type PooledLimitVerdict,
} from "@mark1russell7/rigor-bench";
import { freshRun, peakRss } from "@mark1russell7/rigor-bench/fresh";

/** The sizes of the state: the count of its reports. */
export const SIZES = [1_000, 10_000, 100_000] as const;
/** The kinds of event. */
export const KINDS = ["report", "delivery"] as const;
/** The arms of the bench. */
export const ARMS = ["rebuild", "add"] as const;
type Kind = (typeof KINDS)[number];
type ArmId = (typeof ARMS)[number];
/** The id of the pair of the candidate. */
export const PAIR = "add";
/** The id of the A/A pair of the base. */
export const AA_PAIR = "rebuild~aa";

const T0 = 1_763_157_600_000;
const HOUR = 3_600_000;
const SOURCE = "nws-api" as SourceId;
const PERSON = "person-1" as PersonId;
const CHANNEL = "pushover" as ChannelId;
// The counted samples of one child. A sample is at least 10 ms of calls.
const SAMPLES = 15;
// The count of rounds of one job. An even count gives each order of each pair the same count of rounds.
const ROUNDS = 6;
// The fewest jobs of a gate read: the limit of a gate comes from 5 or more runs.
const MIN_JOBS = 5;

function report(index: number): Report {
  const sent = T0 + index * 1_000;
  const key = `bench-${String(index)}`;
  return {
    origin: "nws",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    received: sent,
    expires: sent + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "NWS Topeka KS",
    headline: "Tornado Warning",
    observation: "0".repeat(64) as ObservationId,
    parameters: {},
    id: reportId({ source: SOURCE, key, sent }),
    source: SOURCE,
    key,
    sent,
  };
}

function delivery(key: string, incident: Report, at: number): Delivery {
  return { key, incident: incident.id, level: "urgent", person: PERSON, channel: CHANNEL, step: 0, at };
}

/** This function gives the merge state of a size: the reports, one delivery and one end mark for each 10 reports. */
export function stateOf(size: number): MergeState {
  const reports = Array.from({ length: size }, (_, index) => report(index));
  const deliveries: Delivery[] = [];
  const ends: EndMark[] = [];
  for (let index = 0; index + 5 < size; index += 10) {
    deliveries.push(delivery(`m${String(index)}`, reports[index]!, T0 + index));
    ends.push({ report: reports[index + 5]!.id, at: T0 + HOUR, ended: true });
  }
  return normalize({ reports, deliveries, ends });
}

/** This function gives the one event of a kind for a state of a size. Each event is a part that the state does not have. */
export function eventOf(kind: Kind, size: number): MergeParts {
  return kind === "delivery" ? { deliveries: [delivery("m-new", report(1), T0 + HOUR)] } : { reports: [report(size)] };
}

/** This function is the add before AL-75: the `normalize` of all the parts of the state and of the new parts. */
export function rebuild(state: MergeState, parts: MergeParts): MergeState {
  return normalize({
    reports: [...state.reports, ...(parts.reports ?? [])],
    deliveries: [...state.deliveries, ...(parts.deliveries ?? [])],
    acks: [...state.acks, ...(parts.acks ?? [])],
    ends: [...state.ends, ...(parts.ends ?? [])],
    retired: [...state.retired, ...(parts.retired ?? [])],
  });
}

/** This function gives the step that an arm times on a case, after a check that the step adds its event. */
export function stepOf(arm: ArmId, kind: Kind, size: number): () => MergeState {
  const state = stateOf(size);
  const event = eventOf(kind, size);
  const step = arm === "rebuild" ? () => rebuild(state, event) : () => add(state, event);
  const next = step();
  const grew = kind === "delivery" ? next.deliveries.length === state.deliveries.length + 1 : next.reports.length === state.reports.length + 1;
  if (!grew) throw new Error(`The arm ${arm} on the case ${kind}:${String(size)} did not add its event.`);
  return step;
}

/** This function gives the kind and the size of a case id `<kind>:<size>`. */
export function caseOf(id: string): { readonly kind: Kind; readonly size: number } {
  const [kind, sizeText] = id.split(":");
  const size = Number(sizeText);
  if (!KINDS.includes(kind as Kind) || !SIZES.includes(size as (typeof SIZES)[number])) throw new RangeError(`The case ${id} is not a case of this bench.`);
  return { kind: kind as Kind, size };
}

function child(arm: string, id: string): void {
  if (!ARMS.includes(arm as ArmId)) throw new RangeError(`The arm ${arm} is not an arm of this bench.`);
  const { kind, size } = caseOf(id);
  const time = timeArm(stepOf(arm as ArmId, kind, size), { samples: SAMPLES });
  console.log(JSON.stringify({ ms: time.ms, warm: time.warm, peakRss: peakRss(), calls: time.calls }));
}

async function measure(job: number, rounds: number): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const armOf = (id: ArmId) => ({ id, command: [process.execPath, script, "--arm", id] });
  const run = await freshRun({
    base: armOf("rebuild"),
    candidates: [armOf("add")],
    cases: KINDS.flatMap((kind) => SIZES.map((size) => `${kind}:${String(size)}`)),
    rounds,
    roundOffset: job * rounds,
    job: String(job),
  });
  console.log(JSON.stringify({ record: "env", job: run.job, rounds, env: run.env, skipped: run.skipped }));
  for (const [pair, records] of Object.entries(run.pairs)) {
    for (const { env: _env, ...record } of records) console.log(JSON.stringify({ record: "pair", pair, ...record }));
  }
}

/** One line of a job: a pair of children, or the computer and the skips of the job. */
export type BenchLine =
  | (PairedTime & { readonly record: "pair"; readonly pair: string; readonly job: string })
  | { readonly record: "env"; readonly job: string; readonly skipped?: readonly { readonly case: string }[] };

function linesIn(folder: string): BenchLine[] {
  const out: BenchLine[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) out.push(...linesIn(path));
    else if (name.endsWith(".jsonl")) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        const value = JSON.parse(line) as { readonly record?: string };
        if (value.record === "pair" || value.record === "env") out.push(value as BenchLine);
      }
    }
  }
  return out;
}

/** This function gives the records of each job: the pairs of the candidate, the A/A pairs and the skips. */
export function jobsOf(lines: readonly BenchLine[]): JobRecords[] {
  const jobs = new Map<string, { candidate: PairedTime[]; aa: PairedTime[]; skipped: { readonly case: string }[] }>();
  for (const line of lines) {
    let job = jobs.get(line.job);
    if (job === undefined) jobs.set(line.job, (job = { candidate: [], aa: [], skipped: [] }));
    if (line.record === "env") job.skipped.push(...(line.skipped ?? []));
    else if (line.pair === PAIR) job.candidate.push(line);
    else if (line.pair === AA_PAIR) job.aa.push(line);
  }
  return [...jobs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([job, records]) => ({ job, ...records }));
}

/** The read of all the jobs: the run limit, the verdict of the add, the verdict of the flip and the growth of the add. */
export interface MergeRead {
  /** The largest bound of a case of each job alone, in the order of the jobs. */
  readonly bounds: readonly { readonly job: string; readonly bound: number }[];
  /** The worst bound of the jobs plus their spread: the limit that the jobs give. It needs 5 jobs or more. */
  readonly runLimit: number | undefined;
  /** The verdict of the claim "one add is at most the limit times a rebuild" over the pool of the jobs. */
  readonly add: PooledLimitVerdict;
  /** The same verdict with the A/A pairs as the candidate: the old add. It is `beyond` when the gate sees the old add. */
  readonly flip: PooledLimitVerdict;
  /** The growth of the time of one add for each step of 10 times in size, for each kind. It only reports. */
  readonly growth: Record<Kind, GrowthVerdict>;
}

/** This function gives the read of the jobs against a limit of the ratio `add / rebuild`. */
export function readOf(jobs: readonly JobRecords[], limit: number): MergeRead {
  // The bound of a case does not depend on the limit, thus the limit 1 gives the bounds of each job.
  const bounds = jobs.map((job) => ({ job: job.job, bound: Math.max(...limitVerdict(job.candidate, job.aa, { limit: 1 }).cases.map((item) => item.bound)) }));
  const values = bounds.map((item) => item.bound).filter((value) => Number.isFinite(value));
  const growthOf = (kind: Kind): GrowthVerdict =>
    growthVerdict(
      jobs.flatMap((job) =>
        job.candidate.filter((record) => caseOf(record.case).kind === kind).map((record) => ({ job: job.job, size: caseOf(record.case).size, value: record.b })),
      ),
      { maxGrowth: 10 },
    );
  return {
    bounds,
    runLimit: values.length >= MIN_JOBS ? runLimit(values).limit : undefined,
    add: pooledLimitVerdict(jobs, { limit }),
    flip: pooledLimitVerdict(
      jobs.map((job) => ({ ...job, candidate: job.aa })),
      { limit },
    ),
    growth: { report: growthOf("report"), delivery: growthOf("delivery") },
  };
}

function verdict(folder: string): void {
  const limitText = process.env["MERGE_RATIO_LIMIT"];
  const limit = limitText === undefined || limitText === "" ? undefined : Number(limitText);
  if (limit !== undefined && !(limit > 0 && limit < 1)) throw new RangeError("MERGE_RATIO_LIMIT must be a ratio above 0 and below 1.");
  const jobs = jobsOf(linesIn(folder));
  // Without a limit, the read only reports. The limit 1 asks only "one add costs less than a rebuild".
  const read = readOf(jobs, limit ?? 1);
  for (const item of read.add.pooled.cases) {
    console.log(JSON.stringify({ record: "case", case: item.case, ratio: item.ratio, low: item.low, high: item.high, bound: item.bound, outcome: item.outcome }));
  }
  for (const item of read.bounds) console.log(JSON.stringify({ record: "job", ...item }));
  console.log(JSON.stringify({ record: "run limit", jobs: jobs.length, limit: read.runLimit }));
  for (const kind of KINDS) {
    for (const { from, to, growths, median, low, high, exponent } of read.growth[kind].steps) {
      console.log(JSON.stringify({ record: "growth", kind, from, to, growths, median, low, high, exponent }));
    }
  }
  console.log(JSON.stringify({ record: "verdict", add: read.add.outcome, flip: read.flip.outcome, reason: read.add.reason }));
  if (limit === undefined) return;
  // The gate: the add is within the limit, and the old add (the rebuild) is beyond it. A gate that cannot see the old add
  // is no read. Fewer than 5 jobs give no read.
  const enough = jobs.length >= MIN_JOBS;
  const cases: { readonly case: string; readonly outcome: LimitOutcome }[] = [
    { case: "add ratio", outcome: enough ? read.add.outcome : "cannot decide" },
    { case: "rebuild flip", outcome: read.flip.outcome === "beyond" ? "within" : "cannot decide" },
  ];
  const gate = gateOf(cases);
  writeGateLine(gateLine(cases, { title: "merge add ratio", enforced: true, reason: `one add is at most ${String(limit)} times a rebuild, over ${String(jobs.length)} jobs` }));
  writeGateVerdict(gate.outcome);
  console.log(`gate: ${gate.outcome}. One add is at most ${String(limit)} times a rebuild.`);
  if (gate.outcome !== "pass") process.exitCode = 1;
}

// The test of the bench imports this file. Only a start of the file itself reads the arguments.
const [mode, first, second, third] = import.meta.main === true ? process.argv.slice(2) : [];
if (mode === "--arm" && first !== undefined && second === "--case" && third !== undefined) child(first, third);
else if (mode === "measure" && first !== undefined) await measure(Number(first), second === undefined ? ROUNDS : Number(second));
else if (mode === "verdict" && first !== undefined) verdict(first);
else if (mode !== undefined) throw new Error("Usage: merge-add.ts measure <job> [rounds] | verdict <folder> | --arm <arm> --case <kind>:<size>");
