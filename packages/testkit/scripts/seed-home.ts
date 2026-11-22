/**
 * AL-124: the seed of the lab of the capacity models. The script writes a home folder for the script `lab-runtime.ts`
 * with `seedHome`. The folder has a log at a byte size, the cache files of one live copy and a made-up configuration.
 * The file `capacity-app.json` at the root of the repository gives the folder, the size and the levels (AL-126).
 *
 * Usage: node scripts/seed-home.ts <home folder> <log size in bytes> [<feeds> <persons> <incidents>]. The levels are the
 * level variables of `capacity-app.json`, and each absent level has its value in `DEFAULT_LEVELS`. The script writes one
 * JSON line with the seed record. Its field `amounts` gives the bytes of the log, as the seed protocol of `capacity-app/1` tells.
 */
import { DEFAULT_LEVELS, readSeedRecord, seededLine, seedHome, type SeedLevels } from "../src/seed-home.ts";

const [home, logText, ...levelTexts] = process.argv.slice(2);
if (home === undefined || logText === undefined) throw new Error("Give the home folder and the size of the log in bytes.");
const log = Number(logText);
if (!Number.isFinite(log) || log <= 0) throw new RangeError(`The size of the log is "${logText}", not a number of bytes above 0.`);
const names = ["feeds", "persons", "incidents"] as const;
if (levelTexts.length > names.length) throw new Error(`Give ${String(names.length)} levels at most: ${names.join(", ")}.`);
const levels: Record<keyof SeedLevels, number> = { ...DEFAULT_LEVELS };
levelTexts.forEach((text, index) => {
  const name = names[index]!;
  const amount = Number(text);
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`The level ${name} is "${text}", not a whole number, 0 or more.`);
  levels[name] = amount;
});
await seedHome(home, { log, seed: "al124", levels });
process.stdout.write(`${JSON.stringify(seededLine(readSeedRecord(home)))}\n`);
