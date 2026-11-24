/**
 * AL-124: the run of the runtime in the lab of the capacity models. The script opens the home folder of the script
 * `seed-home.ts` with `openMeasuredRuntime`: the configuration and the log of the seed, fake keys and no network. Thus no
 * fetch and no send leaves the process. The wall clock starts at the time of the seeded state, as in `start-blocks.ts`.
 *
 * The two last arguments are the base URLs of the fakes of the feeds and of the channels (AL-131). With them, each fetch
 * and each send goes to a fake on `127.0.0.1`. The lab starts the fakes, and the fake of the feeds gives the load of the classes `event` and `update`.
 * The start reads and writes the snapshot of the start, as a live start does.
 *
 * After the first pass, the script writes one JSON line with the event `lab-ready`. The ready signal of `capacity-app.json`
 * waits for this line. Then the script does each pass at the wake time of the pass before it, until the lab stops the
 * process. Each pass gives one JSON line with its wall time. The lines of the start go to the standard error.
 *
 * The loop of a live runtime is a worker of `@mark1russell7/service`, with the server of its probes. The lab run has no
 * server, thus it waits for each wake time with `delay`. The wait of a pass with no wake time is the longest retry of the
 * loop. A pass that fails stops the process with the code 1: the lab records a failed run.
 *
 * The levels of the seed record set the size of the start (AL-126). The count of the feeds near the place is the limit of the
 * transit feeds of the start. Thus each feed is one polled source, also past the limit of a live copy. The ready line gives
 * the feeds, the persons and the open incidents of the start, and the routes of its first pass.
 *
 * The runtime gets a meter of the OpenTelemetry SDK (AL-132). After the ready line and after each pass line, the script
 * collects the meter with the reader of `@mark1russell7/otel-ts/pull` (AL-135). Then it writes one line `lab-readings` with the readings of the series of `capacity-app.json` at the wall time.
 *
 * The start times each write of the snapshot (the option `timeSnapshot`, AL-115). At the end of each write, the script writes one
 * line `lab-snapshot-write` with the times of the write (CAP-65). The field `at` is the time of the start of the write on the wall clock.
 *
 * Usage: node scripts/lab-runtime.ts <home folder> [<feeds URL> <channels URL>].
 */
import { performance } from "node:perf_hooks";
import { openMeasuredRuntime, type SnapshotWriteTime } from "@mark1russell7/alerts-runtime";
import { delay, wallClock } from "@mark1russell7/algebra/clock";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { collectReadings, PullMetricReader } from "@mark1russell7/otel-ts/pull";
import { LAB_PASS, LAB_READINGS, LAB_READY, LAB_SNAPSHOT_WRITE, readSeedRecord } from "../src/seed-home.ts";

const [home, feeds, channels] = process.argv.slice(2);
if (home === undefined) throw new Error("Give the home folder of the seed.");
if ((feeds === undefined) !== (channels === undefined)) throw new Error("Give the URLs of the two fakes, or no URL.");
const record = readSeedRecord(home);
const wall = wallClock({ start: record.end });
const line = (fields: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
};

const report = (text: string): void => {
  process.stderr.write(`${text}\n`);
};
const services = feeds === undefined || channels === undefined ? {} : { services: { feeds, channels } };
const reader = new PullMetricReader();
const meter = new MeterProvider({ readers: [reader] }).getMeter("alerts-runtime");
const onSnapshotWrite = (write: SnapshotWriteTime): void => {
  const at = wall.now() - (performance.now() - write.at);
  line({ ev: LAB_SNAPSHOT_WRITE, at: new Date(at).toISOString(), longestMs: write.longestMs, writeMs: write.writeMs, rowsMs: write.rowsMs, wallMs: write.wallMs, cpuMs: write.cpuMs });
};
const measured = await openMeasuredRuntime(home, { wall, startSnapshot: true, timeSnapshot: true, onSnapshotWrite, transitLimit: record.levels.feeds, report, meter, ...services });
const readings = async (): Promise<void> => {
  const at = wall.now();
  // One series for each metric: the sum over its attributes. Thus each series is one metric id of capacity-app.json.
  const collection = await collectReadings(reader, at, { attributes: "sum" });
  line({ ev: LAB_READINGS, at: new Date(at).toISOString(), readings: collection.readings, ...(collection.errors === 0 ? {} : { errors: collection.errors }) });
};
line({
  ev: LAB_READY,
  opened: Math.round(measured.opened),
  at: measured.first.at,
  events: record.events,
  bytes: record.bytes,
  feeds: measured.instance.transit?.chosen.feeds.length ?? 0,
  persons: record.levels.persons,
  incidents: record.levels.incidents,
  routes: measured.first.delivery?.routes.length ?? 0,
});
await readings();
const retry = measured.instance.loop.times.retryCap;
let wakeAt = measured.first.wakeAt;
for (;;) {
  await delay(wall, wakeAt === undefined ? retry : Math.max(0, wakeAt - wall.now()));
  const started = performance.now();
  const pass = await measured.pass();
  line({ ev: LAB_PASS, at: pass.at, ms: Math.round(performance.now() - started), fetched: pass.fetched.length });
  await readings();
  wakeAt = pass.wakeAt;
}
