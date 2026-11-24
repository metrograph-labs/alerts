/**
 * This script measures the memory of the watch of long blocks of the runtime (AL-119). The watch has a worker thread, and
 * each worker thread has its own V8 isolate. Two arms start `live-heap.ts` on the case of no alert and one person, and each
 * child is a fresh process (`freshArms` of `@mark1russell7/rigor-bench`):
 *
 * - `off`: the start with no watch.
 * - `on`: the same start with the watch and its worker (`--block-watch`).
 *
 * The order of the arms turns in each round. The change of a round is the value of `on` less the value of `off`. Memory on a
 * shared computer tells little, thus the workflow `measure-start.yml` starts the script in CI. It is a measure, not a gate.
 *
 * Usage: `node scripts/block-watch-memory.ts <folder> [rounds]`. The script writes the record of each child to
 * `<folder>/block-watch.jsonl`, and it writes a table of the change of each round to its output. With the variable
 * `GITHUB_STEP_SUMMARY`, it also appends the table to that file.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshArms, type ArmProcess } from "@mark1russell7/rigor-bench/fresh";

/** The fields of the line of `live-heap.ts` that the table reads, in bytes. */
export const MEMORY_FIELDS = ["rss", "peakRss", "heap"] as const;

const MIB = 1_048_576;
const SCRIPT = fileURLToPath(new URL("./live-heap.ts", import.meta.url));

/** This function gives a field of the line of a child in bytes. A field that is not a number is an error. */
function fieldOf(record: ArmProcess, field: (typeof MEMORY_FIELDS)[number]): number {
  const value = field === "peakRss" ? record.fields?.peakRss : record.fields?.extra?.[field];
  if (typeof value !== "number") throw new Error(`The child of the arm ${record.arm} in round ${String(record.round)} has no number ${field}.`);
  return value;
}

/** This function gives the table of the change of each round, in MiB. A round needs one child of each arm. */
export function changeTable(processes: readonly ArmProcess[]): string {
  const rounds = [...new Set(processes.map((record) => record.round))].sort((a, b) => a - b);
  const rows = rounds.map((round) => {
    const of = (arm: string): ArmProcess => {
      const found = processes.find((record) => record.round === round && record.arm === arm);
      if (found === undefined) throw new Error(`The round ${String(round)} has no child of the arm ${arm}.`);
      return found;
    };
    const cells = MEMORY_FIELDS.map((field) => ((fieldOf(of("on"), field) - fieldOf(of("off"), field)) / MIB).toFixed(1));
    return `| ${String(round)} | ${(fieldOf(of("off"), "rss") / MIB).toFixed(1)} | ${cells.join(" | ")} |`;
  });
  return [
    "### The memory of the watch of long blocks (AL-119)",
    "",
    "The change is the value with the watch less the value with no watch, in MiB.",
    "",
    `| round | rss with no watch | ${MEMORY_FIELDS.map((field) => `change of ${field}`).join(" | ")} |`,
    `| --- | --- | ${MEMORY_FIELDS.map(() => "---").join(" | ")} |`,
    ...rows,
    "",
  ].join("\n");
}

if (import.meta.main === true) {
  const [folder, roundsText] = process.argv.slice(2);
  if (folder === undefined) throw new Error("Give the folder of the records.");
  const rounds = Number(roundsText ?? "4");
  if (!Number.isInteger(rounds) || rounds < 2 || rounds % 2 !== 0) throw new RangeError("Give an even count of rounds of 2 or more.");
  mkdirSync(folder, { recursive: true });
  const run = await freshArms({
    arms: [
      { id: "off", case: "off" },
      { id: "on", case: "on" },
    ],
    command: [process.execPath, "--expose-gc", SCRIPT, "0", "1"],
    args: (id) => (id === "on" ? ["--block-watch"] : []),
    rounds,
  });
  writeFileSync(join(folder, "block-watch.jsonl"), run.processes.map((record) => `${JSON.stringify({ ...record, env: run.env })}\n`).join(""));
  const table = changeTable(run.processes);
  process.stdout.write(table);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, table);
}
