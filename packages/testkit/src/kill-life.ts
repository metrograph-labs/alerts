/**
 * One life of the runtime in case 10 (`kill-restart.ts`), in a child process. The parent starts this script with one
 * argument: the JSON of a `LifeInput`. The script opens the runtime on the log file of the arm, and does passes to the
 * end of the arm. At the stop point of the input, the process sends `SIGKILL` to itself. Thus the log, the channel and
 * the scripted API keep only what a real hard stop keeps.
 *
 * The script writes each note as one JSON line to the notes file of the life, with a synchronous write. Thus the
 * last note before a stop stays in the file.
 */
import { appendFileSync } from "node:fs";
import { wallClock } from "@mark1russell7/algebra/clock";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { openRuntime, openRuntimeLog, type RuntimeLog } from "@mark1russell7/alerts-runtime";
import { errorMessage } from "@mark1russell7/text";
import { pushoverFetchTo } from "@procedures/notify/testing";
import { deliveryFixture, FIXTURE_PLACE } from "./delivery-fixture.ts";
import type { KillPoint, LifeInput, LifeNote } from "./kill-restart.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as LifeInput;
const note = (entry: LifeNote): void => appendFileSync(input.notes, `${JSON.stringify(entry)}\n`);

/** This function ends the process at once, as a `SIGKILL` from outside does. No later code of the process goes. */
function die(point: KillPoint): never {
  note({ kind: "kill", point, at: Date.now() });
  process.kill(process.pid, "SIGKILL");
  // The signal ends the process. This wait holds the thread until it does.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("The process did not stop after SIGKILL.");
}

/**
 * This function gives a log that ends the process at the stop point of the life. The delivery step writes the `attempt`
 * row of a copy before its send, and the delivery of the copy after the accept.
 */
function killingLog(log: RuntimeLog, point: KillPoint | "none"): RuntimeLog {
  return {
    read: (types, after) => log.read(types, after),
    has: (id) => log.has(id),
    get: (id) => log.get(id),
    entries: (options) => log.entries(options),
    count: () => log.count(),
    counts: () => log.counts(),
    head: () => log.head(),
    endStart: () => log.endStart(),
    close: () => log.close(),
    appendAll(events, accept) {
      const types = new Set(events.map((event) => event.type));
      if (point === "accepted-unlogged" && types.has("delivery")) die(point);
      const conflicts = log.appendAll(events, accept);
      if (point === "attempt-unsent" && types.has("attempt")) die(point);
      if (point === "logged-unacked" && types.has("delivery")) die(point);
      return conflicts;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = deliveryFixture(input.source, input.word);
const { settings } = input;
const channel = createPushoverChannel({ token: fixture.token, fetch: pushoverFetchTo(input.base), timeoutMs: settings.channelLimitMs });
const clock = wallClock({ unref: true });
const log = killingLog(openRuntimeLog(input.log), input.point);
let passes = 0;
let duplicates = 0;
try {
  const runtime = openRuntime({
    log,
    clock,
    // Each life gets the same warning time. Thus the two lives read the same report.
    sources: [fixture.sourceOf(input.sent)],
    watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
    view: fixture.view,
    run: input.run,
    delivery: {
      recipients: [fixture.recipient],
      channels: [channel],
      pollEvery: settings.pollEveryMs,
      retry: settings.retryMs,
      callLimit: settings.callLimitMs,
      flightLimit: settings.flightLimitMs,
    },
  });
  note({ kind: "start", run: input.run, at: clock.now() });
  while (clock.now() < input.end) {
    const pass = await runtime.pass();
    passes += 1;
    const failures = pass.delivery?.failures ?? [];
    for (const failure of failures) note({ kind: "failure", call: failure.call, failure: failure.kind, message: failure.message, at: clock.now() });
    duplicates += pass.delivery?.duplicates.length ?? 0;
    // The send failed, and the delivery waits for its retry. The kill falls in that wait.
    if (input.point === "backoff" && failures.some((failure) => failure.call === "send")) die("backoff");
    const next = Math.min(pass.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + settings.tickMs, input.end);
    await sleep(Math.max(0, next - clock.now()));
  }
  note({ kind: "end", passes, duplicates, at: clock.now() });
  log.close();
  process.exit(0);
} catch (thrown) {
  note({ kind: "error", message: errorMessage(thrown), passes, at: clock.now() });
  process.exit(1);
}
