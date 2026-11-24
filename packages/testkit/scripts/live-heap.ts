/**
 * This script measures the heap of a runtime with a count of live alerts (AL-145). It seeds a small home with a count of
 * persons. The fake feeds give the live alerts of the last 10 minutes, each with a body of 2,000 bytes. The script opens
 * the home with `openMeasuredRuntime` and reads the heap after the first pass and after the collection of the garbage.
 *
 * Usage: node --expose-gc scripts/live-heap.ts <alerts> <persons> [<snapshot file> | --profile] [--block-watch]. With a
 * snapshot file, the script also writes a heap snapshot to that file. With `--profile`, the open runs under the CPU profiler,
 * and the line also has the summary of the profile (AL-150). The workflow `measure-start.yml` starts this mode in CI. With
 * `--block-watch`, the watch of long blocks of the runtime and its worker thread run during the open (AL-119). The line has
 * the resident memory `rss` and its peak `peakRss`. The script `block-watch-memory.ts` compares the two modes.
 *
 * The script gives one JSON line: the count of the alerts and the persons, the live alerts of the feeds, the live
 * incidents and the routes of the first pass, the heap, the external memory, the resident memory and the time of the open. The test
 * `live-heap.test.ts` gives the bytes of each live alert from two lines: one with no alert, and one with alerts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { writeHeapSnapshot } from "node:v8";
import { openMeasuredRuntime, startBlockWatch } from "@mark1russell7/alerts-runtime";
import { wallClock } from "@mark1russell7/algebra/clock";
import { peakRss } from "@mark1russell7/rigor-bench/fresh";
import { profileSummary, type Profile, type ProfileSummary } from "../src/cpu-profile.ts";
import { createFakeChannels } from "../src/fake-channels.ts";
import { createFakeFeeds } from "../src/fake-feeds.ts";
import { startFake } from "../src/fake-server.ts";
import { readSeedRecord, seedHome } from "../src/seed-home.ts";

const MINUTE = 60_000;
const SPAN = 10 * MINUTE;
const [alertsText, personsText, ...flags] = process.argv.slice(2);
const profiling = flags.includes("--profile");
const watching = flags.includes("--block-watch");
const snap = profiling ? undefined : flags.find((flag) => !flag.startsWith("--"));
// The functions of a start and of its delivery step, for their inclusive time (AL-150).
const STEP_FUNCTIONS = ["rebuild", "systemView", "systemReports", "route", "assess", "matchPlaces", "matchSubjects", "tableLevel", "escalate", "planDigests", "limitRoutes", "throttleRoutes"];
const alerts = Number(alertsText ?? "0");
const persons = Number(personsText ?? "1");
if (!(Number.isInteger(alerts) && alerts >= 0 && Number.isInteger(persons) && persons >= 1)) throw new RangeError("Give a count of alerts of 0 or more and a count of persons of 1 or more.");
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Start node with --expose-gc.");
const dir = await mkdtemp(join(tmpdir(), "live-heap-"));
const home = join(dir, "home");
await seedHome(home, { log: 300_000, seed: "al-145", files: { shapes: 200_000, transit: 100_000 }, levels: { feeds: 0, persons, incidents: 0 } });
const { end } = readSeedRecord(home);
const at = end + MINUTE;
let feeds: ReturnType<typeof createFakeFeeds> | undefined = createFakeFeeds({
  streams: alerts === 0 ? [] : [{ kind: "event", perSecond: (alerts * 1000) / SPAN, eventBytes: 2000 }],
  start: at - SPAN,
  seed: "al-145",
});
const servers = [await startFake(feeds.handler), await startFake(createFakeChannels().handler)];
const session = profiling ? new Session() : undefined;
if (session !== undefined) {
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 500 });
  await session.post("Profiler.start");
}
// The worker writes its lines to a file of the scratch folder, and the end of the script removes the folder.
const watch = watching ? startBlockWatch({ target: join(dir, "block-watch.log") }) : undefined;
await watch?.ready;
const t0 = performance.now();
const measured = await openMeasuredRuntime(home, {
  wall: wallClock({ start: at }),
  startSnapshot: true,
  transitLimit: 0,
  services: { feeds: servers[0]!.url, channels: servers[1]!.url },
});
const ms = performance.now() - t0;
let profile: ProfileSummary | undefined;
if (session !== undefined) {
  const stopped = (await session.post("Profiler.stop")) as { profile: Profile };
  session.disconnect();
  profile = profileSummary(stopped.profile, { steps: STEP_FUNCTIONS });
}
const live = feeds.counts().live;
for (const server of servers) await server.close();
feeds = undefined;
const incidents = measured.first.view.incidents.filter((incident) => incident.live).length;
const routes = measured.first.delivery?.routes.length ?? 0;
// The routes with a send in their plan: the incidents that reach a person at this pass.
const sending = measured.first.delivery?.routes.filter((item) => item.plan.sends.length > 0).length ?? 0;
// A live instance keeps only the time of its first pass. The measure drops its own copy of the pass too.
Reflect.deleteProperty(measured, "first");
for (let index = 0; index < 4; index += 1) gc();
await new Promise((resolve) => setTimeout(resolve, 50));
gc();
const { heapUsed: heap, external, rss } = process.memoryUsage();
if (snap !== undefined) writeHeapSnapshot(snap);
process.stdout.write(`${JSON.stringify({ alerts, persons, live, incidents, routes, heap, external, rss, peakRss: peakRss(), blockWatch: watching, ms: Math.round(ms), ...(profile === undefined ? {} : { sending, profile }) })}\n`);
await measured.close();
await watch?.stop();
await rm(dir, { recursive: true, force: true });
