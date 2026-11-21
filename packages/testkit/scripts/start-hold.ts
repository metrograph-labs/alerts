/**
 * This script measures what a start reads from a seeded log, and what it holds (AL-105, AL-109). It gives counts and
 * JSON bytes only, with no time and no heap. The workflow `measure-state.yml` starts it in CI.
 *
 * Usage: node scripts/start-hold.ts <folder> <sizes in MB> <horizons in hours> [life in hours] [quiet horizons in hours].
 * Each list is a comma list. With no life, the life has the live ratio to the horizon. With no quiet horizon, the default applies.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_RUNTIME, FOLD_TYPES, fold, openRuntimeLog, rebuild, type FoldContext, type RuntimeEvent, type RuntimeState } from "@mark1russell7/alerts-runtime";
import { seedStore } from "../src/seed-store.ts";

const [folder, sizesText = "8,16,32", hoursList = "6", lifeText, quietList = ""] = process.argv.slice(2);
if (folder === undefined) throw new Error("Give a scratch folder.");
const HOUR = 3_600_000;
const bytesOf = (value: unknown): number => JSON.stringify(value).length;

// The merge parts of an event, as the rebuild collects them: [key of the incident or report, part].
function parts(event: RuntimeEvent): [string, unknown][] {
  switch (event.type) {
    case "fetch":
    case "system":
      return event.reports.map((report) => [`report:${report.id}`, report]);
    case "delivery":
      return [[`delivery:${event.delivery.incident}`, event.delivery]];
    case "acknowledgment":
      return [[`ack:${event.acknowledgment.incident}`, event.acknowledgment]];
    case "ended":
    case "back":
      return event.reports.map((report) => [`end:${report}`, { report, at: event.time }]);
    case "import":
      return parts(event.event as RuntimeEvent);
    default:
      return [];
  }
}

// A collector that compacts when it doubles: it holds the distinct parts at the last compaction plus the parts after it.
// The distinct parts have the bytes of the last version of each key. A retirement removes its reports.
function doubling(): { push(key: string, bytes: number): void; retire(kept: ReadonlySet<string>): void; held(): { count: number; bytes: number } } {
  const last = new Map<string, number>();
  let base = { count: 0, bytes: 0 };
  let buffer = { count: 0, bytes: 0 };
  const compact = (): void => {
    let bytes = 0;
    for (const b of last.values()) bytes += b;
    base = { count: last.size, bytes };
    buffer = { count: 0, bytes: 0 };
  };
  return {
    push(key, bytes) {
      last.set(key, bytes);
      buffer = { count: buffer.count + 1, bytes: buffer.bytes + bytes };
      if (buffer.count >= Math.max(base.count, 4096)) compact();
    },
    retire(kept) {
      for (const key of last.keys()) if (!kept.has(idOf(key))) last.delete(key);
      compact();
    },
    held: () => ({ count: base.count + buffer.count, bytes: base.bytes + buffer.bytes }),
  };
}

// The report id of the key of a part.
const idOf = (key: string): string => key.slice(key.indexOf(":") + 1);

const mergeParts = (state: RuntimeState): number => {
  const m = state.own.merge;
  return m.reports.length + m.deliveries.length + m.acks.length + m.ends.length;
};

for (const hoursText of hoursList.split(","))
for (const size of sizesText.split(",").map(Number)) {
  const horizon = Number(hoursText) * HOUR;
  // With no life in hours, the life of a tombstone has the live ratio to the horizon: 30 days to 7 days.
  const life = lifeText === undefined || lifeText === "" ? Math.round((horizon * 30) / 7) : Number(lifeText) * HOUR;
  // One log for each size and horizon, from a seeder with the default quiet horizon. Each quiet horizon folds the same log.
  const dir = join(folder, `seed-${size}mb-${hoursText}h`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const seeded = await seedStore(dir, { log: size * 1_000_000, seed: "al105", retention: { horizon, life, every: HOUR } });
  for (const quietText of quietList === "" ? [undefined] : quietList.split(",")) {
  const quiet = quietText === undefined ? undefined : Number(quietText) * HOUR;
  const context: FoldContext = { sources: [], retention: { horizon, life, every: HOUR, ...(quiet === undefined ? {} : { quiet }) } };
  const log = openRuntimeLog(seeded.path);
  const read = { events: 0, bytes: 0, byType: {} as Record<string, { count: number; bytes: number }> };
  // The parts that the rebuild holds: the own parts since the last retirement, the own parts that the last compaction kept,
  // and each imported part of a report that did not retire. The incremental fold gives the kept own parts.
  let state = EMPTY_RUNTIME;
  let ownWindow = { count: 0, bytes: 0 };
  let ownKept = { count: 0, bytes: 0 };
  const imported = new Map<string, { count: number; bytes: number }>();
  let importedHeld = { count: 0, bytes: 0 };
  let peak = { count: 0, bytes: 0, at: 0 };
  let versions = 0;
  let versionBytes = 0;
  const ownDoubling = doubling();
  const importedDoubling = doubling();
  let peakCompacted = { count: 0, bytes: 0, at: 0 };
  let retirements = 0;
  for (const event of log.read(FOLD_TYPES)) {
    const bytes = bytesOf(event);
    read.events += 1;
    read.bytes += bytes;
    const entry = (read.byType[event.type] ??= { count: 0, bytes: 0 });
    entry.count += 1;
    entry.bytes += bytes;
    // The step of the retirement comes before the event, thus the fold comes before the parts of the event.
    const retired: Set<string>[] = [];
    state = fold(state, event, context, (merge) => retired.push(new Set(merge.reports.map((one) => one.id))));
    for (const kept of retired) {
      retirements += 1;
      ownDoubling.retire(kept);
      importedDoubling.retire(kept);
      for (const [key, gone] of imported) {
        if (kept.has(idOf(key))) continue;
        importedHeld = { count: importedHeld.count - gone.count, bytes: importedHeld.bytes - gone.bytes };
        imported.delete(key);
      }
      const m = state.own.merge;
      ownKept = { count: mergeParts(state), bytes: bytesOf([m.reports, m.deliveries, m.acks, m.ends]) };
      ownWindow = { count: 0, bytes: 0 };
    }
    for (const [key, part] of parts(event)) {
      const b = bytesOf(part);
      versions += 1;
      versionBytes += b;
      (event.type === "import" ? importedDoubling : ownDoubling).push(key, b);
      if (event.type === "import") {
        const held = imported.get(key) ?? { count: 0, bytes: 0 };
        imported.set(key, { count: held.count + 1, bytes: held.bytes + b });
        importedHeld = { count: importedHeld.count + 1, bytes: importedHeld.bytes + b };
      } else ownWindow = { count: ownWindow.count + 1, bytes: ownWindow.bytes + b };
    }
    const held = { count: ownKept.count + ownWindow.count + importedHeld.count, bytes: ownKept.bytes + ownWindow.bytes + importedHeld.bytes };
    if (held.bytes > peak.bytes) peak = { ...held, at: read.events };
    const a = ownDoubling.held();
    const c = importedDoubling.held();
    if (a.bytes + c.bytes > peakCompacted.bytes) peakCompacted = { count: a.count + c.count, bytes: a.bytes + c.bytes, at: read.events };
  }
  const built = rebuild(log.read(FOLD_TYPES), context);
  const fields = Object.fromEntries(Object.entries(built).map(([key, value]) => [key, bytesOf(value)]).filter(([, b]) => (b as number) > 2));
  const same = bytesOf(built) === bytesOf(state) && JSON.stringify(built) === JSON.stringify(state);
  const m = built.merge;
  console.log(
    JSON.stringify({
      size,
      horizonHours: Number(hoursText),
      quietHours: (quiet ?? Math.min(6 * HOUR, horizon)) / HOUR,
      lifeHours: life / HOUR,
      days: Number(((seeded.end - seeded.start) / 86_400_000).toFixed(2)),
      file: seeded.bytes,
      events: seeded.events,
      retirements,
      read: { events: read.events, bytes: read.bytes, top: Object.fromEntries(Object.entries(read.byType).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6)) },
      versions: { count: versions, bytes: versionBytes },
      peakHeld: peak,
      peakCompacted,
      state: { bytes: bytesOf(built), reports: m.reports.length, deliveries: m.deliveries.length, ends: m.ends.length, tombstones: m.retired.length, fields },
      foldEqualsRebuild: same,
    }),
  );
  log.close();
  }
}
