/**
 * This module keeps the measured ages of the canary checks of each source (AL-207). The live limit of an age check reads them.
 * The ages are not events of the log, thus the fold state and the snapshot key do not change. A small file in the private
 * folder keeps them across starts. A write goes at most once in each `CANARY_AGES_SAVE_EVERY`, and at the close.
 */
import { readFileSync } from "node:fs";
import { CANARY_AGE_WINDOW, type Duration, type Instant, type SourceId } from "@mark1russell7/alerts";
import { writeFileAtomicSync } from "@procedures/fs/files";
import { z } from "zod";

/** The name of the file of the ages in the private folder. */
export const CANARY_AGES_FILE = "canary-ages.json";

/** The format of the file of the ages. */
export const CANARY_AGES_FORMAT = "alerts-canary-ages/1";

/** The shortest time between two writes of the file. A crash loses the ages of this time at most. */
export const CANARY_AGES_SAVE_EVERY: Duration = 10 * 60_000;

/** The measured ages of the canary checks of each source. */
export interface CanaryAges {
  /** This function gives the ages of one source, the oldest first. */
  readonly ages: (source: SourceId) => readonly Duration[];
  /** This function adds the age of one check. Past the window, the oldest age goes out. */
  readonly note: (source: SourceId, age: Duration, at: Instant) => void;
  /** This function writes the file when it has new ages. */
  readonly close: () => void;
}

/** The options of `openCanaryAges`. */
export interface CanaryAgesOptions {
  /** The most ages of one source. The default is `CANARY_AGE_WINDOW`. */
  readonly window?: number;
  /** The shortest time between two writes. The default is `CANARY_AGES_SAVE_EVERY`. */
  readonly saveEvery?: Duration;
  /** The store gives each problem of the file to this function. Then the store starts empty, or it keeps the ages in memory. */
  readonly onBad?: (problem: string) => void;
}

const fileSchema = z.object({ format: z.literal(CANARY_AGES_FORMAT), ages: z.record(z.string(), z.array(z.number().nonnegative())) });

/**
 * This function opens the ages of the file at `path`. A file that is not there gives no ages. A broken file gives no ages,
 * and the next write replaces it. Without a path, the store keeps the ages in memory only.
 */
export function openCanaryAges(path: string | undefined, options: CanaryAgesOptions = {}): CanaryAges {
  const window = options.window ?? CANARY_AGE_WINDOW;
  const saveEvery = options.saveEvery ?? CANARY_AGES_SAVE_EVERY;
  const ages = new Map<string, Duration[]>(Object.entries(path === undefined ? {} : readAges(path, options.onBad)).map(([source, list]) => [source, list.slice(-window)]));
  let dirty = false;
  let savedAt: Instant | undefined;
  const save = (): void => {
    if (path === undefined || !dirty) return;
    dirty = false;
    try {
      writeFileAtomicSync(path, `${JSON.stringify({ format: CANARY_AGES_FORMAT, ages: Object.fromEntries(ages) })}\n`, { mode: 0o600 });
    } catch (error) {
      options.onBad?.(`the file ${CANARY_AGES_FILE} cannot be written: ${(error as NodeJS.ErrnoException).code ?? "an error"}`);
    }
  };
  return {
    ages: (source) => ages.get(source) ?? [],
    note: (source, age, at) => {
      if (!Number.isFinite(age) || age < 0) return;
      const list = ages.get(source) ?? [];
      list.push(age);
      if (list.length > window) list.splice(0, list.length - window);
      ages.set(source, list);
      dirty = true;
      // The first note of a start sets the time, thus a start writes no file before `saveEvery`.
      savedAt ??= at;
      if (at - savedAt < saveEvery) return;
      savedAt = at;
      save();
    },
    close: save,
  };
}

// The ages of the file, by source. A file that is not there or is broken gives no ages.
function readAges(path: string, onBad: CanaryAgesOptions["onBad"]): Readonly<Record<string, readonly Duration[]>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") onBad?.(`the file ${CANARY_AGES_FILE} cannot be read: ${(error as NodeJS.ErrnoException).code ?? "an error"}`);
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    onBad?.(`the file ${CANARY_AGES_FILE} is not JSON`);
    return {};
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    onBad?.(`the file ${CANARY_AGES_FILE} is not a file of ages`);
    return {};
  }
  return parsed.data.ages;
}
