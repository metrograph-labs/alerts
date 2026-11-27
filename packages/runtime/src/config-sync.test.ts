import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { CONFIG_FORMAT, CONFIG_PART_FORMAT, configHash, COPY_FORMAT, type AlertConfig, type ChannelDescriptor, type ChannelId, type CopyPeer, type CopyRead, type CopySettings, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_PARTS, type InstanceCheck, type PartsTexts } from "./config.ts";
import {
  CONFIG_FILES_FORMAT,
  configFilesOf,
  configSync,
  heldTexts,
  parseConfigFiles,
  SYNC_RETRY,
  syncDue,
  syncPlan,
  type ConfigFiles,
  type ConfigSyncOptions,
  type SyncPorts,
  type SyncTexts,
} from "./config-sync.ts";
import { EXCHANGE_LIMIT } from "./copy.ts";
import { checkStart, privateFiles, readStartTexts, reloadHook, type CheckOf, type PrivateFiles, type RestartCause, type StartTexts } from "./reload.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const T0 = 1_800_000_000_000;

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

// The start of each private value. A check looks for it in each answer and each report.
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
// A configuration that the check refuses: a private value in a wrong field.
const BAD = JSON.stringify({ ...configWith("Place A"), format: `${PRIVATE}-format` });
const KEYS = `PUSHOVER_USER=${PRIVATE}-user\n`;
const partWith = (label: string): string => JSON.stringify({ format: CONFIG_PART_FORMAT, places: [{ id: "place:b", label, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }] });
const PART = partWith("Place C");

const CHECK: InstanceCheck = { channels: [CHANNEL], problems: () => [] };
const CHECK_OF: CheckOf = () => CHECK;

const HOME: CopyPeer = { id: "home", url: "http://home.example.ts.net:4751" };
const MIRROR: CopySettings = { format: COPY_FORMAT, id: "cloud", rank: 1, listen: { host: "100.64.0.2", port: 4751 }, peers: [HOME], configFrom: "home" };
const SOURCE: CopySettings = { format: COPY_FORMAT, id: "home", rank: 0, listen: { host: "100.64.0.1", port: 4751 }, peers: [{ id: "cloud", url: "http://cloud.example.ts.net:4751" }] };

const partsOf = (parts: SyncTexts["parts"]): PartsTexts => ({ files: parts.map(({ name, text }) => ({ name, file: { text } })) });
const startOf = (config: string, parts: PartsTexts = NO_PARTS, copy: CopySettings = SOURCE): StartTexts => ({
  config: { text: config },
  secrets: { text: KEYS },
  copy: { text: JSON.stringify(copy) },
  parts,
});

// The texts with no folder of the parts.
const withoutParts = (texts: StartTexts): StartTexts => ({ config: texts.config, secrets: texts.secrets, copy: texts.copy });

// The hash of the configuration of a set of texts, as the source gives it.
function hashOf(texts: SyncTexts): string {
  const checked = checkStart(startOf(texts.config, partsOf(texts.parts)), CHECK_OF);
  if (checked.tag === "err") throw new Error(checked.error.join("\n"));
  return configHash(checked.value.parsed.config);
}

const answerOf = (texts: SyncTexts, copy = "home"): ConfigFiles => ({ format: CONFIG_FILES_FORMAT, copy, configHash: hashOf(texts), files: texts });
const behind: CopyRead = { at: T0, skew: 0, sameConfig: false };
const level: CopyRead = { at: T0, skew: 0, sameConfig: true };

describe("configFilesOf", () => {
  it("serves the texts of config.json and of the parts, and no text of secrets.env or copy.json", () => {
    const texts = startOf(GOOD, partsOf([{ name: "extra", text: PART }]));
    const answer = configFilesOf({ copy: SOURCE, use: "files", texts, configHash: "hash-1" });
    expect(answer).toEqual({ format: CONFIG_FILES_FORMAT, copy: "home", configHash: "hash-1", files: { config: GOOD, parts: [{ name: "extra", text: PART }] } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE);
    expect(JSON.stringify(answer)).not.toContain("100.64.0.1");
  });

  it("serves no texts for a copy with configFrom, a start with the last good set, or a text with a read error", () => {
    const texts = startOf(GOOD);
    expect(configFilesOf({ copy: MIRROR, use: "files", texts, configHash: "h" }).files).toBe("mirror");
    expect(configFilesOf({ copy: SOURCE, use: "good", texts, configHash: "h" }).files).toBe("good");
    expect(configFilesOf({ copy: SOURCE, use: "files", texts: { ...texts, parts: { code: "EACCES" } }, configHash: "h" }).files).toBe("good");
    expect(configFilesOf({ copy: SOURCE, use: "files", texts: { ...texts, parts: { files: [{ name: "extra", file: { code: "EACCES" } }] } }, configHash: "h" }).files).toBe("good");
    // A start with no folder of the parts serves no parts.
    expect(configFilesOf({ copy: SOURCE, use: "files", texts: withoutParts(texts), configHash: "h" }).files).toEqual({ config: GOOD, parts: [] });
  });
});

describe("parseConfigFiles", () => {
  it("gives the answer back, and refuses another form with a problem that holds no text of the answer", () => {
    const answer = answerOf({ config: GOOD, parts: [{ name: "extra", text: PART }] });
    expect(parseConfigFiles(answer)).toEqual({ tag: "ok", value: answer });
    expect(parseConfigFiles({ ...answer, files: "mirror" }).tag).toBe("ok");
    const bad = [
      { ...answer, format: "alerts-config-files/2" },
      { ...answer, files: { config: GOOD, parts: [{ name: "Extra", text: PART }] } },
      { ...answer, files: { config: GOOD, parts: [{ name: "extra", text: PART, more: 1 }] } },
      { ...answer, files: "other" },
      { ...answer, secrets: KEYS },
      { ...answer, copy: "" },
      null,
    ];
    for (const value of bad) {
      const parsed = parseConfigFiles(value);
      expect(parsed.tag).toBe("err");
      if (parsed.tag === "err") expect(parsed.error.join("\n")).not.toContain(PRIVATE);
    }
    const twice = parseConfigFiles({ ...answer, files: { config: GOOD, parts: [{ name: "extra", text: PART }, { name: "extra", text: PART }] } });
    expect(twice).toEqual({ tag: "err", error: ["The answer has two parts with one name."] });
  });
});

describe("syncDue", () => {
  it("is due only after a read with another hash, and after the retry time of the last try", () => {
    expect(syncDue(undefined, undefined, T0, SYNC_RETRY)).toBe(false);
    expect(syncDue(level, undefined, T0, SYNC_RETRY)).toBe(false);
    expect(syncDue(behind, undefined, T0, SYNC_RETRY)).toBe(true);
    expect(syncDue(behind, T0, T0 + SYNC_RETRY - 1, SYNC_RETRY)).toBe(false);
    expect(syncDue(behind, T0, T0 + SYNC_RETRY, SYNC_RETRY)).toBe(true);
  });
});

describe("syncPlan", () => {
  const files = privateFiles("/alerts", "/alerts/config.json");

  it("writes the changed parts first and config.json last, and removes the parts that the source does not have", () => {
    const local = startOf(GOOD, partsOf([{ name: "extra", text: PART }, { name: "old", text: PART }]));
    const plan = syncPlan(files, local, { config: OTHER, parts: [{ name: "extra", text: PART }, { name: "new", text: PART }] });
    expect(plan).toEqual({
      tag: "ok",
      value: { write: [{ path: join(files.parts, "new.json"), text: PART }, { path: files.config, text: OTHER }], remove: [join(files.parts, "old.json")] },
    });
  });

  it("gives same for the same texts, and a problem for a folder of the parts that cannot be read", () => {
    expect(syncPlan(files, startOf(GOOD, partsOf([{ name: "extra", text: PART }])), { config: GOOD, parts: [{ name: "extra", text: PART }] })).toEqual({ tag: "ok", value: "same" });
    expect(syncPlan(files, withoutParts(startOf(GOOD)), { config: GOOD, parts: [] })).toEqual({ tag: "ok", value: "same" });
    expect(syncPlan(files, { ...startOf(GOOD), parts: { code: "EACCES" } }, { config: GOOD, parts: [] })).toEqual({ tag: "err", error: ["The folder of the parts cannot be read (EACCES)."] });
    // A local file with a read error gets the text of the source.
    const unread = syncPlan(files, { ...startOf(GOOD), config: { code: "EACCES" } }, { config: GOOD, parts: [] });
    expect(unread).toEqual({ tag: "ok", value: { write: [{ path: files.config, text: GOOD }], remove: [] } });
  });

  it("makes the local files the texts of the source, and gives same only for the same texts (seeded)", () => {
    const names = ["a", "b", "c", "d", "e"];
    const textsOf = (r: ReturnType<typeof random>): SyncTexts => ({
      config: r.pick([GOOD, OTHER]),
      parts: r.sample(names, r.int(0, names.length)).sort().map((name) => ({ name, text: partWith(r.pick(["X", "Y"])) })),
    });
    for (const seed of SEEDS) {
      const r = random(`config-sync-plan:${seed}`);
      const local = textsOf(r);
      const served = textsOf(r);
      const plan = syncPlan(files, startOf(local.config, partsOf(local.parts)), served);
      if (plan.tag === "err") throw new Error(`seed ${r.seed}: ${plan.error.join("\n")}`);
      const disk = new Map<string, string>([[files.config, local.config], ...local.parts.map((part): [string, string] => [join(files.parts, `${part.name}.json`), part.text])]);
      if (plan.value !== "same") {
        expect(plan.value.write.at(-1)?.path === files.config || local.config === served.config, `seed ${r.seed}`).toBe(true);
        for (const file of plan.value.write) disk.set(file.path, file.text);
        for (const path of plan.value.remove) disk.delete(path);
      }
      const expected = new Map<string, string>([[files.config, served.config], ...served.parts.map((part): [string, string] => [join(files.parts, `${part.name}.json`), part.text])]);
      expect(disk, `seed ${r.seed}`).toEqual(expected);
      expect(plan.value === "same", `seed ${r.seed}`).toBe(JSON.stringify(local) === JSON.stringify(served));
    }
  });
});

describe("configSync", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-sync-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await writeFile(files.secrets, KEYS, "utf8");
    await writeFile(files.copy, JSON.stringify(MIRROR), "utf8");
    await writeFile(files.config, GOOD, "utf8");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const PORTS: SyncPorts = {
    read: () => readStartTexts(files),
    makeFolder: async (path) => {
      await mkdir(path, { recursive: true });
    },
    write: (path, text) => writeFile(path, text, "utf8"),
    remove: (path) => rm(path, { force: true }),
  };

  interface Rig {
    readonly options: ConfigSyncOptions;
    readonly clock: ReturnType<typeof fakeWallClock>;
    readonly reports: string[];
    readonly calls: CopyPeer[];
    read: CopyRead | undefined;
  }

  function rig(answer: (peer: CopyPeer, signal: AbortSignal) => Promise<unknown>, ports: SyncPorts = PORTS): Rig {
    const clock = fakeWallClock(T0);
    const reports: string[] = [];
    const calls: CopyPeer[] = [];
    const state: Rig = {
      clock,
      reports,
      calls,
      read: behind,
      options: {
        source: HOME,
        files,
        checkOf: CHECK_OF,
        read: () => state.read,
        call: (peer, signal) => {
          calls.push(peer);
          return answer(peer, signal);
        },
        clock,
        ports,
        report: (message) => reports.push(message),
      },
    };
    return state;
  }

  it("does not read the source when the hashes are the same or when no read passed", async () => {
    const r = rig(() => Promise.reject(new Error("no call")));
    const sync = configSync(r.options);
    r.read = level;
    expect(await sync.step()).toEqual({ kind: "idle" });
    r.read = undefined;
    expect(await sync.step()).toEqual({ kind: "idle" });
    expect(r.calls).toEqual([]);
  });

  it("writes the texts of the source, and then the reload hook starts the runtime again", async () => {
    await mkdir(files.parts);
    await writeFile(join(files.parts, "old.json"), PART, "utf8");
    const served: SyncTexts = { config: OTHER, parts: [{ name: "extra", text: partWith("Place D") }] };
    const r = rig(() => Promise.resolve(answerOf(served)));
    const sync = configSync(r.options);
    const started = await readStartTexts(files);
    const restarts: RestartCause[] = [];
    const refusals: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      checkOf: CHECK_OF,
      started,
      request: { code: "ENOENT" },
      restart: (cause) => restarts.push(cause),
      onRefused: (problems) => refusals.push(problems),
      beforeRead: async () => {
        await sync.step();
      },
    });
    hook.onPass();
    await hook.idle();
    expect(r.calls).toEqual([HOME]);
    expect(await readFile(files.config, "utf8")).toBe(OTHER);
    expect(await readFile(join(files.parts, "extra.json"), "utf8")).toBe(partWith("Place D"));
    expect((await readStartTexts(files)).parts).toEqual(partsOf(served.parts));
    // The private files of this copy stay the same.
    expect(await readFile(files.secrets, "utf8")).toBe(KEYS);
    expect(await readFile(files.copy, "utf8")).toBe(JSON.stringify(MIRROR));
    expect(restarts).toEqual(["changed"]);
    expect(refusals).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toContain("wrote 2 files and removed 1 parts");
  });

  it("holds a set that changes the snapshot key, writes no private file and starts no restart (AL-179)", async () => {
    const served: SyncTexts = { config: OTHER, parts: [{ name: "extra", text: partWith("Place D") }] };
    const held: SyncTexts[] = [];
    const checked: string[] = [];
    const r = rig(() => Promise.resolve(answerOf(served)), { ...PORTS, hold: (texts) => Promise.resolve(void held.push(texts)) });
    const sync = configSync({ ...r.options, keyChanged: (start) => (checked.push(start.copy.id), true) });
    const started = await readStartTexts(files);
    const restarts: RestartCause[] = [];
    const hook = reloadHook({ files, checkOf: CHECK_OF, started, request: { code: "ENOENT" }, restart: (cause) => restarts.push(cause), onRefused: () => undefined, beforeRead: async () => void (await sync.step()) });
    hook.onPass();
    await hook.idle();
    expect(held).toEqual([served]);
    expect(checked).toEqual([MIRROR.id]);
    // The private files stay as they were, thus the reload hook sees no change.
    expect(await readFile(files.config, "utf8")).toBe(GOOD);
    expect(restarts).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toContain("changes the snapshot key");
    expect(r.reports[0]).toContain("deploy.ts files --held");
  });

  it("writes a set with the same key, and holds a set when the key cannot be made (AL-179)", async () => {
    const served: SyncTexts = { config: OTHER, parts: [] };
    const held: SyncTexts[] = [];
    const ports: SyncPorts = { ...PORTS, hold: (texts) => Promise.resolve(void held.push(texts)) };
    const same = configSync({ ...rig(() => Promise.resolve(answerOf(served)), ports).options, keyChanged: () => false });
    expect(await same.step()).toEqual({ kind: "written", written: 1, removed: 0 });
    expect(held).toEqual([]);
    await writeFile(files.config, GOOD, "utf8");
    const fault = configSync({ ...rig(() => Promise.resolve(answerOf(served)), ports).options, keyChanged: () => { throw new Error("no key"); } });
    expect(await fault.step()).toEqual({ kind: "held" });
    expect(held).toEqual([served]);
    expect(await readFile(files.config, "utf8")).toBe(GOOD);
  });

  it("refuses texts with problems, changes no file, and tells each refusal one time", async () => {
    // The source has its own secrets. Thus a hash of a refused text does not come from the check here.
    const r = rig(() => Promise.resolve({ format: CONFIG_FILES_FORMAT, copy: "home", configHash: "hash-of-the-source", files: { config: BAD, parts: [] } }));
    const sync = configSync(r.options);
    const first = await sync.step();
    expect(first.kind).toBe("refused");
    expect(await readFile(files.config, "utf8")).toBe(GOOD);
    // No second read before the retry time.
    expect(await sync.step()).toEqual({ kind: "idle" });
    await r.clock.advance(SYNC_RETRY);
    expect((await sync.step()).kind).toBe("refused");
    expect(r.calls).toHaveLength(2);
    expect(r.reports).toHaveLength(1);
    expect(r.reports.join("\n")).not.toContain(PRIVATE);
  });

  it("refuses a mirror, a source with the last good set, another copy and another hash", async () => {
    const texts: SyncTexts = { config: OTHER, parts: [] };
    const cases: [unknown, string][] = [
      [{ format: CONFIG_FILES_FORMAT, copy: "home", configHash: "h", files: "mirror" }, "takes its configuration from another copy"],
      [{ format: CONFIG_FILES_FORMAT, copy: "home", configHash: "h", files: "good" }, "uses its last good set"],
      [answerOf(texts, "cloud"), "The answer came from the copy cloud, not from the copy home."],
      [{ ...answerOf(texts), configHash: "another-hash" }, "another hash of the configuration"],
      [{ format: "alerts-config-files/9" }, "not a set of the files"],
    ];
    for (const [answer, text] of cases) {
      const r = rig(() => Promise.resolve(answer));
      const outcome = await configSync(r.options).step();
      expect(outcome.kind).toBe("refused");
      expect(r.reports.join("\n")).toContain(text);
      expect(await readFile(files.config, "utf8")).toBe(GOOD);
    }
  });

  it("names only the kind of an error of the read, and stops a read at the time limit", async () => {
    const thrown = rig(() => Promise.reject(new TypeError(`fetch failed for ${HOME.url}`)));
    expect(await configSync(thrown.options).step()).toEqual({ kind: "failed", message: "The read of the configuration of the copy home failed (TypeError)." });
    expect(thrown.reports.join("\n")).not.toContain("example");

    let aborted = false;
    const slow = rig(
      (_peer, signal) =>
        new Promise<unknown>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const step = configSync(slow.options).step();
    await slow.clock.advance(EXCHANGE_LIMIT);
    expect(await step).toEqual({ kind: "failed", message: `The read of the configuration of the copy home took longer than ${String(EXCHANGE_LIMIT)} ms.` });
    expect(aborted).toBe(true);
  });

  it("gives the code of a failed write, and tells same when the files are the texts of the source", async () => {
    const served: SyncTexts = { config: OTHER, parts: [] };
    const locked = rig(() => Promise.resolve(answerOf(served)), {
      ...PORTS,
      write: () => Promise.reject(Object.assign(new Error(`EACCES: ${home}`), { code: "EACCES" })),
    });
    const outcome = await configSync(locked.options).step();
    expect(outcome.kind).toBe("failed");
    expect(locked.reports.join("\n")).toContain("(EACCES)");
    expect(locked.reports.join("\n")).not.toContain(PRIVATE);

    const same = rig(() => Promise.resolve(answerOf({ config: GOOD, parts: [] })));
    expect(await configSync(same.options).step()).toEqual({ kind: "same" });
  });
});

describe("heldTexts (AL-179)", () => {
  it("reads the parts that end in .json in the order of the names, and gives undefined with no config.json", () => {
    const parts = [{ file: "b.json", text: "B" }, { file: "notes.txt", text: "N" }, { file: "a.json", text: "A" }];
    expect(heldTexts("C", parts)).toEqual({ config: "C", parts: [{ name: "a", text: "A" }, { name: "b", text: "B" }] });
    expect(heldTexts(undefined, parts)).toBeUndefined();
  });
});
