/**
 * AL-124: the seed of the lab of the capacity models. The script writes a home folder for the script `lab-runtime.ts`
 * with `seedHome`. The folder has a log at a byte size, the cache files of one live copy and a made-up configuration.
 * The file `capacity-app.json` at the root of the repository gives the folder and the size.
 *
 * Usage: node scripts/seed-home.ts <home folder> <log size in bytes>. It writes one JSON line with the seed record.
 */
import { readSeedRecord, seedHome } from "../src/seed-home.ts";

const [home, logText] = process.argv.slice(2);
if (home === undefined || logText === undefined) throw new Error("Give the home folder and the size of the log in bytes.");
const log = Number(logText);
if (!Number.isFinite(log) || log <= 0) throw new RangeError(`The size of the log is "${logText}", not a number of bytes above 0.`);
await seedHome(home, { log, seed: "al124" });
process.stdout.write(`${JSON.stringify({ ev: "seeded", ...readSeedRecord(home) })}\n`);
