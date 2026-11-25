import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, CONFIG_PART_FORMAT, ONLY_COPY, type AlertConfig, type ChannelDescriptor, type ChannelId, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigRefused, NO_PARTS, PARTS_FOLDER, type FileText, type InstanceCheck, type PartsTexts } from "./config.ts";
import {
  GOOD_FILE,
  goodText,
  markerText,
  parseGood,
  parseMarker,
  PICKED_GOOD,
  privateFiles,
  readRestartRequest,
  readStartTexts,
  reloadHook,
  reloadStep,
  requestKey,
  requestRestart,
  RESTART_REQUEST_FILE,
  restartUse,
  START_MARKER_FILE,
  startConfig,
  startKey,
  STOP_LIMIT,
  STOPPED_ONCE,
  STOPPED_SAME,
  STOPPED_START,
  textsKey,
  type CheckOf,
  type PrivateFiles,
  type ReloadState,
  type RestartCause,
  type RestartPorts,
  type StartPorts,
  type StartTexts,
} from "./reload.ts";

const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person:a" as PersonId;

const CHANNEL: ChannelDescriptor = {
  id: PUSHOVER,
  title: "Pushover",
  dependsOn: ["provider:pushover"],
  uses: ["internet", "dns", "power"],
  breaksThrough: true,
  repeats: true,
  ack: "poll",
  maxTitle: 250,
  maxBody: 1024,
};

// The start of each private value. A check looks for it in each problem and each message.
const PRIVATE = "PRIVATE";

// A public place in Kansas, with a made-up label. The contact names a secret, not its value.
const configWith = (label: string): AlertConfig => ({
  format: CONFIG_FORMAT,
  places: [{ id: "place:a" as PlaceId, label, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }],
  people: [{ watch: { person: PERSON, places: ["place:a" as PlaceId], rules: [] } }],
  contacts: [{ person: PERSON, channel: PUSHOVER, address: { user: { secret: "PUSHOVER_USER" } } }],
  policies: [{ level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 600_000 }],
});
const GOOD = JSON.stringify(configWith("Place A"));
const OTHER = JSON.stringify(configWith("Place B"));
// A configuration with a private value in a wrong field: the check refuses it.
const BAD = JSON.stringify({ ...configWith("Place A"), format: `${PRIVATE}-format` });
const KEYS = `PUSHOVER_USER=${PRIVATE}-user\n`;
// The settings of a second copy. A valid copy.json passes the check, as the copy.json of the first deploy of two copies did.
const COPY_B = JSON.stringify({ ...ONLY_COPY, id: "copy-b" });
const CHECK: InstanceCheck = { channels: [CHANNEL], problems: () => [] };
const CHECK_OF: CheckOf = () => CHECK;
// No file: the code of a missing file.
const NONE: FileText = { code: "ENOENT" };

const write = (path: string, text: string): Promise<void> => writeFile(path, text, "utf8");
const PORTS: StartPorts = { write, remove: (path) => rm(path, { force: true }) };
const read = (path: string): Promise<FileText> => readFile(path, "utf8").then(
  (text) => ({ text }),
  (error: unknown) => ({ code: (error as { code?: string }).code ?? "no code" }),
);
const textsOf = (config: string, secrets = KEYS, copy: FileText = NONE, parts: PartsTexts = NO_PARTS): StartTexts => ({ config: { text: config }, secrets: { text: secrets }, copy, parts });
// A part with a second public place in Kansas, and the texts of a folder with that one part.
const PART = JSON.stringify({ format: CONFIG_PART_FORMAT, places: [{ id: "place:b", label: "Place B", codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }] });
const partsOf = (part: string): PartsTexts => ({ files: [{ name: "extra", file: { text: part } }] });

describe("startConfig", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-reload-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("merges the parts of the folder parts into the configuration of the start", async () => {
    await write(files.config, GOOD);
    await mkdir(files.parts);
    await write(join(files.parts, "extra.json"), PART);
    // The folder ignores a file with another end, for example a new part before its check.
    await write(join(files.parts, "extra.next.json.tmp"), "{");
    expect(files.parts).toBe(join(home, PARTS_FOLDER));
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.use).toBe("files");
    expect(started.parsed.config.places.map((place) => place.id)).toEqual(["place:a", "place:b"]);
    expect(started.texts).toEqual(textsOf(GOOD, KEYS, NONE, partsOf(PART)));
  });

  it("uses the private files when they pass the check, and writes the start marker with their key", async () => {
    await write(files.config, GOOD);
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(files.good).toBe(join(home, GOOD_FILE));
    expect(files.marker).toBe(join(home, START_MARKER_FILE));
    expect(started.use).toBe("files");
    expect(started.parsed.config).toEqual(configWith("Place A"));
    expect(started.keys).toEqual({ PUSHOVER_USER: `${PRIVATE}-user` });
    expect(started.copy).toEqual(ONLY_COPY);
    expect(started.texts).toEqual(textsOf(GOOD));
    expect(started.fallback).toEqual([]);
    expect(started.notes).toEqual([]);
    expect(parseMarker(await read(files.marker))).toEqual({ key: startKey(textsOf(GOOD), NONE), use: "files", starts: 1 });
    // The start is not ready yet, thus it writes no last good set.
    expect(await read(files.good)).toEqual(NONE);
    // No restart request exists at the first start.
    expect(files.request).toBe(join(home, RESTART_REQUEST_FILE));
    expect(started.request).toEqual(NONE);
  });

  it("tells when the last good set has the texts of the private files, and refuses a pick of a missing set (AL-169)", async () => {
    await write(files.config, GOOD);
    await expect(startConfig(files, CHECK_OF, PORTS, "good")).rejects.toBeInstanceOf(ConfigRefused);
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.same).toBe(false);
    await started.ready();
    const forGood = await startConfig(files, CHECK_OF, PORTS, "good");
    expect(forGood.use).toBe("good");
    expect(forGood.same).toBe(true);
  });

  it("writes the last good set and removes the marker when the start is ready, one time", async () => {
    await write(files.config, GOOD);
    let writes = 0;
    const started = await startConfig(files, CHECK_OF, { ...PORTS, write: async (path, text) => ((writes += 1), write(path, text)) });
    expect(await started.ready()).toEqual([]);
    expect(await started.ready()).toEqual([]);
    expect(await read(files.good)).toEqual({ text: goodText(textsOf(GOOD)) });
    expect(await read(files.marker)).toEqual(NONE);
    // One write of the marker at the start, and one write of the set at the first ready.
    expect(writes).toBe(2);
  });

  it("gives the text of the restart request at the start, thus the new runtime does not restart for it again", async () => {
    await write(files.config, GOOD);
    await write(files.request, "token 1\n");
    expect((await startConfig(files, CHECK_OF, PORTS)).request).toEqual({ text: "token 1\n" });
  });

  it("does not write the last good set when it has the same texts", async () => {
    await write(files.config, GOOD);
    await write(files.good, goodText(textsOf(GOOD)));
    const paths: string[] = [];
    const started = await startConfig(files, CHECK_OF, { ...PORTS, write: async (path, text) => (paths.push(path), write(path, text)) });
    await started.ready();
    expect(paths).toEqual([files.marker]);
  });

  it("replaces an older last good set at ready", async () => {
    await write(files.config, OTHER);
    await write(files.good, goodText(textsOf(GOOD)));
    await (await startConfig(files, CHECK_OF, PORTS)).ready();
    expect(await read(files.good)).toEqual({ text: goodText(textsOf(OTHER)) });
  });

  it("uses the last good set when config.json has problems, and gives the problems", async () => {
    await write(files.config, BAD);
    await write(files.good, goodText(textsOf(GOOD)));
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.use).toBe("good");
    expect(started.parsed.config).toEqual(configWith("Place A"));
    expect(started.fallback).toHaveLength(1);
    expect(started.fallback.join("\n")).not.toContain(PRIVATE);
    // The texts of the start are the texts on the disk, thus the hook does not see the bad file as a change.
    expect(started.texts.config).toEqual({ text: BAD });
    // The check finds the problems again at the next start, thus the start writes no marker. The last good set stays at ready.
    expect(await read(files.marker)).toEqual(NONE);
    expect(await started.ready()).toEqual([]);
    expect(await read(files.good)).toEqual({ text: goodText(textsOf(GOOD)) });
  });

  it("uses the last good set when config.json cannot be read", async () => {
    await write(files.good, goodText(textsOf(GOOD)));
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.fallback).toEqual(["The configuration file cannot be read (ENOENT)."]);
    expect(started.texts.config).toEqual(NONE);
  });

  it("uses the last good set and its copy settings when copy.json has problems", async () => {
    await write(files.config, GOOD);
    await write(files.copy, `{"id":"${PRIVATE}"`);
    await write(files.good, goodText(textsOf(GOOD)));
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.use).toBe("good");
    expect(started.copy).toEqual(ONLY_COPY);
    expect(started.fallback).toHaveLength(1);
    expect(started.fallback[0]).toMatch(/^The file copy\.json: /u);
    expect(started.fallback.join("\n")).not.toContain(PRIVATE);
  });

  it("uses the last good set with its own keys when secrets.env has problems", async () => {
    await write(files.config, GOOD);
    await write(files.secrets, `${PRIVATE} no equals sign\n`);
    await write(files.good, goodText(textsOf(GOOD)));
    const started = await startConfig(files, CHECK_OF, PORTS);
    expect(started.use).toBe("good");
    expect(started.keys).toEqual({ PUSHOVER_USER: `${PRIVATE}-user` });
    expect(started.fallback.join("\n")).not.toContain(PRIVATE);
  });

  it("throws ConfigRefused with the problems of the files and of the last good set, and no private value", async () => {
    await write(files.config, BAD);
    await write(files.good, `{"label":"${PRIVATE}"`);
    const thrown = await startConfig(files, CHECK_OF, PORTS).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ConfigRefused);
    if (!(thrown instanceof ConfigRefused)) return;
    expect(thrown.problems).toHaveLength(2);
    expect(thrown.problems[1]).toBe(`The last good set ${GOOD_FILE} is not a valid set.`);
    expect(thrown.message).not.toContain(PRIVATE);
  });

  it("throws ConfigRefused when the files have problems and no last good set exists", async () => {
    await write(files.config, BAD);
    const thrown = await startConfig(files, CHECK_OF, PORTS).catch((error: unknown) => error);
    expect(thrown instanceof ConfigRefused ? thrown.problems[1] : undefined).toBe(`The last good set ${GOOD_FILE} cannot be read (ENOENT).`);
  });

  it("throws ConfigRefused when the last good set has problems with the check of this code", async () => {
    await write(files.config, BAD);
    await write(files.good, goodText(textsOf(GOOD)));
    const refusing: CheckOf = () => ({ channels: [CHANNEL], problems: () => ["The file secrets.env has no PING_URL."] });
    const thrown = await startConfig(files, refusing, PORTS).catch((error: unknown) => error);
    expect(thrown instanceof ConfigRefused ? thrown.problems.at(-1) : undefined).toBe(`The last good set ${GOOD_FILE}: The file secrets.env has no PING_URL.`);
  });

  it("starts with a note when the start marker cannot be written", async () => {
    await write(files.config, GOOD);
    const failing = (): Promise<void> => Promise.reject(Object.assign(new Error(`${PRIVATE} path`), { code: "EACCES" }));
    const started = await startConfig(files, CHECK_OF, { ...PORTS, write: failing });
    expect(started.use).toBe("files");
    expect(started.notes).toEqual([`The start marker ${START_MARKER_FILE} cannot be written (EACCES). When this start stops before it is ready, the next start does not know it.`]);
    // At ready, the set cannot be written either. The note keeps the old set.
    expect(await started.ready()).toEqual([`The last good set ${GOOD_FILE} cannot be written (EACCES). The old set stays.`]);
  });

  it("removes the marker with a note when the last good set cannot be written at ready", async () => {
    await write(files.config, GOOD);
    const failing: StartPorts = { ...PORTS, write: (path, text) => (path === files.good ? Promise.reject(Object.assign(new Error(PRIVATE), { code: "ENOSPC" })) : write(path, text)) };
    const started = await startConfig(files, CHECK_OF, failing);
    expect(started.notes).toEqual([]);
    expect(await started.ready()).toEqual([`The last good set ${GOOD_FILE} cannot be written (ENOSPC). The old set stays.`]);
    // The start was good, thus the marker goes. The next start does not see it as a stopped start.
    expect(await read(files.marker)).toEqual(NONE);
    expect((await startConfig(files, CHECK_OF, PORTS)).use).toBe("files");
  });

  describe("a start that stops before it is ready", () => {
    // The first deploy of two copies: a new copy.json passed the check, and each start with it stopped before the runtime was ready.
    const startedOnce = async (): Promise<void> => {
      await write(files.config, GOOD);
      await (await startConfig(files, CHECK_OF, PORTS)).ready();
      await write(files.copy, COPY_B);
    };
    // The starts that stop before ready, with the same files: the count of a crash loop.
    const stops = async (count: number): Promise<void> => {
      for (let stop = 0; stop < count; stop += 1) await startConfig(files, CHECK_OF, PORTS);
    };

    it("tries the private files again after one stop, for example a reboot in the first pass", async () => {
      await startedOnce();
      const first = await startConfig(files, CHECK_OF, PORTS);
      expect(first.use).toBe("files");
      expect(first.copy.id).toBe("copy-b");
      // The process stops here, before ready. The next start tries the files again, with a note.
      const second = await startConfig(files, CHECK_OF, PORTS);
      expect(second.use).toBe("files");
      expect(second.copy.id).toBe("copy-b");
      expect(second.notes).toEqual([STOPPED_ONCE]);
      expect(parseMarker(await read(files.marker))).toEqual({ key: startKey(second.texts, NONE), use: "files", starts: 2 });
      // This start gets ready: the files become the last good set, and the marker goes.
      await second.ready();
      expect(await read(files.marker)).toEqual(NONE);
      expect(parseGood(await read(files.good))).toEqual({ tag: "ok", value: second.texts });
    });

    it("gives way to the last good set after STOP_LIMIT stops in a row with the same files", async () => {
      await startedOnce();
      await stops(STOP_LIMIT);
      const next = await startConfig(files, CHECK_OF, PORTS);
      expect(next.use).toBe("good");
      expect(next.copy).toEqual(ONLY_COPY);
      expect(next.fallback).toEqual([STOPPED_START]);
      // The texts of the start are the texts on the disk, thus the hook does not restart for them.
      expect(next.texts.copy).toEqual({ text: COPY_B });
      expect(parseMarker(await read(files.marker))).toEqual({ key: startKey(next.texts, NONE), use: "good", starts: STOP_LIMIT });
      // A ready runtime on the last good set keeps the marker and the set.
      expect(await next.ready()).toEqual([]);
      expect(await read(files.good)).toEqual({ text: goodText(textsOf(GOOD)) });
      // Each later start with the same files uses the last good set at once.
      const again = await startConfig(files, CHECK_OF, PORTS);
      expect(again.use).toBe("good");
      expect(again.fallback).toEqual([STOPPED_START]);
    });

    it("folds for the set that the mode fold picks, and the start marker does not choose it (AL-169)", async () => {
      await startedOnce();
      await stops(STOP_LIMIT);
      const marker = await read(files.marker);
      // The ports of the mode fold write nothing.
      const still: StartPorts = { write: () => Promise.resolve(), remove: () => Promise.resolve() };
      const forFiles = await startConfig(files, CHECK_OF, still, "files");
      expect(forFiles.use).toBe("files");
      expect(forFiles.copy.id).toBe("copy-b");
      expect(forFiles.same).toBe(false);
      const forGood = await startConfig(files, CHECK_OF, still, "good");
      expect(forGood.use).toBe("good");
      expect(forGood.fallback).toEqual([PICKED_GOOD]);
      expect(forGood.copy).toEqual(ONLY_COPY);
      expect(await read(files.marker)).toEqual(marker);
    });

    it("uses the private files again after a new restart request or a change of the files", async () => {
      await startedOnce();
      await stops(STOP_LIMIT);
      expect((await startConfig(files, CHECK_OF, PORTS)).use).toBe("good");
      // A new request gives a new key: the next start uses the files again.
      await write(files.request, "token 1\n");
      const requested = await startConfig(files, CHECK_OF, PORTS);
      expect(requested.use).toBe("files");
      expect(requested.notes).toEqual([]);
      expect(requested.copy.id).toBe("copy-b");
      // The starts with the request stop too. Then a fixed copy.json gives a new key, and its start is good.
      await stops(STOP_LIMIT - 1);
      expect((await startConfig(files, CHECK_OF, PORTS)).use).toBe("good");
      await write(files.copy, JSON.stringify({ ...ONLY_COPY, id: "copy-c" }));
      const fixed = await startConfig(files, CHECK_OF, PORTS);
      expect(fixed.use).toBe("files");
      await fixed.ready();
      expect(await read(files.marker)).toEqual(NONE);
      expect(parseGood(await read(files.good))).toEqual({ tag: "ok", value: fixed.texts });
    });

    it("uses the files again with a note when the last good set has the same texts", async () => {
      // New code that stops with the same files: the fault is not in the private files.
      await write(files.config, GOOD);
      await (await startConfig(files, CHECK_OF, PORTS)).ready();
      await stops(STOP_LIMIT);
      const next = await startConfig(files, CHECK_OF, PORTS);
      expect(next.use).toBe("files");
      expect(next.notes).toEqual([STOPPED_SAME]);
      expect(next.fallback).toEqual([]);
    });

    it("throws ConfigRefused after the stops when no last good set exists", async () => {
      await write(files.config, GOOD);
      await write(files.copy, COPY_B);
      await stops(STOP_LIMIT);
      const thrown = await startConfig(files, CHECK_OF, PORTS).catch((error: unknown) => error);
      expect(thrown instanceof ConfigRefused ? thrown.problems : undefined).toEqual([STOPPED_START, `The last good set ${GOOD_FILE} cannot be read (ENOENT).`]);
    });

    it("sees a marker of other files, or a broken marker, as no marker", async () => {
      await startedOnce();
      await write(files.marker, markerText({ key: "0".repeat(64), use: "good", starts: STOP_LIMIT }));
      const other = await startConfig(files, CHECK_OF, PORTS);
      expect(other.use).toBe("files");
      expect(other.notes).toEqual([]);
      await write(files.marker, `{"key":"${PRIVATE}"`);
      expect((await startConfig(files, CHECK_OF, PORTS)).notes).toEqual([]);
    });
  });
});

describe("the texts of the start files", () => {
  it("gives one key for the same texts and the same request, and another key for each change", () => {
    const key = startKey(textsOf(GOOD), NONE);
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(startKey(textsOf(GOOD), NONE)).toBe(key);
    const others = [startKey(textsOf(OTHER), NONE), startKey(textsOf(GOOD, "OTHER=value\n"), NONE), startKey(textsOf(GOOD, KEYS, { text: COPY_B }), NONE), startKey(textsOf(GOOD), { text: "token 1\n" })];
    expect(new Set([key, ...others]).size).toBe(5);
  });

  it("reads back the last good set and the marker that it writes", () => {
    const texts = textsOf(GOOD, KEYS, { text: COPY_B });
    expect(parseGood({ text: goodText(texts) })).toEqual({ tag: "ok", value: texts });
    expect(parseMarker({ text: markerText({ key: "k", use: "good", starts: 2 }) })).toEqual({ key: "k", use: "good", starts: 2 });
    const parted = textsOf(GOOD, KEYS, NONE, partsOf(PART));
    expect(parseGood({ text: goodText(parted) })).toEqual({ tag: "ok", value: parted });
    expect(parseGood({ text: goodText(textsOf(GOOD, KEYS, NONE, { code: "EACCES" })) })).toEqual({ tag: "ok", value: textsOf(GOOD, KEYS, NONE, { code: "EACCES" }) });
    // A marker with no count of the starts, or with a count of 0, is not a valid marker.
    expect(parseMarker({ text: JSON.stringify({ format: "alerts-start/1", key: "k", use: "files" }) })).toBeUndefined();
    expect(parseMarker({ text: JSON.stringify({ format: "alerts-start/1", key: "k", use: "files", starts: 0 }) })).toBeUndefined();
    expect(parseMarker({ text: JSON.stringify({ format: "alerts-start/1", key: "k", use: "other", starts: 1 }) })).toBeUndefined();
    expect(parseMarker(NONE)).toBeUndefined();
  });

  it("gives the keys and the last good set of a start with no parts as before the parts", () => {
    const before: StartTexts = { config: { text: GOOD }, secrets: { text: KEYS }, copy: NONE };
    expect(textsKey(textsOf(GOOD))).toBe(JSON.stringify([before.config, before.secrets, before.copy]));
    expect(textsKey(before)).toBe(textsKey(textsOf(GOOD)));
    expect(startKey(before, NONE)).toBe(startKey(textsOf(GOOD), NONE));
    // A set from before the parts has no field parts, and it gives a start with no parts.
    expect(goodText(textsOf(GOOD))).toBe(goodText(before));
    expect(JSON.parse(goodText(textsOf(GOOD)))).not.toHaveProperty("parts");
    expect(parseGood({ text: goodText(before) })).toEqual({ tag: "ok", value: textsOf(GOOD) });
  });

  it("gives another key for each part, each change of a part and an error of the read of the folder", () => {
    const keys = [textsOf(GOOD), textsOf(GOOD, KEYS, NONE, partsOf(PART)), textsOf(GOOD, KEYS, NONE, partsOf(PART.replace("Place B", "Place C"))), textsOf(GOOD, KEYS, NONE, { code: "EACCES" })];
    expect(new Set(keys.map(textsKey)).size).toBe(4);
    expect(new Set(keys.map((texts) => startKey(texts, NONE))).size).toBe(4);
  });

  it("gives the files of a new runtime from its start marker", () => {
    expect(restartUse(NONE)).toBe("files");
    expect(restartUse({ code: "EBUSY" })).toBe("pending");
    expect(restartUse({ text: markerText({ key: "k", use: "files", starts: 1 }) })).toBe("pending");
    expect(restartUse({ text: markerText({ key: "k", use: "good", starts: 2 }) })).toBe("good");
  });
});

describe("reloadStep", () => {
  const start: ReloadState = { started: textsKey(textsOf(GOOD)), request: requestKey(NONE) };

  it("restarts for a new part or a change of a part that passes the check, and refuses a bad part", () => {
    expect(reloadStep(start, textsOf(GOOD, KEYS, NONE, partsOf(PART)), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
    const parted: ReloadState = { started: textsKey(textsOf(GOOD, KEYS, NONE, partsOf(PART))), request: requestKey(NONE) };
    expect(reloadStep(parted, textsOf(GOOD, KEYS, NONE, partsOf(PART)), CHECK_OF, NONE).action).toEqual({ kind: "none" });
    // The removal of the part is a change too.
    expect(reloadStep(parted, textsOf(GOOD), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
    expect(reloadStep(start, textsOf(GOOD, KEYS, NONE, partsOf("{")), CHECK_OF, NONE).action).toEqual({ kind: "refused", problems: ["The part extra is not valid JSON."] });
    expect(reloadStep(start, textsOf(GOOD, KEYS, NONE, { code: "EACCES" }), CHECK_OF, NONE).action).toEqual({ kind: "refused", problems: [`The folder ${PARTS_FOLDER} cannot be read (EACCES).`] });
  });

  it("gives no action for the texts of the start", () => {
    expect(reloadStep(start, textsOf(GOOD), CHECK_OF, NONE)).toEqual({ state: start, action: { kind: "none" } });
  });

  it("restarts for a change of each file that passes the check", () => {
    expect(reloadStep(start, textsOf(OTHER), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
    expect(reloadStep(start, textsOf(GOOD, `${KEYS}OTHER=value\n`), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
    expect(reloadStep(start, textsOf(GOOD, KEYS, { text: COPY_B }), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
  });

  it("gives the problems of a bad change one time", () => {
    const first = reloadStep(start, textsOf(BAD), CHECK_OF, NONE);
    expect(first.action.kind).toBe("refused");
    expect(first.state.refused).toBe(textsKey(textsOf(BAD)));
    expect(reloadStep(first.state, textsOf(BAD), CHECK_OF, NONE)).toEqual({ state: first.state, action: { kind: "none" } });
  });

  it("checks a second bad change, and restarts for a good change after a bad one", () => {
    const first = reloadStep(start, textsOf(BAD), CHECK_OF, NONE);
    expect(reloadStep(first.state, textsOf(BAD, "OTHER=value\n"), CHECK_OF, NONE).action.kind).toBe("refused");
    expect(reloadStep(first.state, textsOf(OTHER), CHECK_OF, NONE).action).toEqual({ kind: "restart", cause: "changed" });
  });

  it("clears the refusal after a return to the texts of the start", () => {
    const first = reloadStep(start, textsOf(BAD), CHECK_OF, NONE);
    const back = reloadStep(first.state, textsOf(GOOD), CHECK_OF, NONE);
    expect(back).toEqual({ state: start, action: { kind: "none" } });
    expect(reloadStep(back.state, textsOf(BAD), CHECK_OF, NONE).action.kind).toBe("refused");
  });

  it("sees a read error as a change, and refuses a missing file", () => {
    const step = reloadStep(start, { config: NONE, secrets: { text: KEYS }, copy: NONE }, CHECK_OF, NONE);
    expect(step.action).toEqual({ kind: "refused", problems: ["The configuration file cannot be read (ENOENT)."] });
  });

  it("refuses a bad copy.json, and checks the configuration with the check of the new copy", () => {
    const bad = reloadStep(start, textsOf(GOOD, KEYS, { text: "{" }), CHECK_OF, NONE);
    expect(bad.action.kind).toBe("refused");
    const byCopy: CheckOf = (copy) => ({ channels: [CHANNEL], problems: () => (copy.id === "copy-b" ? ["The file secrets.env has no HEALTHCHECKS_PING_URL_COPY_B."] : []) });
    expect(reloadStep(start, textsOf(GOOD, KEYS, { text: COPY_B }), byCopy, NONE).action).toEqual({ kind: "refused", problems: ["The file secrets.env has no HEALTHCHECKS_PING_URL_COPY_B."] });
  });

  it("gives the problems of the check of the instance", () => {
    const check: CheckOf = () => ({ channels: [CHANNEL], problems: () => ["The file secrets.env has no PING_URL."] });
    expect(reloadStep(start, textsOf(OTHER), check, NONE).action).toEqual({ kind: "refused", problems: ["The file secrets.env has no PING_URL."] });
  });

  it("restarts for a new text of the request with no check, also when the files have problems", () => {
    const refusing: CheckOf = () => ({ channels: [CHANNEL], problems: () => ["The check refuses each file."] });
    const requested = { kind: "restart", cause: "requested" };
    expect(reloadStep(start, textsOf(GOOD), refusing, { text: "token 1\n" }).action).toEqual(requested);
    expect(reloadStep(start, textsOf(BAD), CHECK_OF, { text: "token 1\n" }).action).toEqual(requested);
    // A second request replaces the request of the start.
    const later: ReloadState = { ...start, request: requestKey({ text: "token 1\n" }) };
    expect(reloadStep(later, textsOf(GOOD), CHECK_OF, { text: "token 2\n" }).action).toEqual(requested);
  });

  it("gives no restart for the request of the start, or for a read error of the request", () => {
    const later: ReloadState = { ...start, request: requestKey({ text: "token 1\n" }) };
    expect(reloadStep(later, textsOf(GOOD), CHECK_OF, { text: "token 1\n" })).toEqual({ state: later, action: { kind: "none" } });
    // A busy file or a removed file does not stop the runtime.
    expect(reloadStep(later, textsOf(GOOD), CHECK_OF, { code: "EBUSY" })).toEqual({ state: later, action: { kind: "none" } });
    expect(reloadStep(later, textsOf(GOOD), CHECK_OF, NONE)).toEqual({ state: later, action: { kind: "none" } });
  });
});

describe("reloadHook", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-hook-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
    await write(files.config, GOOD);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const hookOf = async (): Promise<{ hook: ReturnType<typeof reloadHook>; restarts: RestartCause[]; refused: (readonly string[])[] }> => {
    const restarts: RestartCause[] = [];
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      checkOf: CHECK_OF,
      started: await readStartTexts(files),
      request: await readRestartRequest(files),
      restart: (cause) => restarts.push(cause),
      onRefused: (problems) => refused.push(problems),
    });
    return { hook, restarts, refused };
  };
  const passes = async (hook: ReturnType<typeof reloadHook>, count: number): Promise<void> => {
    for (let pass = 0; pass < count; pass += 1) {
      hook.onPass();
      await hook.idle();
    }
  };

  it("restarts one time for a new restart request, also when config.json has problems", async () => {
    const { hook, restarts, refused } = await hookOf();
    await write(files.config, BAD);
    await write(files.request, "token 1\n");
    await passes(hook, 2);
    expect(restarts).toEqual(["requested"]);
    expect(refused).toEqual([]);
  });

  it("does nothing while the files stay the same", async () => {
    const { hook, restarts, refused } = await hookOf();
    await passes(hook, 1);
    expect(restarts).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("restarts one time for a good change, also after more passes", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.config, OTHER);
    await passes(hook, 2);
    expect(restarts).toEqual(["changed"]);
  });

  it("restarts for a change of copy.json that passes the check", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.copy, COPY_B);
    await passes(hook, 1);
    expect(restarts).toEqual(["changed"]);
  });

  it("gives the problems of a bad change one time, and keeps running", async () => {
    const { hook, restarts, refused } = await hookOf();
    await write(files.config, BAD);
    await passes(hook, 3);
    expect(restarts).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused.join("\n")).not.toContain(PRIVATE);
    // A good change after it restarts the runtime.
    await write(files.config, OTHER);
    await passes(hook, 1);
    expect(restarts).toEqual(["changed"]);
  });

  it("has one read in flight: a pass during a read starts no second read", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.config, OTHER);
    hook.onPass();
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual(["changed"]);
  });

  it("gives a problem with no private text when the restart throws, and does not throw", async () => {
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      checkOf: CHECK_OF,
      started: await readStartTexts(files),
      request: await readRestartRequest(files),
      restart: () => {
        throw new Error(PRIVATE);
      },
      onRefused: (problems) => refused.push(problems),
    });
    await write(files.config, OTHER);
    await passes(hook, 1);
    expect(refused).toEqual([["The check of the private files failed (Error)."]]);
  });
});

describe("requestRestart", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-restart-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
    await write(files.config, GOOD);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const OPTIONS = { checkOf: CHECK_OF, waitMs: 10_000, pollMs: 1000 };

  // Fake ports on a fake clock. Each read of the process ID takes the next value of `pids`, and the last value stays.
  // The function `onSleep` gets the time after each sleep, thus a test can change the start marker during the wait.
  const portsOf = (
    pids: readonly (number | undefined)[],
    ready: (call: number) => boolean,
    onSleep: (time: number) => Promise<void> = () => Promise.resolve(),
  ): { ports: RestartPorts; writes: [string, string][]; reads: () => number } => {
    let time = 0;
    let read = 0;
    let probes = 0;
    const writes: [string, string][] = [];
    const ports: RestartPorts = {
      write: async (path, text) => {
        writes.push([path, text]);
      },
      pid: async () => pids[Math.min(read++, pids.length - 1)],
      ready: async () => ready(probes++),
      sleep: async (ms) => {
        time += ms;
        await onSleep(time);
      },
      now: () => time,
      token: () => "token 1",
    };
    return { ports, writes, reads: () => read };
  };

  it("refuses files with problems before it writes a request, and gives no private value", async () => {
    await write(files.config, BAD);
    const { ports, writes, reads } = portsOf([10], () => true);
    const outcome = await requestRestart({ files, ...OPTIONS }, ports);
    expect(outcome.kind).toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE);
    expect(writes).toEqual([]);
    expect(reads()).toBe(0);
  });

  it("refuses a bad copy.json before it writes a request", async () => {
    await write(files.copy, "{");
    const { ports, writes } = portsOf([10], () => true);
    expect((await requestRestart({ files, ...OPTIONS }, ports)).kind).toBe("refused");
    expect(writes).toEqual([]);
  });

  it("writes no request when no runtime runs", async () => {
    const { ports, writes } = portsOf([undefined], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "no-runtime" });
    expect(writes).toEqual([]);
  });

  it("writes a new request, then waits for a new process, its readiness and the mark of its start", async () => {
    // The old process stays, then the discovery file has no process, then the new process starts. Its first probe fails.
    // The new start keeps its marker until its first pass at 5 s.
    await write(files.marker, markerText({ key: "k", use: "files", starts: 1 }));
    const { ports, writes } = portsOf([10, 10, undefined, 11], (call) => call > 0, async (time) => {
      if (time === 5000) await rm(files.marker);
    });
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: true, use: "files" });
    expect(writes).toEqual([[files.request, "token 1\n"]]);
  });

  it("tells when the new runtime uses the last good set", async () => {
    await write(files.marker, markerText({ key: "k", use: "good", starts: 2 }));
    const { ports } = portsOf([10, 11], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: true, use: "good" });
  });

  it("gives a pending start when the new runtime keeps the marker of its files for the whole wait", async () => {
    await write(files.marker, markerText({ key: "k", use: "files", starts: 1 }));
    const { ports } = portsOf([10, 11], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: true, use: "pending" });
  });

  it("gives a restart that is not ready when the new process does not pass the probe in the wait", async () => {
    const { ports } = portsOf([10, 11], () => false);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: false, use: "pending" });
  });

  it("gives no restart when the process stays the same for the whole wait", async () => {
    const { ports, reads } = portsOf([10], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "no-restart", pid: 10 });
    // One read before the request, and one read at each poll of the wait.
    expect(reads()).toBe(1 + OPTIONS.waitMs / OPTIONS.pollMs);
  });
});
