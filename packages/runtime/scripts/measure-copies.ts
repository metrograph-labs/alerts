/**
 * This script measures the copies of each expectation of the runtime over the log of a runtime (AL-8). A new candidate
 * goes into the list of the script first. Thus the result shows the rate of its copies before the runtime uses it.
 *
 * The script opens the log to read only, and replays it with the fold of the runtime. It reads only the types of
 * `FOLD_TYPES`, as a start does. The fold changes nothing for an observation. It prints only counts, delays and event
 * codes: no key, no area and no text of a message.
 *
 * Usage: `node scripts/measure-copies.ts --store=<path of runtime.sqlite> [--censor=<minutes>]`
 */

import { DEFAULT_LINK_POLICY, linkRule } from "@mark1russell7/alerts";
import { nwsEvent } from "@mark1russell7/alerts-format-nws";
import { COPY_SUFFIX, SOURCE_ID as IPAWS } from "@mark1russell7/alerts-source-ipaws";
import { openDatabase } from "@mark1russell7/sqlite";
import { copySummaries, type CopyCandidate } from "../src/copy-store.ts";
import { FOLD_TYPES, parseEvent, type RuntimeEvent } from "../src/events.ts";
import { INSTANCE_EXPECTATIONS, INSTANCE_SOURCES } from "../src/instance.ts";
import { rebuild } from "../src/state.ts";

const option = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const store = option("store");
if (store === undefined) {
  console.error("Give the log of a runtime: --store=<path of runtime.sqlite>");
  process.exit(2);
}
const censorMinutes = Number(option("censor") ?? "10");
if (!Number.isFinite(censorMinutes) || censorMinutes < 0) {
  console.error("The value of --censor is a count of minutes, 0 or more.");
  process.exit(2);
}

// The candidates: the expectations of the runtime. An IPAWS copy has its own key.
const CANDIDATES: readonly CopyCandidate[] = INSTANCE_EXPECTATIONS.map((expectation) =>
  expectation.to === IPAWS ? { expectation, copyKey: (key: string) => `${key}${COPY_SUFFIX}` } : { expectation },
);

// The rows go from SQLite into the fold one at a time, thus the script keeps no copy of the log (AL-103). The read has
// the filter of `RuntimeLog.read(FOLD_TYPES)`, on a connection that only reads. Thus its memory is the memory of the
// state, as at a start of the runtime.
let count = 0;
function* eventsOf(rows: Iterable<{ readonly body: string }>): Generator<RuntimeEvent> {
  for (const row of rows) {
    count += 1;
    yield parseEvent(JSON.parse(row.body));
  }
}
const db = openDatabase(store, { readOnly: true });
let state: ReturnType<typeof rebuild>;
let skipped: number;
try {
  const types = JSON.stringify(FOLD_TYPES);
  const rows = db.prepare("SELECT body FROM events WHERE type IN (SELECT value FROM json_each(?)) ORDER BY seq").iterate(types) as unknown as Iterable<{ readonly body: string }>;
  // The context has no retention. Thus the replay keeps each report of the log, except the reports of an old retired event.
  state = rebuild(eventsOf(rows), { sources: INSTANCE_SOURCES });
  skipped = (db.prepare("SELECT count(*) AS n FROM events WHERE type NOT IN (SELECT value FROM json_each(?))").get(types) as { n: number }).n;
} finally {
  db.close();
}
const summaries = copySummaries(state.merge.reports, state.time, CANDIDATES, {
  censor: censorMinutes * 60_000,
  eventOf: nwsEvent,
  link: linkRule(DEFAULT_LINK_POLICY),
});

const iso = (at: number | undefined): string => (at === undefined ? "none" : new Date(at).toISOString());
const seconds = (ms: number): string => (ms / 1000).toFixed(1);
console.log(`log: ${String(count)} events of the fold, ${String(skipped)} other events, end ${iso(state.time)}`);
for (const summary of summaries) {
  console.log(`\n${summary.id} (${summary.from} -> ${summary.to}), since ${iso(summary.since)}`);
  console.log(`  counts: ${JSON.stringify(summary.counts)}`);
  const delays = summary.delays;
  if (delays !== undefined) {
    console.log(`  delays (s): n ${String(delays.count)}, min ${seconds(delays.min)}, median ${seconds(delays.median)}, p90 ${seconds(delays.p90)}, max ${seconds(delays.max)}`);
  }
  for (const [kind, events] of Object.entries(summary.events)) console.log(`  ${kind}: ${JSON.stringify(events)}`);
}
