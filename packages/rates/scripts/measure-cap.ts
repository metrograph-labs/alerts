/**
 * The measure of the CAP fields of the NWS alerts, for the workflow `cap.yml` (AL-31 step 4b). The script reads the new
 * alerts of the whole country from the NWS API, one page at a time. It adds their counts to the file of the CAP fields.
 *
 * The NWS API is a documented API. Its `robots.txt` refuses the crawlers of pages, so the script does not read it. The
 * script sends a `User-Agent` that names no person and no project, as the API asks, and one request at a time.
 *
 * The script adds to the file with the later last run. That file is the committed file or the file of the last run
 * of the workflow. A page that fails three times stops the script with no file, so the next run reads the same days again.
 * A run with no new whole day writes the base file with no change.
 *
 * With the committed base rates and priors, the script also writes the replay of the table and the score over the file
 * (`replay.json` and `replay.md`).
 *
 * Start: `node scripts/measure-cap.ts --out=<folder> [--committed=data/cap.json] [--last=<cap.json of the last run>]
 * [--rates=data/rates.json --priors=../core/src/data/priors.json]`
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ASSESS_POLICY, scorePriorsSchema, type SourceId } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import {
  CAP_MAX_PAGES,
  CAP_ORIGIN,
  capFile,
  capGaps,
  capQuery,
  capSummary,
  CapTally,
  capWindow,
  nextPath,
  readCapFile,
  readCapPage,
  replayOf,
  replaySummary,
  type CapFile,
  type CapPage,
  type UnderSection,
} from "../src/index.ts";

/** The User-Agent of each request. It names no person and no project. */
const USER_AGENT = "alerts-measure";
/** The shortest time between two requests. */
const MIN_INTERVAL_MS = 5000;
/** The time limit of one request. */
const TIMEOUT_MS = 60_000;
/** The count of tries of one page before the script stops. */
const TRIES = 3;

const option = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out");
if (out === undefined) throw new Error("Give the folder of the results: --out=<folder>.");
const log = (text: string): void => console.log(`${new Date(realClock.now()).toISOString()} ${text}`);
/** This function escapes the text of a workflow command, as the runner of GitHub reads it. */
const command = (text: string): string => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** This function reads a file of the CAP fields. A path with no file gives `undefined`. */
async function fileAt(path: string | undefined): Promise<CapFile | undefined> {
  if (path === undefined) return undefined;
  try {
    return readCapFile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** This function adds a text to the summary of the step of the workflow, when the runner gives its file. */
async function addToSummary(text: string): Promise<void> {
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined && stepSummary !== "") await appendFile(stepSummary, text);
  console.log(text);
}

/**
 * This function writes the replay of the table and the score over a file of the CAP fields. It uses the base rates and
 * the priors of the options. It gives the summary of the replay. With no options, or with base rates that have no section
 * `under`, it writes no replay.
 */
async function writeReplay(file: CapFile, folder: string): Promise<string | undefined> {
  const ratesPath = option("rates");
  const priorsPath = option("priors");
  if (ratesPath === undefined || priorsPath === undefined) return undefined;
  const rates = JSON.parse(await readFile(ratesPath, "utf8")) as { readonly under?: UnderSection };
  if (rates.under === undefined) {
    log(`the base rates ${ratesPath} have no section under: the script writes no replay`);
    return undefined;
  }
  const priors = scorePriorsSchema.parse(JSON.parse(await readFile(priorsPath, "utf8")));
  const replay = replayOf({ under: rates.under, months: file.months, priors, policy: DEFAULT_ASSESS_POLICY });
  const summary = replaySummary(replay);
  await writeFile(join(folder, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
  await writeFile(join(folder, "replay.md"), summary);
  return summary;
}

const lastEnd = (file: CapFile | undefined): number => (file?.runs.length ? Date.parse(file.runs.at(-1)?.end ?? "") : Number.NEGATIVE_INFINITY);
const committed = await fileAt(option("committed"));
const last = await fileAt(option("last"));
// The file of the last run extends the committed file, until a person commits it. The later file is the base.
const base = lastEnd(last) > lastEnd(committed) ? last : committed;
const other = base === last ? committed : last;
const windows = new Set(base?.runs.map((run) => `${run.start} ${run.end}`));
const missing = other?.runs.filter((run) => !windows.has(`${run.start} ${run.end}`)) ?? [];
// A run of the other file that the base does not have is a fork of the files: a person examines it.
if (missing.length > 0) console.log(`::warning title=Fork of the CAP files::${command(`The base file does not have the runs ${missing.map((run) => `${run.start} to ${run.end}`).join(", ")}.`)}`);

const window = capWindow(realClock.now(), base);
if (window === undefined) {
  // The next run adds to the file of this run, so this run gives the base file again with no change.
  log("no whole day is new since the last run: the script writes the base file with no change");
  await mkdir(out, { recursive: true });
  if (base !== undefined) {
    await writeFile(join(out, "cap.json"), `${JSON.stringify(base, null, 2)}\n`);
    const replay = await writeReplay(base, out);
    if (replay !== undefined) await addToSummary(replay);
  }
} else {
  const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
  const api = createRequester({
    source: "nws-api-cap" as SourceId,
    pace,
    transport: fetchTransport({ userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS }),
    baseUrl: CAP_ORIGIN,
    headers: { accept: "application/geo+json" },
    minIntervalMs: MIN_INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
  });
  const tally = new CapTally();
  let path: string | undefined = capQuery(window);
  let pages = 0;
  while (path !== undefined) {
    if (pages === CAP_MAX_PAGES) throw new Error(`The run has more than ${String(CAP_MAX_PAGES)} pages. The links of the pages can go in a circle.`);
    let page: CapPage | undefined;
    for (let attempt = 1; attempt <= TRIES && page === undefined; attempt += 1) {
      const result = await api.get({ path, what: `page ${String(pages + 1)} of the alerts` });
      if (!result.ok) {
        log(`page ${String(pages + 1)}: try ${String(attempt)} failed: ${result.failure.kind}: ${result.failure.message}`);
        continue;
      }
      try {
        page = readCapPage(result.answer.reply.body);
      } catch (error) {
        log(`page ${String(pages + 1)}: try ${String(attempt)}: the text is not a page of alerts: ${(error as Error).message}`);
      }
    }
    if (page === undefined) throw new Error(`Page ${String(pages + 1)} of the alerts failed ${String(TRIES)} times. The script writes no file.`);
    pages += 1;
    for (const alert of page.alerts) tally.add(alert);
    log(`page ${String(pages)}: ${String(page.alerts.length)} alerts`);
    // The API gives a link of the next page also on the last page. An empty page is the end.
    path = page.alerts.length === 0 || page.next === undefined ? undefined : nextPath(page.next);
  }
  const run = tally.run(window, pages);
  const file = capFile(base, run);
  const summary = capSummary(file, run);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "cap.json"), `${JSON.stringify(file, null, 2)}\n`);
  await writeFile(join(out, "cap-summary.md"), summary);
  await addToSummary(summary);
  const replay = await writeReplay(file, out);
  if (replay !== undefined) await addToSummary(replay);
  // A day with no alert is a gap of the API, not a quiet day. It is a warning on the check line of the run.
  const gaps = capGaps(run);
  if (gaps.length > 0) console.log(`::warning title=Days with no alert::${command(`The NWS API gave no alert for ${gaps.join(", ")}.`)}`);
}
