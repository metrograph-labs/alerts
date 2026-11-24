import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/live-heap.ts", import.meta.url));
const ALERTS = 1000;
const PERSONS = 10;

/**
 * The limit of the heap of one live alert, in bytes (AL-145). The measure gives the heap after the first pass with 1,000
 * live alerts and 10 persons, less the heap with no alert, divided by the live alerts. Five runs on Node 24 gave 11,140 to
 * 11,266 bytes. The limit is the worst run plus the spread of the runs: 11,266 + 126, up to 11,400. The CI runs of the
 * first pull request gave 11,127 and 11,182 bytes on Node 24, and 10,689 bytes on Node 26. Before AL-145, the
 * same measure gave approximately 26,900 bytes.
 */
const BYTES_PER_ALERT_LIMIT = 11_400;

/** One line of the script `live-heap.ts`. */
interface HeapLine {
  readonly alerts: number;
  readonly persons: number;
  readonly live: number;
  readonly incidents: number;
  readonly routes: number;
  readonly heap: number;
  readonly external: number;
  readonly ms: number;
}

// Each measure has its own process, thus the heap of one measure has no part of another.
async function measure(alerts: number): Promise<HeapLine> {
  const { stdout } = await run(process.execPath, ["--expose-gc", SCRIPT, String(alerts), String(PERSONS)], { timeout: 150_000, maxBuffer: 1 << 20 });
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("The script live-heap.ts gave no line.");
  return JSON.parse(line) as HeapLine;
}

describe("the heap of the live alerts (AL-145)", () => {
  it("holds the heap of each live alert below the limit, with 10 persons", { timeout: 240_000 }, async ({ annotate }) => {
    // The two measures go one after the other, thus the test holds less memory at one time.
    const empty = await measure(0);
    const full = await measure(ALERTS);
    // A measure with fewer live alerts than half of the count tells nothing: the feeds or the fetch failed.
    expect(full.live).toBeGreaterThan(ALERTS / 2);
    const perAlert = (full.heap - empty.heap) / full.live;
    // The report of the test run keeps each value, for the next calculation of the limit.
    await annotate(JSON.stringify({ node: process.version, perAlert: Math.round(perAlert), empty, full }));
    expect(perAlert).toBeLessThan(BYTES_PER_ALERT_LIMIT);
  });
});
