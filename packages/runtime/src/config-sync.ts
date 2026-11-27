/**
 * This module holds the sync of the configuration between the copies (AL-17). A copy with the field `configFrom` of
 * `copy.json` takes `config.json` and the parts from that copy. The design is in the section "The sync of the
 * configuration" of `docs/CONTRACTS.md`.
 *
 * - The source copy serves the texts of its start, and only when its start used its private files.
 * - The source copy does not serve `secrets.env` or `copy.json`. Each copy keeps its own keys and settings.
 * - The mirror reads the texts only when its read of the source tells another hash of the configuration.
 * - The mirror checks the texts with its own `secrets.env` and `copy.json`, as a start does. Texts with problems change no file.
 * - The mirror writes each part, then `config.json`. Then the reload hook reads the files and starts the runtime again.
 * - A set that changes the snapshot key goes to the held folder, not to the private files (AL-179). A start of that set
 *   folds the whole log, and on a small host it is not ready in its window. `deploy.ts files --held` folds first, then starts.
 */
import { join } from "node:path";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { configHash, PART_NAME, type CopyPeer, type CopyRead, type CopySettings, type Duration, type Instant } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import * as z from "zod";
import { codeOf, PART_FILE_END, type PartsTexts } from "./config.ts";
import { EXCHANGE_LIMIT } from "./copy.ts";
import { limited } from "./limit.ts";
import { checkStart, type CheckedStart, type CheckOf, type PrivateFiles, type StartTexts, type StartUse } from "./reload.ts";

/** The format of the answer of the procedure `alerts.config.files`. */
export const CONFIG_FILES_FORMAT = "alerts-config-files/1";

/** The folder of a held set in the host folder (AL-179): `config.json` and the folder `parts`, as the source served them. */
export const SYNC_HELD_FOLDER = "sync-held";

/** The shortest time between two reads of the files of the source, after a read that did not change the files. */
export const SYNC_RETRY: Duration = 10 * 60_000;

/** The text of one part of the configuration, with the name of its file without `.json`. */
export interface SyncPart {
  readonly name: string;
  readonly text: string;
}

/** The texts that the sync copies: `config.json` and each part, in the order of the names. */
export interface SyncTexts {
  readonly config: string;
  readonly parts: readonly SyncPart[];
}

/**
 * The cause when a copy serves no texts.
 *
 * - `mirror`: the copy takes its configuration from another copy. A mirror takes texts only from a copy with its own files.
 * - `good`: the start of the copy used the last good set, or a text of the start has no whole text.
 */
export type WithheldCause = "mirror" | "good";

/** The answer of the procedure `alerts.config.files`. */
export interface ConfigFiles {
  readonly format: typeof CONFIG_FILES_FORMAT;
  /** The id of the copy that serves the answer. */
  readonly copy: string;
  /** The hash of the configuration that the copy operates, as in each page of the exchange. */
  readonly configHash: string;
  /** The texts of the start of the copy, or the cause when the copy serves no texts. */
  readonly files: SyncTexts | WithheldCause;
}

/** The parts of a start that the procedure serves. */
export interface ServedStart {
  /** The settings of the copy that serves. */
  readonly copy: CopySettings;
  /** The files of the start: the private files, or the last good set. */
  readonly use: StartUse;
  /** The texts of the private files at the start. */
  readonly texts: StartTexts;
  /** The hash of the configuration that the copy operates. */
  readonly configHash: string;
}

// The texts of the parts, or `undefined` when a part or the folder has no text.
function partsOf(parts: PartsTexts | undefined): SyncPart[] | undefined {
  if (parts === undefined) return [];
  if ("code" in parts) return undefined;
  const texts: SyncPart[] = [];
  for (const { name, file } of parts.files) {
    if ("code" in file) return undefined;
    texts.push({ name, text: file.text });
  }
  return texts;
}

/**
 * This function gives the answer of the procedure for the start of a copy. It holds no text of `secrets.env` and no
 * text of `copy.json`.
 *
 * - A copy with the field `configFrom` serves the cause `mirror`, and no texts.
 * - A start with the last good set serves the cause `good`, and no texts. The private files of that start have problems.
 */
export function configFilesOf(start: ServedStart): ConfigFiles {
  const answer = { format: CONFIG_FILES_FORMAT, copy: start.copy.id, configHash: start.configHash } as const;
  if (start.copy.configFrom !== undefined) return { ...answer, files: "mirror" };
  const parts = partsOf(start.texts.parts);
  if (start.use === "good" || "code" in start.texts.config || parts === undefined) return { ...answer, files: "good" };
  return { ...answer, files: { config: start.texts.config.text, parts } };
}

const partSchema = z.strictObject({ name: z.string().regex(PART_NAME), text: z.string() });
const configFilesSchema = z.strictObject({
  format: z.literal(CONFIG_FILES_FORMAT),
  copy: z.string().min(1),
  configHash: z.string().min(1),
  files: z.union([z.strictObject({ config: z.string(), parts: z.array(partSchema) }), z.enum(["mirror", "good"])]),
});

/** This function checks the answer of the procedure. A problem holds no text of the answer. */
export function parseConfigFiles(value: unknown): Result<ConfigFiles, readonly string[]> {
  const parsed = configFilesSchema.safeParse(value);
  if (!parsed.success) return err(["The answer is not a set of the files of the configuration."]);
  const files = parsed.data.files;
  if (typeof files !== "string" && new Set(files.parts.map((part) => part.name)).size !== files.parts.length) {
    return err(["The answer has two parts with one name."]);
  }
  return ok(parsed.data);
}

/** The writes of a sync: each part first, then `config.json`. */
export interface SyncPlan {
  /** The files to write, with their paths. The last write is `config.json`. */
  readonly write: readonly { readonly path: string; readonly text: string }[];
  /** The paths of the local parts that the source does not have. */
  readonly remove: readonly string[];
}

// This value tells if the local text is the text of the source.
const sameText = (local: { readonly text: string } | { readonly code: string } | undefined, text: string): boolean => local !== undefined && "text" in local && local.text === text;

/**
 * This function gives the writes that make the local files the same as the texts of the source. It gives `same` when
 * the local files have each text of the source and no other part. A folder of the parts that cannot be read gives a problem.
 */
export function syncPlan(files: PrivateFiles, local: StartTexts, served: SyncTexts): Result<SyncPlan | "same", readonly string[]> {
  const parts = local.parts ?? { files: [] };
  if ("code" in parts) return err([`The folder of the parts cannot be read (${parts.code}).`]);
  const localParts = new Map(parts.files.map((part) => [part.name, part.file]));
  const servedNames = new Set(served.parts.map((part) => part.name));
  const write = served.parts.filter((part) => !sameText(localParts.get(part.name), part.text)).map((part) => ({ path: join(files.parts, `${part.name}${PART_FILE_END}`), text: part.text }));
  const remove = parts.files.filter((part) => !servedNames.has(part.name)).map((part) => join(files.parts, `${part.name}${PART_FILE_END}`));
  if (!sameText(local.config, served.config)) write.push({ path: files.config, text: served.config });
  return ok(write.length === 0 && remove.length === 0 ? "same" : { write, remove });
}

// This value tells if a set changes the key. An error counts as a change, thus a fault of the key holds the set.
const changesKey = (keyChanged: (checked: CheckedStart) => boolean, checked: CheckedStart): boolean => {
  try {
    return keyChanged(checked);
  } catch {
    return true;
  }
};

/**
 * This function gives the texts of a held set from its files (AL-179). The parts are the files that end in `.json`, in the order
 * of the names. No `config.json` gives undefined: the folder holds no set.
 */
export function heldTexts(config: string | undefined, parts: readonly { readonly file: string; readonly text: string }[]): SyncTexts | undefined {
  if (config === undefined) return undefined;
  const named = parts.filter((part) => part.file.endsWith(PART_FILE_END)).map((part) => ({ name: part.file.slice(0, -PART_FILE_END.length), text: part.text }));
  return { config, parts: named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/**
 * This function tells if a sync is due. A sync is due when the last read of the source tells another hash of the
 * configuration, and `retry` passed after the last try. With no read of the source, no sync is due.
 */
export function syncDue(read: CopyRead | undefined, tried: Instant | undefined, now: Instant, retry: Duration): boolean {
  if (read === undefined || read.sameConfig) return false;
  return tried === undefined || now - tried >= retry;
}

/** The call of the procedure `alerts.config.files` of another copy. The sync gives the stop as the signal. */
export type ConfigFilesCall = (peer: CopyPeer, signal: AbortSignal) => Promise<unknown>;

/** The ports of the sync. A test gives fakes, thus it can make a read or a write fail. */
export interface SyncPorts {
  /** This function reads the texts of the private files of this copy. */
  readonly read: () => Promise<StartTexts>;
  /** This function makes a folder and the folders above it. A folder that exists is not an error. */
  readonly makeFolder: (path: string) => Promise<void>;
  /** This function writes a whole file, or it throws. The file needs the permissions of `secrets.env`. */
  readonly write: (path: string, text: string) => Promise<void>;
  /** This function removes a file. A missing file is not an error. Each other error throws. */
  readonly remove: (path: string) => Promise<void>;
  /** This function writes the whole set into the held folder, in place of an earlier held set (AL-179). */
  readonly hold?: (served: SyncTexts) => Promise<void>;
}

/** The options of `configSync`. */
export interface ConfigSyncOptions {
  /** The copy of the field `configFrom`. */
  readonly source: CopyPeer;
  readonly files: PrivateFiles;
  /** The check of the instance for the settings of a copy, as at the start. */
  readonly checkOf: CheckOf;
  /** This function gives the last read of the source that passed, from the worker of the exchange. */
  readonly read: () => CopyRead | undefined;
  readonly call: ConfigFilesCall;
  readonly clock: WallClock;
  readonly ports: SyncPorts;
  /** This function gets each report of the sync. Two reports in sequence do not have the same text. */
  readonly report: (message: string) => void;
  /** The shortest time between two tries. The default is `SYNC_RETRY`. */
  readonly retry?: Duration;
  /** The time limit of the read of the files. The default is `EXCHANGE_LIMIT`. */
  readonly limit?: Duration;
  /**
   * This function tells if the checked set changes the snapshot key of the live start (AL-179). With it and the port `hold`, such
   * a set goes to the held folder. An error of the function counts as a change.
   */
  readonly keyChanged?: (checked: CheckedStart) => boolean;
}

/** The outcome of one step of the sync. */
export type SyncOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "same" }
  | { readonly kind: "written"; readonly written: number; readonly removed: number }
  | { readonly kind: "held" }
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

/** The sync of the configuration from one copy. */
export interface ConfigSync {
  /**
   * This method reads the files of the source and writes them when a sync is due. It does not throw. The reload hook
   * operates it before each read of the private files, thus the read gets the whole set.
   */
  step(): Promise<SyncOutcome>;
}

type Answer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/** This function makes the sync of the configuration from the copy `source`. */
export function configSync(options: ConfigSyncOptions): ConfigSync {
  const { source, files, clock, ports } = options;
  const retry = options.retry ?? SYNC_RETRY;
  const limit = options.limit ?? EXCHANGE_LIMIT;
  let tried: Instant | undefined;
  let told: string | undefined;
  const tell = (message: string): void => {
    if (message !== told) options.report(message);
    told = message;
  };
  const refused = (problems: readonly string[]): SyncOutcome => {
    tell(`The configuration of the copy ${source.id} has problems in this copy. This copy keeps its files:\n- ${problems.join("\n- ")}`);
    return { kind: "refused", problems };
  };
  const failed = (message: string): SyncOutcome => {
    tell(message);
    return { kind: "failed", message };
  };

  const fetchFiles = async (): Promise<Answer> => {
    const own = new AbortController();
    const work = Promise.resolve()
      .then(() => options.call(source, own.signal))
      .then((value): Answer => ({ ok: true, value }));
    // The message of an error can hold the URL of the copy. Thus the report names only the kind of the error.
    const late = (): Answer => ({ ok: false, message: `The read of the configuration of the copy ${source.id} took longer than ${String(limit)} ms.` });
    const thrown = (error: unknown): Answer => ({ ok: false, message: `The read of the configuration of the copy ${source.id} failed (${error instanceof Error ? error.name : "no name"}).` });
    const answer = await limited(work, limit, clock, late, thrown);
    own.abort(new Error("The read of the configuration ended."));
    return answer;
  };

  const apply = async (served: SyncTexts, hash: string): Promise<SyncOutcome> => {
    const local = await ports.read();
    const parts = { files: served.parts.map((part) => ({ name: part.name, file: { text: part.text } })) };
    const checked = checkStart({ config: { text: served.config }, secrets: local.secrets, copy: local.copy, parts }, options.checkOf);
    if (checked.tag === "err") return refused(checked.error);
    if (configHash(checked.value.parsed.config) !== hash) {
      return refused([`The texts give another hash of the configuration in this copy. The code of the copy ${source.id} and of this copy is not the same.`]);
    }
    const plan = syncPlan(files, local, served);
    if (plan.tag === "err") return refused(plan.error);
    if (plan.value === "same") {
      tell(`This copy has the files of the copy ${source.id}, but it operates another configuration. A restart request starts it with the files.`);
      return { kind: "same" };
    }
    if (ports.hold !== undefined && options.keyChanged !== undefined && changesKey(options.keyChanged, checked.value)) {
      try {
        await ports.hold(served);
      } catch (error) {
        return failed(`The held set cannot be written (${codeOf(error)}). The next try of the sync is after ${String(retry)} ms.`);
      }
      tell(`The configuration of the copy ${source.id} changes the snapshot key of this copy. A start of it folds the whole log, thus the set waits in the folder ${SYNC_HELD_FOLDER} of the host. Start \`deploy.ts files --held\`: it folds, and then it starts the runtime.`);
      return { kind: "held" };
    }
    const { write, remove } = plan.value;
    try {
      if (served.parts.length > 0) await ports.makeFolder(files.parts);
      // The parts come first and config.json last. The reload hook reads the files after the step, thus it reads the whole set.
      for (const file of write.slice(0, -1)) await ports.write(file.path, file.text);
      for (const path of remove) await ports.remove(path);
      const last = write.at(-1);
      if (last !== undefined) await ports.write(last.path, last.text);
    } catch (error) {
      return failed(`A file of the configuration cannot be written (${codeOf(error)}). The next try of the sync is after ${String(retry)} ms.`);
    }
    tell(`The configuration of the copy ${source.id} changed. This copy wrote ${String(write.length)} files and removed ${String(remove.length)} parts. The reload starts the runtime again.`);
    return { kind: "written", written: write.length, removed: remove.length };
  };

  return {
    step: async () => {
      const now = clock.now();
      if (!syncDue(options.read(), tried, now, retry)) return { kind: "idle" };
      tried = now;
      const answer = await fetchFiles();
      if (!answer.ok) return failed(answer.message);
      const parsed = parseConfigFiles(answer.value);
      if (parsed.tag === "err") return refused(parsed.error);
      const served = parsed.value;
      if (served.copy !== source.id) return refused([`The answer came from the copy ${served.copy}, not from the copy ${source.id}.`]);
      if (served.files === "mirror") return refused([`The copy ${source.id} takes its configuration from another copy. This copy takes files only from a copy with its own files.`]);
      if (served.files === "good") return refused([`The copy ${source.id} uses its last good set. This copy waits for the private files of that copy.`]);
      try {
        return await apply(served.files, served.configHash);
      } catch (error) {
        return failed(`The sync of the configuration failed (${error instanceof Error ? error.name : "no name"}).`);
      }
    },
  };
}
