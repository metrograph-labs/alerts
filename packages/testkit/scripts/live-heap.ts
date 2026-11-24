/**
 * This script measures the heap of a runtime with a count of live alerts (AL-145). It seeds a small home with a count of
 * persons. The fake feeds give the live alerts of the last 10 minutes, each with a body of 2,000 bytes. The script opens
 * the home with `openMeasuredRuntime` and reads the heap after the first pass and after the collection of the garbage.
 *
 * Usage: node --expose-gc scripts/live-heap.ts <alerts> <persons> [<snapshot file> | --profile] [--block-watch]. With a
 * snapshot file, the script also writes a heap snapshot to that file. With `--profile`, the open runs under the CPU profiler,
 * and the line also has the summary of the profile (AL-150). The workflow `measure-start.yml` starts this mode in CI. With
 * `--block-watch`, the watch of long blocks of the runtime and its worker thread run during the open (AL-119). With `--feeds=<n>`,
 * the home has `n` transit feeds near its place, and the start reads each one from the fake of the feeds (AL-136). The line has
 * the resident memory `rss` and its peak `peakRss`. The script `block-watch-memory.ts` compares the two modes.
 *
 * The flags `--gdelt`, `--score=<n>` and `--chain` add the parts of a live configuration (AL-160). With `--gdelt`, the place
 * shares its position with GDELT, and the fake gives event files of the real size. With `--score=<n>`, `n` persons have a
 * score rule. With `--chain`, the configuration has the stack of an alert chain. With `--passes=<n>`, the script does `n`
 * passes after the first pass, and the line gives the time of each one in `passMs`.
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
const valueOf = (name: string): string | undefined => flags.find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3);
const transit = Number(valueOf("feeds") ?? "0");
const gdelt = flags.includes("--gdelt") ? 1 : 0;
const score = Number(valueOf("score") ?? "0");
const chain = flags.includes("--chain") ? 1 : 0;
const passes = Number(valueOf("passes") ?? "0");
// The kept lines of GDELT at the place in each file: each one gives a report, as on a busy day at a place.
const GDELT_NEAR = 2;
// The functions of a start and of its delivery step, for their inclusive time (AL-150).
const STEP_FUNCTIONS = ["readEventFile", "readZipEntries", "eventOf", "keepEvent", "chainStates", "goalStates", "policyWithPriors", "rebuild", "systemView", "systemReports", "route", "assess", "matchPlaces", "matchSubjects", "tableLevel", "escalate", "planDigests", "limitRoutes", "throttleRoutes"];
const alerts = Number(alertsText ?? "0");
const persons = Number(personsText ?? "1");
if (!(Number.isInteger(alerts) && alerts >= 0 && Number.isInteger(persons) && persons >= 1)) throw new RangeError("Give a count of alerts of 0 or more and a count of persons of 1 or more.");
for (const [name, amount] of Object.entries({ feeds: transit, score, passes })) {
  if (!(Number.isInteger(amount) && amount >= 0)) throw new RangeError(`Give a count of ${name} of 0 or more.`);
}
if (score > persons) throw new RangeError("Give a count of score rules of at most the count of persons.");
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Start node with --expose-gc.");
const dir = await mkdtemp(join(tmpdir(), "live-heap-"));
const home = join(dir, "home");
await seedHome(home, { log: 300_000, seed: "al-145", files: { shapes: 200_000, transit: 100_000 }, levels: { feeds: transit, persons, incidents: 0, gdelt, score, chain } });
const { end } = readSeedRecord(home);
const at = end + MINUTE;
let feeds: ReturnType<typeof createFakeFeeds> | undefined = createFakeFeeds({
  streams: alerts === 0 ? [] : [{ kind: "event", perSecond: (alerts * 1000) / SPAN, eventBytes: 2000 }],
  start: at - SPAN,
  seed: "al-145",
  ...(gdelt > 0 ? { gdelt: { near: GDELT_NEAR } } : {}),
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
  transitLimit: transit,
  services: { feeds: servers[0]!.url, channels: servers[1]!.url },
});
const ms = performance.now() - t0;
// The passes after the start, as the loop of a live runtime does them. Each one rebuilds the view and routes again.
const passMs: number[] = [];
for (let index = 0; index < passes; index += 1) {
  const begin = performance.now();
  await measured.pass();
  passMs.push(Math.round(performance.now() - begin));
}
let profile: ProfileSummary | undefined;
if (session !== undefined) {
  const stopped = (await session.post("Profiler.stop")) as { profile: Profile };
  session.disconnect();
  profile = profileSummary(stopped.profile, { steps: STEP_FUNCTIONS });
}
const live = feeds.counts().live;
const gdeltFiles = feeds.gdeltFiles();
for (const server of servers) await server.close();
feeds = undefined;
const incidents = measured.first.view.incidents.filter((incident) => incident.live).length;
const routes = measured.first.delivery?.routes.length ?? 0;
// The routes with a send in their plan: the incidents that reach a person at this pass.
const sending = measured.first.delivery?.routes.filter((item) => item.plan.sends.length > 0).length ?? 0;
// The holds of the send limit and the suppressions of the throttle in the state after the first pass (AL-154). Each one is
// an event of the log, thus they give the size of the write of the first pass.
const { holds: heldList, suppressions: suppressedList } = measured.instance.runtime.state();
const holds = heldList.length;
const suppressions = suppressedList.length;
// A live instance keeps only the time of its first pass. The measure drops its own copy of the pass too.
Reflect.deleteProperty(measured, "first");
for (let index = 0; index < 4; index += 1) gc();
await new Promise((resolve) => setTimeout(resolve, 50));
gc();
const { heapUsed: heap, external, rss } = process.memoryUsage();
if (snap !== undefined) writeHeapSnapshot(snap);
process.stdout.write(`${JSON.stringify({ alerts, persons, feeds: transit, gdelt, score, chain, gdeltFiles, passMs, live, incidents, routes, holds, suppressions, heap, external, rss, peakRss: peakRss(), blockWatch: watching, ms: Math.round(ms), ...(profile === undefined ? {} : { sending, profile }) })}\n`);
await measured.close();
await watch?.stop();
await rm(dir, { recursive: true, force: true });
