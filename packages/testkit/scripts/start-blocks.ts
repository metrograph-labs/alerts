/**
 * This script measures the blocks of the event loop in a start and in its next passes (AL-115). It seeds one log with the
 * live cache files, and it opens the home two times with `openMeasuredRuntime`. The first start folds the whole log. The
 * second start reads the snapshot that the first start wrote. Time on a shared computer tells nothing, thus the workflow
 * `measure-blocks.yml` starts it in CI.
 *
 * Usage: node scripts/start-blocks.ts <folder> [size in MB] [passes].
 *
 * Each start gives one JSON line. For each phase, the line has the wall time, the CPU time, the blocks of the event loop and
 * the pauses of the garbage collector. A phase is the open with its first pass, or one more pass. The line also has the time
 * of each write of the snapshot: the build of the rows apart from the write of SQLite. It also has the longest part between two
 * pauses of the write.
 */
import { statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { CONFIG_FORMAT, type AlertConfig, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { openMeasuredRuntime, START_SNAPSHOT_FILE, type MeasuredRuntime } from "@mark1russell7/alerts-runtime";
import { wallClock } from "@mark1russell7/algebra/clock";
import { LIVE_FILES } from "../src/seed-files.ts";
import { seedStore } from "../src/seed-store.ts";

const [folder, sizeText = "192", passesText = "4"] = process.argv.slice(2);
if (folder === undefined) throw new Error("Give a scratch folder.");
const size = Number(sizeText);
const passes = Number(passesText);
if (!(size > 0) || !Number.isInteger(passes) || passes < 2) throw new RangeError("Give a size above 0 MB and 2 or more passes.");

// The timer of the recorder ticks at this period. A gap above `LONG_MS` between two ticks is one block of the loop.
const TICK_MS = 10;
const LONG_MS = 100;
const MINUTE = 60_000;
const round = (value: number): number => Math.round(value * 10) / 10;

// A made-up configuration with one public point in McMullen County TX. No request leaves the measure.
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;
const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });
const config: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [-98.55, 28.3],
      codes: [
        { system: "state", code: "TX" },
        { system: "ugc", code: "TXC311" },
        { system: "same", code: "048311" },
        { system: "iso3166", code: "US" },
      ],
      bufferKm: 5,
    },
  ],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [{ person, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } }],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
};

/** One block of the event loop (the gap between two ticks of the timer, from the tick before), or one pause of the collector. */
interface Block {
  readonly start: number;
  readonly ms: number;
}

// Node gives a histogram of the delay of the loop (`monitorEventLoopDelay`), but not the time of each block. The phases
// need the time of each block, thus the recorder keeps each long gap of its own timer.
function recordBlocks(): { readonly found: readonly Block[]; stop(): void } {
  const found: Block[] = [];
  let last = performance.now();
  let timer: NodeJS.Timeout;
  const tick = (): void => {
    const now = performance.now();
    if (now - last > LONG_MS) found.push({ start: last, ms: now - last });
    last = now;
    timer = setTimeout(tick, TICK_MS);
  };
  timer = setTimeout(tick, TICK_MS);
  return { found, stop: () => clearTimeout(timer) };
}

interface Phase {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly cpuMs: number;
}

async function phase(name: string, phases: Phase[], work: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  const cpu = process.cpuUsage();
  await work();
  const used = process.cpuUsage(cpu);
  const end = performance.now();
  // A pass can end with no turn of the timers, because its promises settle as microtasks. The wait gives the recorder one
  // tick, thus it keeps a block at the end of the phase.
  await new Promise((resolve) => setTimeout(resolve, 2 * TICK_MS));
  phases.push({ name, start, end, cpuMs: (used.user + used.system) / 1000 });
}

// The tick before a block often comes before the start of its phase, because a phase starts its work with no wait. Thus a
// block goes to the phase that it overlaps most. A block that overlaps no phase goes to no phase.
const overlap = (block: Block, each: Phase): number => Math.max(0, Math.min(block.start + block.ms, each.end) - Math.max(block.start, each.start));
function phaseOf(block: Block, phases: readonly Phase[]): Phase | undefined {
  let best: Phase | undefined;
  for (const each of phases) if (overlap(block, each) > (best === undefined ? 0 : overlap(block, best))) best = each;
  return best;
}

const fileBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const dir = join(folder, `seed-${sizeText}mb`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const seeded = await seedStore(dir, { log: size * 1_000_000, seed: "al105", shapes: LIVE_FILES.shapes, transit: LIVE_FILES.transit });
writeFileSync(join(dir, "config.json"), JSON.stringify(config));

for (const kind of ["full", "snapshot"] as const) {
  const phases: Phase[] = [];
  const recorder = recordBlocks();
  const pauses: PerformanceEntry[] = [];
  const collector = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
  collector.observe({ entryTypes: ["gc"] });
  let measured: MeasuredRuntime | undefined;
  const lines: string[] = [];
  try {
    await phase("open", phases, async () => {
      measured = await openMeasuredRuntime(dir, { wall: wallClock({ start: seeded.end }), startSnapshot: true, timeSnapshot: true, report: (line) => lines.push(line) });
    });
    for (let at = 2; at <= passes; at += 1) await phase(`pass-${String(at)}`, phases, () => measured!.pass());
  } finally {
    recorder.stop();
    pauses.push(...collector.takeRecords());
    collector.disconnect();
    await measured?.close();
  }
  const gc: Block[] = pauses.map((entry) => ({ start: entry.startTime, ms: entry.duration }));
  const writes = measured!.snapshotWrites;
  // A block overlaps a write when the two intervals share a point. The interval of a write has its pauses. The longest block
  // outside each write is the work of the pass apart from the snapshot.
  const inWrite = (block: Block): boolean => writes.some((write) => block.start < write.at + write.wallMs && block.start + block.ms > write.at);
  const record = {
    kind: "start",
    start: kind,
    size,
    events: seeded.events,
    days: Number(((seeded.end - seeded.start) / 86_400_000).toFixed(2)),
    tickMs: TICK_MS,
    longMs: LONG_MS,
    openedMs: round(measured!.opened - phases[0]!.start),
    phases: phases.map((each) => {
      const own = recorder.found.filter((block) => phaseOf(block, phases) === each);
      const outside = own.filter((block) => !inWrite(block));
      const collected = gc.filter((pause) => phaseOf(pause, phases) === each);
      return {
        name: each.name,
        ms: round(each.end - each.start),
        cpuMs: round(each.cpuMs),
        blocks: own.length,
        blockedMs: round(own.reduce((sum, block) => sum + block.ms, 0)),
        longestMs: round(Math.max(0, ...own.map((block) => block.ms))),
        longestOutsideWriteMs: round(Math.max(0, ...outside.map((block) => block.ms))),
        gcPauses: collected.length,
        gcMs: round(collected.reduce((sum, pause) => sum + pause.ms, 0)),
        longestGcMs: round(Math.max(0, ...collected.map((pause) => pause.ms))),
        top: [...own]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 5)
          .map((block) => ({ atMs: round(block.start - each.start), ms: round(block.ms), write: inWrite(block) })),
      };
    }),
    writes: writes.map((write) => ({
      phase: phases.find((each) => write.at >= each.start && write.at < each.end)?.name ?? "none",
      rows: write.rows,
      chars: write.chars,
      rowsMs: round(write.rowsMs),
      writeMs: round(write.writeMs),
      cpuMs: round(write.cpuMs),
      wallMs: round(write.wallMs),
      longestMs: round(write.longestMs),
      chunks: write.chunks,
    })),
    files: { snapshot: fileBytes(join(dir, START_SNAPSHOT_FILE)), wal: fileBytes(join(dir, `${START_SNAPSHOT_FILE}-wal`)) },
    reports: lines.length,
  };
  console.log(JSON.stringify(record));
}
await rm(dir, { recursive: true, force: true });
