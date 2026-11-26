/**
 * This script measures where the CPU time of a start goes (AL-114). It seeds one log, and then it rebuilds the log with each
 * retention variant. Each variant has one timed rebuild and one rebuild under the CPU profiler of the process. The record of a
 * variant gives the time and the count of retirements. It also gives the functions with the most self time and the
 * inclusive time of the functions of the retire step. With the flag `--expose-gc` of Node, the record also gives the heap
 * after the timed rebuild (AL-116). The workflow `measure-fold.yml` starts it in CI. A time on a shared computer tells nothing.
 *
 * Usage: node scripts/fold-profile.ts <folder> [size in MB] [variants].
 * The variants are a comma list. `off` has no retire step, as a start before AL-109. A number is the quiet horizon in hours.
 */
import { mkdir, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { FOLD_TYPES, openRuntimeLog, rebuild, type FoldContext } from "@mark1russell7/alerts-runtime";
import { profileSummary, type Profile } from "../src/cpu-profile.ts";
import { seedStore } from "../src/seed-store.ts";

const [folder, sizeText = "192", variantList = "off,168,6"] = process.argv.slice(2);
if (folder === undefined) throw new Error("Give a scratch folder.");
const HOUR = 3_600_000;
const HORIZON = 168 * HOUR;
const LIFE = 720 * HOUR;
const size = Number(sizeText);
if (!Number.isFinite(size) || size <= 0) throw new Error(`The size ${sizeText} is not a number of MB above 0.`);

// The heap in MiB after a full collection, or `undefined` when Node has no flag `--expose-gc`. The state of the rebuild and
// the caches of the core live during the read.
function heapMb(): number | undefined {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return undefined;
  gc();
  return Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(1));
}

// The functions of the retire step, for their inclusive time. A name that the profile does not hold gives 0.
const STEP_FUNCTIONS = ["retirementAt", "retiredEvent", "incidents", "groupsOf", "changedBuild", "componentsOf", "cachedIncident", "quietKeeps", "retirements", "foldRetired", "compact", "normalize", "withSides", "join", "foldRest"];

// The summary of the rebuild. The field `rebuildMs` keeps the name of the records before AL-150.
function foldSummary(profile: Profile): object {
  const { totalMs, ...rest } = profileSummary(profile, { root: "rebuild", steps: STEP_FUNCTIONS });
  return { rebuildMs: totalMs, ...rest };
}

const dir = join(folder, `seed-${size}mb`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const seeded = await seedStore(dir, { log: size * 1_000_000, seed: "al105", retention: { horizon: HORIZON, life: LIFE, every: HOUR } });
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 200 });

for (const variant of variantList.split(",")) {
  const quiet = variant === "off" ? undefined : Number(variant) * HOUR;
  if (quiet !== undefined && !Number.isFinite(quiet)) throw new Error(`The variant ${variant} is not off or a number of hours.`);
  const context: FoldContext = { sources: [], ...(quiet === undefined ? {} : { retention: { horizon: HORIZON, life: LIFE, every: HOUR, quiet } }) };
  const once = (): { readonly ms: number; readonly retirements: number; readonly reports: number; readonly heapMb: number | undefined } => {
    const log = openRuntimeLog(seeded.path);
    let retirements = 0;
    const began = performance.now();
    const state = rebuild(log.read(FOLD_TYPES), context, () => {
      retirements += 1;
    });
    const ms = performance.now() - began;
    log.close();
    const heap = heapMb();
    return { ms: Number(ms.toFixed(0)), retirements, reports: state.merge.reports.length, heapMb: heap };
  };
  const timed = once();
  await session.post("Profiler.start");
  const profiled = once();
  const { profile } = (await session.post("Profiler.stop")) as { profile: Profile };
  console.log(
    JSON.stringify({
      variant,
      size,
      days: Number(((seeded.end - seeded.start) / 86_400_000).toFixed(2)),
      events: seeded.events,
      ms: timed.ms,
      profiledMs: profiled.ms,
      retirements: timed.retirements,
      reports: timed.reports,
      ...(timed.heapMb === undefined ? {} : { heapMb: timed.heapMb }),
      profile: foldSummary(profile),
    }),
  );
}
session.disconnect();
