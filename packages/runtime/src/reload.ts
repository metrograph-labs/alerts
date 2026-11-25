/**
 * This module keeps the private files of the runtime current: `config.json`, `secrets.env`, `copy.json` and the parts
 * of the configuration in the folder `parts`. Each rule below is the same for a part as for `config.json`.
 * The supervisor does the restart, thus the runtime has one start path.
 *
 * - The start uses the private files when they pass the check. A ready runtime writes them as the last good set, `start.good.json`.
 * - The start uses the last good set when the private files have problems. Thus a bad edit does not stop the alerts.
 * - Before the start uses the private files, it writes their key into the start marker `start.pending`. A ready runtime removes the marker.
 * - The marker counts the starts with its key that stopped before they were ready. One stop, for example a reboot, gives a second try of the files.
 *   After `STOP_LIMIT` stops in a row, the start uses the last good set. Thus a crash loop stops, and one stop does not give an old set.
 * - At each pass, the hook reads the private files again. A change that passes the check stops the runtime,
 *   and the supervisor starts it again with the new files.
 * - A change with problems gives its problems one time. The runtime keeps the files of its start.
 * - A new text of the restart request `restart.request` restarts the runtime with no check. Thus a deploy
 *   restarts the runtime on new code with no elevated shell. `requestRestart` checks the files with the code of its checkout first.
 *
 * No problem and no note holds a value of a file, a value of a key or a path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CopySettings } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import { canonicalHash } from "@mark1russell7/rigor-generators";
import * as z from "zod";
import {
  checkTexts,
  ConfigRefused,
  NO_PARTS,
  noParts,
  PARTS_FOLDER,
  readParts,
  readText,
  SECRETS_FILE,
  type CheckedConfig,
  type FileText,
  type InstanceCheck,
  type PartsTexts,
  type PrivateTexts,
} from "./config.ts";
import { COPY_FILE, copySettings } from "./copy.ts";

/** This name is the name of the last good set of the private files in the private folder. Only a ready runtime writes it. */
export const GOOD_FILE = "start.good.json";

/** This name is the name of the start marker in the private folder. A start writes it, and a ready runtime removes it. */
export const START_MARKER_FILE = "start.pending";

/** This name is the name of the restart request in the private folder. Each new text of the file restarts the runtime. */
export const RESTART_REQUEST_FILE = "restart.request";

/** The format of the last good set. */
export const GOOD_FORMAT = "alerts-good-start/1";

/** The format of the start marker. */
export const MARKER_FORMAT = "alerts-start/1";

// The scheme of the key of a start. A new scheme gives a new key to each start.
const START_KEY_SCHEME = "alerts-start-key/1";

/** The count of the stops in a row with one key that give way to the last good set. One stop gives a second try of the files. */
export const STOP_LIMIT = 2;

/** The note of a start after one stop with the same files. The start tries the files again. */
export const STOPPED_ONCE = "The last start with these private files stopped before the runtime was ready. This start tries them again.";

/** The reason of a start that uses the last good set, because the last starts with the same files stopped before they were ready. */
export const STOPPED_START: string = `The last ${String(STOP_LIMIT)} starts with these private files stopped before the runtime was ready.`;

/** The reason of a fold for the last good set (AL-169): the mode fold picked the set. */
export const PICKED_GOOD = "The mode fold folds for the last good set.";

/** The note of a start after the stops, when the last good set has the same texts as the private files. */
export const STOPPED_SAME: string = `${STOPPED_START} The last good set has the same texts, thus the fault is not in the private files.`;

/** The paths of the private files that the start reads and writes. */
export interface PrivateFiles {
  readonly config: string;
  readonly secrets: string;
  readonly copy: string;
  /** The folder of the parts of the configuration. */
  readonly parts: string;
  /** The last good set of the private files. Only `ready` of a start writes it. */
  readonly good: string;
  /** The start marker. Only the start and `ready` write it. */
  readonly marker: string;
  /** The restart request. Only `requestRestart` writes it. */
  readonly request: string;
}

/** This function gives the paths of the private files: the configuration at `config`, and the other files in the private folder. */
export function privateFiles(home: string, config: string): PrivateFiles {
  return {
    config,
    secrets: join(home, SECRETS_FILE),
    copy: join(home, COPY_FILE),
    parts: join(home, PARTS_FOLDER),
    good: join(home, GOOD_FILE),
    marker: join(home, START_MARKER_FILE),
    request: join(home, RESTART_REQUEST_FILE),
  };
}

/** The texts of the private files of a start: `config.json`, `secrets.env`, `copy.json` and the parts. */
export interface StartTexts extends PrivateTexts {
  readonly copy: FileText;
}

const readAt = (path: string): Promise<FileText> => readText(() => readFile(path, "utf8"));

/** This function reads the texts of the private files. A file that cannot be read gives the code of the error. */
export async function readStartTexts(files: PrivateFiles): Promise<StartTexts> {
  const [config, secrets, copy, parts] = await Promise.all([readAt(files.config), readAt(files.secrets), readAt(files.copy), readParts(files.parts)]);
  return { config, secrets, copy, parts };
}

/** This function reads the text of the restart request. A missing file gives the code of the error. */
export function readRestartRequest(files: PrivateFiles): Promise<FileText> {
  return readAt(files.request);
}

/** This function gives the check of the instance for the settings of a copy. */
export type CheckOf = (copy: CopySettings) => InstanceCheck;

/** The configuration of a start that passed the check, with the settings of its copy and the check of its instance. */
export interface CheckedStart extends CheckedConfig {
  readonly copy: CopySettings;
  readonly check: InstanceCheck;
}

/**
 * This function checks the texts of the private files, as the start does. It reads no file. The
 * problems of `copy.json` come first, because the check of the instance depends on the copy.
 */
export function checkStart(texts: StartTexts, checkOf: CheckOf): Result<CheckedStart, readonly string[]> {
  const copy = copySettings(texts.copy);
  if (copy.tag === "err") return copy;
  const check = checkOf(copy.value);
  const checked = checkTexts(texts, check);
  return checked.tag === "ok" ? ok({ ...checked.value, copy: copy.value, check }) : checked;
}

// The texts of the parts in a key. With no parts, a key has no entry for them. Thus a key from before the parts stays the same.
const partsInKey = (texts: StartTexts): readonly PartsTexts[] => (noParts(texts.parts) ? [] : [texts.parts ?? NO_PARTS]);

/** This function gives the key of the texts. Two reads have one key only when each text and each error code is the same. */
export function textsKey(texts: StartTexts): string {
  return JSON.stringify([texts.config, texts.secrets, texts.copy, ...partsInKey(texts)]);
}

/**
 * This function gives the key of a start: the SHA-256 of the texts of the private files and of the restart
 * request. Thus a new restart request gives a new key, and the next start uses the private files again.
 */
export function startKey(texts: StartTexts, request: FileText): string {
  return canonicalHash([START_KEY_SCHEME, texts.config, texts.secrets, texts.copy, request, ...partsInKey(texts)], { form: "json" });
}

/** The files of a start: the private files, or the last good set. */
export type StartUse = "files" | "good";

const fileTextSchema = z.union([z.strictObject({ text: z.string() }), z.strictObject({ code: z.string() })]);
const markerSchema = z.strictObject({ format: z.literal(MARKER_FORMAT), key: z.string(), use: z.enum(["files", "good"]), starts: z.number().int().min(1) });
const partsSchema = z.union([z.strictObject({ files: z.array(z.strictObject({ name: z.string(), file: fileTextSchema })) }), z.strictObject({ code: z.string() })]);
// A set from before the parts has no field `parts`. Thus it stays a valid set with no parts.
const goodSchema = z.strictObject({ format: z.literal(GOOD_FORMAT), config: fileTextSchema, secrets: fileTextSchema, copy: fileTextSchema, parts: partsSchema.optional() });

// The value of a JSON text, or undefined for a text that is not JSON.
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The start marker: the key of the files of a start, and the files that the start uses. It also counts the starts with the key. */
export interface StartMarker {
  readonly key: string;
  readonly use: StartUse;
  /** The count of the starts with this key, this start too, that did not get ready. */
  readonly starts: number;
}

/** This function gives the start marker of a text. A missing file, a read error and a bad text give `undefined`. */
export function parseMarker(file: FileText): StartMarker | undefined {
  if ("code" in file) return undefined;
  const parsed = markerSchema.safeParse(jsonOf(file.text));
  return parsed.success ? { key: parsed.data.key, use: parsed.data.use, starts: parsed.data.starts } : undefined;
}

/** This function gives the text of the start marker. */
export function markerText(marker: StartMarker): string {
  return `${JSON.stringify({ format: MARKER_FORMAT, key: marker.key, use: marker.use, starts: marker.starts })}\n`;
}

/** This function gives the texts of the last good set. A problem names the file, and it holds no value of the file. */
export function parseGood(file: FileText): Result<StartTexts, readonly string[]> {
  if ("code" in file) return err([`The last good set ${GOOD_FILE} cannot be read (${file.code}).`]);
  const parsed = goodSchema.safeParse(jsonOf(file.text));
  if (!parsed.success) return err([`The last good set ${GOOD_FILE} is not a valid set.`]);
  const { config, secrets, copy, parts } = parsed.data;
  return ok({ config, secrets, copy, parts: parts ?? NO_PARTS });
}

/** This function gives the text of the last good set of the texts. A set with no parts has no field `parts`, as before the parts. */
export function goodText(texts: StartTexts): string {
  const parts = noParts(texts.parts) ? {} : { parts: texts.parts };
  return `${JSON.stringify({ format: GOOD_FORMAT, config: texts.config, secrets: texts.secrets, copy: texts.copy, ...parts })}\n`;
}

/** The ports of a start. A test gives fakes, thus it can make a write or a removal fail. */
export interface StartPorts {
  /** This function writes a whole file, or it throws. The last good set holds the keys, thus the file needs the permissions of `secrets.env`. */
  readonly write: (path: string, text: string) => Promise<void>;
  /** This function removes a file. A missing file is not an error. Each other error throws. */
  readonly remove: (path: string) => Promise<void>;
}

/** The configuration of the start, the files that it came from, and the mark of a good start. */
export interface StartedConfig extends CheckedStart {
  /** The texts of the private files at the start. The hook compares each later read with them. */
  readonly texts: StartTexts;
  /** The text of the restart request at the start. The hook restarts the runtime for each other text. */
  readonly request: FileText;
  /** The files of the start: the private files, or the last good set. */
  readonly use: StartUse;
  /** The reasons of a start that uses the last good set. The list is empty when the start uses the private files. */
  readonly fallback: readonly string[];
  /** The notes of the start that do not stop it, for example a failed write of the start marker. */
  readonly notes: readonly string[];
  /** This value is true when the last good set has the same texts as the private files (AL-169). Then the two sets have one fold. */
  readonly same: boolean;
  /**
   * This function marks the start as good. The runtime uses it when its service operates and one pass ended.
   * A start with the private files writes them as the last good set, and it removes the start marker.
   * A start with the last good set keeps the marker. Thus each later start with the same files uses the last good set at once.
   *
   * The function gives notes, and it throws no error. A second use gives the notes of the first use.
   */
  readonly ready: () => Promise<readonly string[]>;
}

/**
 * This function gives the configuration of the start, or it throws `ConfigRefused` when the private files and the last good set both have problems.
 * - The start uses the private files when they pass the check, and the start marker has no `STOP_LIMIT` stops with their key.
 * - One stop with the key gives a second try of the files, with the note `STOPPED_ONCE`.
 * - After `STOP_LIMIT` stops with the key, or a marker with the use `good`, the start uses the last good set.
 * - When the last good set has the same texts as the private files, the start uses the files again, with the note `STOPPED_SAME`.
 *
 * The mode fold gives `pick` (AL-169): it folds for one set, and the start marker does not choose it. With `files`, the
 * stops of the marker do not count. With `good`, the function gives the last good set, or it throws `ConfigRefused`.
 */
export async function startConfig(files: PrivateFiles, checkOf: CheckOf, ports: StartPorts, pick?: StartUse): Promise<StartedConfig> {
  const [texts, request, marker, good] = await Promise.all([readStartTexts(files), readRestartRequest(files), readAt(files.marker), readAt(files.good)]);
  const key = startKey(texts, request);
  const goodSet = parseGood(good);
  const same = goodSet.tag === "ok" && textsKey(goodSet.value) === textsKey(texts);
  const last = parseMarker(marker);
  // The stops with this key before this start. A marker with the use `good` holds the stops that gave way to the set.
  const stops = pick === "files" || last?.key !== key ? 0 : last.use === "good" ? Math.max(last.starts, STOP_LIMIT) : last.starts;
  const stopped = stops >= STOP_LIMIT;
  const problems: string[] = [];
  if (pick === "good") {
    problems.push(PICKED_GOOD);
  } else if (stopped && !same) {
    problems.push(STOPPED_START);
  } else {
    const checked = checkStart(texts, checkOf);
    if (checked.tag === "ok") {
      const told = stopped ? [STOPPED_SAME] : stops > 0 ? [STOPPED_ONCE] : [];
      const notes = [...told, ...(await writeMarker(files, ports, { key, use: "files", starts: stops + 1 }))];
      let marked: Promise<readonly string[]> | undefined;
      const ready = (): Promise<readonly string[]> => (marked ??= markGood(files, ports, texts, same));
      return { ...checked.value, texts, request, use: "files", fallback: [], notes, same, ready };
    }
    problems.push(...checked.error);
  }
  if (goodSet.tag === "err") throw new ConfigRefused([...problems, ...goodSet.error]);
  const fallback = checkStart(goodSet.value, checkOf);
  if (fallback.tag === "err") throw new ConfigRefused([...problems, ...fallback.error.map((problem) => `The last good set ${GOOD_FILE}: ${problem}`)]);
  // A stopped start keeps the marker, with the use `good`. Files with problems need no marker, because the next check finds the problems again.
  const notes = stopped ? await writeMarker(files, ports, { key, use: "good", starts: stops }) : await removeMarker(files, ports);
  return { ...fallback.value, texts, request, use: "good", fallback: problems, notes, same, ready: () => Promise.resolve([]) };
}

// The mark of a good start with the private files: the last good set gets the files, and the marker goes.
async function markGood(files: PrivateFiles, ports: StartPorts, texts: StartTexts, same: boolean): Promise<readonly string[]> {
  const written = same ? [] : await attempt(() => ports.write(files.good, goodText(texts)), (code) => `The last good set ${GOOD_FILE} cannot be written (${code}). The old set stays.`);
  return [...written, ...(await removeMarker(files, ports))];
}

function writeMarker(files: PrivateFiles, ports: StartPorts, marker: StartMarker): Promise<readonly string[]> {
  return attempt(
    () => ports.write(files.marker, markerText(marker)),
    (code) => `The start marker ${START_MARKER_FILE} cannot be written (${code}). When this start stops before it is ready, the next start does not know it.`,
  );
}

function removeMarker(files: PrivateFiles, ports: StartPorts): Promise<readonly string[]> {
  return attempt(() => ports.remove(files.marker), (code) => `The start marker ${START_MARKER_FILE} cannot be removed (${code}).`);
}

// A failed write or removal does not stop the start. The note gives only the code of the error.
async function attempt(work: () => Promise<void>, note: (code: string) => string): Promise<readonly string[]> {
  const done = await readText(() => work().then(() => ""));
  return "code" in done ? [note(done.code)] : [];
}

/** The state of the reload. It holds the keys of the texts and of the request at the start, and the key of the last refused texts. */
export interface ReloadState {
  readonly started: string;
  readonly refused?: string;
  readonly request: string;
}

/** The cause of a restart: a change of the private files that passes the check, or a new restart request. */
export type RestartCause = "changed" | "requested";

/** The action of one reload step. */
export type ReloadAction =
  | { readonly kind: "none" }
  | { readonly kind: "restart"; readonly cause: RestartCause }
  | { readonly kind: "refused"; readonly problems: readonly string[] };

/** This function gives the key of a restart request. Two reads have one key only when the text or the error code is the same. */
export function requestKey(request: FileText): string {
  return JSON.stringify(request);
}

/**
 * This function gives the next state and the action for a read of the texts and the request. It reads
 * no file and no clock.
 * - A text of the request that is not the request of the start restarts the runtime with no check.
 *   A read error of the request gives no restart. Thus a busy or a removed file does not stop the runtime.
 * - The texts of the start, or the texts of the last refusal, give no action. Other texts get the check.
 * - A return to the texts of the start clears the refusal. Thus a repeat of a bad change gives its problems again.
 */
export function reloadStep(state: ReloadState, texts: StartTexts, checkOf: CheckOf, request: FileText): { readonly state: ReloadState; readonly action: ReloadAction } {
  if ("text" in request && requestKey(request) !== state.request) return { state, action: { kind: "restart", cause: "requested" } };
  const key = textsKey(texts);
  if (key === state.started) return { state: { started: state.started, request: state.request }, action: { kind: "none" } };
  if (key === state.refused) return { state, action: { kind: "none" } };
  const checked = checkStart(texts, checkOf);
  if (checked.tag === "ok") return { state, action: { kind: "restart", cause: "changed" } };
  return { state: { started: state.started, refused: key, request: state.request }, action: { kind: "refused", problems: checked.error } };
}

/** The options of the hook of the reload. */
export interface ReloadOptions {
  readonly files: PrivateFiles;
  /** The check of the instance for the settings of a copy. */
  readonly checkOf: CheckOf;
  /** The texts of the start. */
  readonly started: StartTexts;
  /** The text of the restart request at the start. */
  readonly request: FileText;
  /** This function stops the runtime. The supervisor starts it again with the new files. The hook uses it one time. */
  readonly restart: (cause: RestartCause) => void;
  /** This function gets the problems of refused texts, one time for each change. */
  readonly onRefused: (problems: readonly string[]) => void;
  /**
   * This function operates at the start of each read, in the flight of the read. The sync of the configuration writes its
   * files here, thus the read does not get half of a set. An error of the function refuses the read, as an error of the read does.
   */
  readonly beforeRead?: () => Promise<void>;
}

/** The hook of the reload. */
export interface ReloadHook {
  /** This function starts a read of the files and ends at once, thus a slow disk does not hold the pass. One read at a time is in flight. */
  readonly onPass: () => void;
  /** This promise ends when no read is in flight. */
  idle(): Promise<void>;
}

/** This function makes the hook of the reload for the option `onPass` of the runtime. The hook throws no error. */
export function reloadHook(options: ReloadOptions): ReloadHook {
  let state: ReloadState = { started: textsKey(options.started), request: requestKey(options.request) };
  let restarting = false;
  let flight: Promise<void> | undefined;
  const read = async (): Promise<void> => {
    await options.beforeRead?.();
    const [texts, request] = await Promise.all([readStartTexts(options.files), readRestartRequest(options.files)]);
    const step = reloadStep(state, texts, options.checkOf, request);
    state = step.state;
    if (step.action.kind === "restart") {
      restarting = true;
      options.restart(step.action.cause);
    } else if (step.action.kind === "refused") {
      options.onRefused(step.action.problems);
    }
  };
  return {
    onPass: () => {
      if (restarting || flight !== undefined) return;
      // The message of an error can quote a file. Thus the problem names only the kind of the error.
      flight = read()
        .catch((error: unknown) => options.onRefused([`The check of the private files failed (${error instanceof Error ? error.name : "no name"}).`]))
        .finally(() => {
          flight = undefined;
        });
    },
    idle: async () => {
      await flight;
    },
  };
}

/** The ports of a restart request. A test gives fakes, thus it starts and stops no process. */
export interface RestartPorts {
  /** This function writes a whole file, or it throws. */
  readonly write: (path: string, text: string) => Promise<void>;
  /** This function gives the process ID of the runtime, or `undefined` when no runtime runs. */
  readonly pid: () => Promise<number | undefined>;
  /** This function gives true when one readiness probe of the runtime passes. */
  readonly ready: () => Promise<boolean>;
  /** This function waits for a time in milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
  /** This function gives the time in milliseconds. */
  readonly now: () => number;
  /** This function gives a text that no earlier request had. */
  readonly token: () => string;
}

/** The options of a restart request. */
export interface RestartOptions {
  readonly files: PrivateFiles;
  /** The check of the instance for the settings of a copy, with the code that the new runtime operates. */
  readonly checkOf: CheckOf;
  /** The longest wait for the new runtime and its readiness, in milliseconds. */
  readonly waitMs: number;
  /** The pause between two reads of the runtime, in milliseconds. */
  readonly pollMs: number;
}

/**
 * The files of a new runtime, from its start marker. No marker gives the private files, and the use `good` gives the last good set.
 * The value `pending` tells that the start is not marked good.
 */
export type RestartUse = StartUse | "pending";

/** The outcome of a restart request. */
export type RestartOutcome =
  | { readonly kind: "refused"; readonly problems: readonly string[] }
  | { readonly kind: "no-runtime" }
  | { readonly kind: "restarted"; readonly from: number; readonly to: number; readonly ready: boolean; readonly use: RestartUse }
  | { readonly kind: "no-restart"; readonly pid: number };

/** This function gives the files of a runtime from the text of its start marker. */
export function restartUse(marker: FileText): RestartUse {
  if ("code" in marker) return marker.code === "ENOENT" ? "files" : "pending";
  return parseMarker(marker)?.use === "good" ? "good" : "pending";
}

/**
 * This function restarts the runtime on the code of this checkout, with no elevated shell.
 * - It checks the private files with `checkOf`. A problem stops it before the request.
 * - It writes a new text of the restart request. The hook of the runtime reads it at the next pass.
 * - It waits for a new process ID of the runtime, then for its readiness, then for the mark of its start.
 *   The mark tells if the new runtime uses the private files or the last good set. The whole wait is `waitMs` or less.
 */
export async function requestRestart(options: RestartOptions, ports: RestartPorts): Promise<RestartOutcome> {
  const checked = checkStart(await readStartTexts(options.files), options.checkOf);
  if (checked.tag === "err") return { kind: "refused", problems: checked.error };
  const from = await ports.pid();
  if (from === undefined) return { kind: "no-runtime" };
  await ports.write(options.files.request, `${ports.token()}\n`);
  const end = ports.now() + options.waitMs;
  let to: number | undefined;
  let ready = false;
  while (ports.now() < end) {
    await ports.sleep(options.pollMs);
    if (to === undefined) {
      const pid = await ports.pid();
      // The discovery file can have no process, or the old one, until the supervisor starts the new runtime.
      if (pid === undefined || pid === from) continue;
      to = pid;
    }
    ready ||= await ports.ready();
    if (!ready) continue;
    // The new start writes its marker before its service operates, thus the marker after the readiness is the marker of the new start.
    const use = restartUse(await readAt(options.files.marker));
    if (use !== "pending") return { kind: "restarted", from, to, ready, use };
  }
  return to === undefined ? { kind: "no-restart", pid: from } : { kind: "restarted", from, to, ready, use: "pending" };
}
