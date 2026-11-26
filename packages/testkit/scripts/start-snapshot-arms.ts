/**
 * This script measures the start of the runtime with the snapshot of the start and with no snapshot (AL-105, step 3).
 * Each child is a fresh process (`freshArms` of `@mark1russell7/rigor-bench`), and the order of the two arms turns in each round:
 *
 * - `full`: the start folds the whole log, as a start with no snapshot does.
 * - `snapshot`: the start reads the snapshot, and it folds only the events after its mark.
 *
 * The script seeds one home for each size of the log, and a child of the mode `prepare` writes the snapshot of that home.
 * Before each child, the step `before` copies the home to a new folder. Thus each child starts on the same files.
 * The value of a child is the time from the start of its process to the end of the fold of its state. After that point,
 * the probe `/readiness` of a live start passes soon. The line of the child also has the CPU time and the peak of the resident memory.
 *
 * The mode `verdict` reads the records of one or more jobs. For each arm and each value, it gives the growth over the
 * sizes of the log with `growthVerdict`. With the snapshot, the start does not grow with the age of the log. With no
 * snapshot, it grows with the log. Time on a shared computer tells nothing, thus the workflow `measure-snapshot.yml` starts
 * the script in CI. It is a measure, not a gate.
 *
 * Usage:
 *
 * - `node scripts/start-snapshot-arms.ts measure <folder> <job> <sizes in MB, with commas> [rounds]`
 * - `node scripts/start-snapshot-arms.ts verdict <records file>...`
 *
 * The mode `measure` writes one JSON line for each child. With the variable `GITHUB_STEP_SUMMARY`, the mode `verdict` also
 * appends its table to that file.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { growthVerdict, type GrowthVerdict } from "@mark1russell7/rigor-bench";
import { median } from "@mark1russell7/rigor-statistics";
import { freshArms, peakRss, processMemory, type ArmProcess } from "@mark1russell7/rigor-bench/fresh";

/** The two arms of the measure. */
export const ARMS = ["full", "snapshot"] as const;
export type Arm = (typeof ARMS)[number];

/** The values of each child that the verdict reads. */
export const VALUES = ["openMs", "cpuMs", "peakRss"] as const;
export type Value = (typeof VALUES)[number];

/**
 * The claim of the verdict: the largest growth of a value for each step of 10 times in the size of the log. With the
 * snapshot, a value grows by at most 2 times for 10 times of the log, an exponent of 0.3. A start with no snapshot folds
 * each event, thus its time grows by approximately 10 times, and it is beyond the claim.
 */
export const MAX_GROWTH = 2;

const SCRIPT = fileURLToPath(import.meta.url);

/** The id of the case of an arm at a size of the log in MB. */
export function caseId(arm: Arm, size: number): string {
  return `${arm}-${String(size)}`;
}

/** This function reads a case id. A bad id is an error. */
export function readCase(id: string): { readonly arm: Arm; readonly size: number } {
  const match = /^(full|snapshot)-(\d+)$/.exec(id);
  if (match === null) throw new RangeError(`The case ${id} is not <arm>-<size in MB>.`);
  return { arm: match[1] as Arm, size: Number(match[2]) };
}

/** This function reads a list of sizes in MB, with commas. Each size is a whole number above 0, and the list has 2 or more. */
export function readSizes(text: string): number[] {
  const sizes = text.split(",").map((part) => Number(part.trim()));
  if (sizes.length < 2 || sizes.some((size) => !Number.isInteger(size) || size <= 0)) throw new RangeError(`Give 2 or more sizes in MB with commas, not ${text}.`);
  return [...new Set(sizes)].sort((a, b) => a - b);
}

/** One record of one child: the job, the case and the values of the child. */
export interface ChildRecord {
  readonly record: "child";
  readonly job: string;
  readonly arm: Arm;
  readonly size: number;
  readonly round: number;
  readonly openMs: number;
  readonly cpuMs: number;
  readonly peakRss: number;
  readonly events: number;
}

/** This function makes the record of a child of `freshArms`. A child line with no number of a value is an error. */
export function childRecord(job: string, child: ArmProcess): ChildRecord {
  const { arm, size } = readCase(child.case);
  const extra = child.fields?.extra ?? {};
  const number = (name: string, value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`The child of ${child.case} in round ${String(child.round)} has no number ${name}.`);
    return value;
  };
  return {
    record: "child",
    job,
    arm,
    size,
    round: child.round,
    openMs: number("ms", child.ms),
    cpuMs: number("cpuMs", extra["cpuMs"]),
    peakRss: number("peakRss", child.fields?.peakRss),
    events: number("events", extra["logEvents"]),
  };
}

/** This function gives the growth verdict of each arm and value. Each job gives the median of its rounds at each size. */
export function verdicts(records: readonly ChildRecord[]): { readonly arm: Arm; readonly value: Value; readonly verdict: GrowthVerdict }[] {
  const out: { arm: Arm; value: Value; verdict: GrowthVerdict }[] = [];
  for (const arm of ARMS) {
    const own = records.filter((record) => record.arm === arm);
    const groups = new Map<string, ChildRecord[]>();
    for (const record of own) {
      const key = `${record.job}\u0000${String(record.size)}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    for (const value of VALUES) {
      const rounds = [...groups.values()].map((group) => ({ job: group[0]!.job, size: group[0]!.size, value: median(group.map((record) => record[value])) }));
      if (rounds.length > 0) out.push({ arm, value, verdict: growthVerdict(rounds, { maxGrowth: MAX_GROWTH }) });
    }
  }
  return out;
}

/** This function gives the table of the verdicts in Markdown. */
export function verdictTable(records: readonly ChildRecord[]): string {
  const rows = verdicts(records).flatMap(({ arm, value, verdict }) =>
    verdict.steps.map((step) => `| ${arm} | ${value} | ${String(step.from)} to ${String(step.to)} MB | ${step.median.toFixed(2)} | ${step.low.toFixed(2)} to ${step.high.toFixed(2)} | ${step.exponent.toFixed(2)} | ${step.outcome} |`),
  );
  const sizes = [...new Set(records.map((record) => record.size))].sort((a, b) => a - b);
  const medians = ARMS.flatMap((arm) =>
    sizes.map((size) => {
      const own = records.filter((record) => record.arm === arm && record.size === size);
      if (own.length === 0) return `| ${arm} | ${String(size)} | 0 | | | |`;
      return `| ${arm} | ${String(size)} | ${String(own.length)} | ${median(own.map((record) => record.openMs)).toFixed(0)} | ${median(own.map((record) => record.cpuMs)).toFixed(0)} | ${(median(own.map((record) => record.peakRss)) / 1_048_576).toFixed(0)} |`;
    }),
  );
  return [
    "### The start with the snapshot and with no snapshot (AL-105)",
    "",
    "| arm | log MB | children | median open ms | median CPU ms | median peak RSS MiB |",
    "| --- | --- | --- | --- | --- | --- |",
    ...medians,
    "",
    `The growth is the change of the median for 10 times of the log. The claim permits at most ${String(MAX_GROWTH)} times.`,
    "",
    "| arm | value | step | growth | interval | exponent | outcome |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** This function reads the child records of one or more files of JSON lines. Lines of other records stay out. */
export function readRecords(texts: readonly string[]): ChildRecord[] {
  return texts.flatMap((text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { record?: unknown })
      .filter((line): line is ChildRecord => line.record === "child"),
  );
}

const homeOf = (folder: string, size: number): string => join(folder, `home-${String(size)}mb`);
const runOf = (folder: string): string => join(folder, "run");

/** The mode `child`: one start of the runtime in the folder `run`, and one JSON line for `freshArms`. */
async function child(folder: string, id: string): Promise<void> {
  const { arm } = readCase(id);
  const { openMeasuredRuntime } = await import("@mark1russell7/alerts-runtime");
  const { wallClock } = await import("@mark1russell7/algebra/clock");
  const { SEED_RECORD_FILE } = await import("../src/seed-home.ts");
  const home = runOf(folder);
  const seed = JSON.parse(readFileSync(join(home, SEED_RECORD_FILE), "utf8")) as { readonly end: number; readonly events: number };
  const measured = await openMeasuredRuntime(home, { wall: wallClock({ start: seed.end }), startSnapshot: arm === "snapshot" });
  const used = process.cpuUsage();
  const memory = processMemory();
  // Each arm proves its kind of start. Else the measure gives two arms of one kind.
  const read = measured.instance.runtime.start;
  if ((read.snapshot !== undefined) !== (arm === "snapshot")) throw new Error(`The start of the arm ${arm} ${read.snapshot === undefined ? "read no snapshot" : "read a snapshot"}.`);
  const line = { ms: measured.opened, peakRss: peakRss(), cpuMs: (used.user + used.system) / 1000, rss: memory.rss, heapUsed: memory.heapUsed, logEvents: seed.events, foldedEvents: read.events };
  await measured.close();
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** The mode `prepare`: one start that folds the whole log of a home and writes its snapshot. */
async function prepare(home: string): Promise<void> {
  const { openMeasuredRuntime, START_SNAPSHOTS_FOLDER } = await import("@mark1russell7/alerts-runtime");
  const { wallClock } = await import("@mark1russell7/algebra/clock");
  const { SEED_RECORD_FILE } = await import("../src/seed-home.ts");
  const seed = JSON.parse(readFileSync(join(home, SEED_RECORD_FILE), "utf8")) as { readonly end: number };
  const measured = await openMeasuredRuntime(home, { wall: wallClock({ start: seed.end }), startSnapshot: true, timeSnapshot: true, snapshotFloor: 1 });
  // The first pass comes before the good start, thus the start writes its snapshot at the second pass. The floor 1 permits a
  // write for each size of the seed, also a seed with fewer events than `START_SNAPSHOT_FLOOR`.
  await measured.pass();
  const writes = measured.snapshotWrites.length;
  await measured.close();
  // The store keeps one file for each key of the start in the folder `START_SNAPSHOTS_FOLDER`, not in the old single file.
  const folder = join(home, START_SNAPSHOTS_FOLDER);
  const names = (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []).filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"));
  const bytes = names.reduce((sum, entry) => sum + statSync(join(folder, entry.name)).size, 0);
  if (writes === 0 || bytes === 0) throw new Error(`The start of ${home} wrote no snapshot (${String(writes)} writes, ${String(bytes)} bytes in ${START_SNAPSHOTS_FOLDER}). The arm snapshot has nothing to read.`);
}

/** The mode `measure`: the seed and the snapshot of each size, and then the arms of each size in fresh processes. */
async function measure(folder: string, job: string, sizes: readonly number[], rounds: number): Promise<void> {
  const { seedHome } = await import("../src/seed-home.ts");
  for (const size of sizes) {
    const home = homeOf(folder, size);
    rmSync(home, { recursive: true, force: true });
    const seeded = await seedHome(home, { log: size * 1_000_000, seed: "al105" });
    execFileSync(process.execPath, [SCRIPT, "prepare", home], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(JSON.stringify({ record: "home", job, size, events: seeded.events, bytes: seeded.bytes }));
    const run = await freshArms({
      arms: ARMS.map((arm) => ({ id: arm, case: caseId(arm, size) })),
      command: [process.execPath, SCRIPT, "child", folder],
      args: (id) => [id],
      rounds,
      job,
      timeoutMs: 1_200_000,
      before: () => {
        rmSync(runOf(folder), { recursive: true, force: true });
        cpSync(home, runOf(folder), { recursive: true });
        return Promise.resolve();
      },
    });
    if (size === sizes[0]) console.log(JSON.stringify({ record: "env", job, rounds, env: run.env, warnings: run.warnings }));
    for (const each of run.processes) console.log(JSON.stringify(childRecord(job, each)));
    rmSync(home, { recursive: true, force: true });
  }
  rmSync(runOf(folder), { recursive: true, force: true });
}

if (import.meta.main === true) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "child" && rest.length === 2) await child(rest[0]!, rest[1]!);
  else if (mode === "prepare" && rest.length === 1) await prepare(rest[0]!);
  else if (mode === "measure" && (rest.length === 3 || rest.length === 4)) {
    const rounds = Number(rest[3] ?? "4");
    if (!Number.isInteger(rounds) || rounds < 2 || rounds % 2 !== 0) throw new RangeError("Give an even count of rounds of 2 or more.");
    await measure(rest[0]!, rest[1]!, readSizes(rest[2]!), rounds);
  } else if (mode === "verdict" && rest.length > 0) {
    const table = verdictTable(readRecords(rest.map((path) => readFileSync(path, "utf8"))));
    process.stdout.write(table);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") appendFileSync(summary, table);
  } else throw new Error("Give the mode measure <folder> <job> <sizes> [rounds], or verdict <records file>...");
}
