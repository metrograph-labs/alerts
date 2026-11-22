import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ABSENT,
  bundleFileOf,
  bundleFileText,
  bundleKey,
  checkBundleFile,
  inputFiles,
  outageBundles,
  PACKAGE_ROOT,
  type BundleFile,
  type BundleStore,
  type FunctionBundle,
} from "./bundle-file.ts";
import { OUTAGE_PATHS } from "./outage.ts";

// Fake bundles: this test makes no bundle with esbuild. The test of `bundle.ts` makes real ones.
const BUNDLES: readonly FunctionBundle[] = [
  { path: OUTAGE_PATHS.entry, visibility: "public", code: "exports.handler = () => 'entry';" },
  { path: OUTAGE_PATHS.press, visibility: "protected", code: "exports.handler = () => 'press';" },
  { path: OUTAGE_PATHS.ended, visibility: "protected", code: "exports.handler = () => 'ended';" },
];
const SOURCES = ["src/functions/outage.ts", "src/functions/press.ts", "src/functions/ended.ts"];

let folder = "";
let extra = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "alerts-bundle-file-"));
  extra = join(folder, "module.ts");
  await writeFile(extra, "export const a = 1;\n");
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** This function gives a good file of the fake bundles, with the sources, the module `outage.ts` and one temporary module as inputs. */
async function goodFile(): Promise<BundleFile> {
  return bundleFileOf({ bundles: BUNDLES, inputs: [...SOURCES, "src/outage.ts", relative(PACKAGE_ROOT, extra)] });
}

/** This function gives the reason of a check that must fail. */
async function reasonOf(text: string | undefined): Promise<string> {
  const check = await checkBundleFile(text);
  if (check.ok) throw new Error("The check passed.");
  return check.reason;
}

/** A store in memory that counts its writes. */
function memoryStore(text: string | undefined): BundleStore & { readonly writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    read: async () => (writes.length > 0 ? writes.at(-1) : text),
    write: async (next) => {
      writes.push(next);
    },
  };
}

describe("the inputs of the file of the bundles", () => {
  it("adds the files of the root and the package files of each package of the workspace that has a module", () => {
    const inputs = inputFiles(["src/outage.ts", "../core/src/contracts.ts", "../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js"]);
    expect(inputs).toEqual(
      expect.arrayContaining([
        ...SOURCES,
        "src/outage.ts",
        "package.json",
        "tsconfig.json",
        "../core/package.json",
        "../core/tsconfig.json",
        "../../pnpm-lock.yaml",
        "../../pnpm-workspace.yaml",
        "../../package.json",
      ]),
    );
    // The lockfile pins each package of the store. Thus the package files in node_modules are not inputs.
    expect(inputs.filter((path) => path.includes("node_modules") && !path.endsWith("index.js"))).toEqual([]);
    expect([...inputs].sort()).toEqual(inputs);
  });

  it("gives a SHA-256 to each input file, and refuses a module that does not exist", async () => {
    const file = await goodFile();
    expect(file.inputs["../../pnpm-lock.yaml"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.values(file.inputs).filter((hash) => hash !== ABSENT && !/^[0-9a-f]{64}$/u.test(hash))).toEqual([]);
    await expect(bundleFileOf({ bundles: BUNDLES, inputs: [...SOURCES, "src/no-such-module.ts"] })).rejects.toThrow("src/no-such-module.ts");
  });

  it("gives a key that does not change from one call to the next", async () => {
    expect(await bundleKey()).toBe(await bundleKey());
    expect((await goodFile()).key).toBe(await bundleKey());
  });
});

describe("checkBundleFile", () => {
  it("passes a file of the code of this workspace, and gives its bundles", async () => {
    expect(await checkBundleFile(bundleFileText(await goodFile()))).toEqual({ ok: true, bundles: BUNDLES });
  });

  it("refuses a missing file, a text that is not JSON, and a file of another form", async () => {
    expect(await reasonOf(undefined)).toContain("does not exist");
    expect(await reasonOf("{")).toContain("not JSON");
    expect(await reasonOf(JSON.stringify({ ...(await goodFile()), format: 2 }))).toContain("format 1");
    expect(await reasonOf(JSON.stringify({ ...(await goodFile()), bundles: [{ path: OUTAGE_PATHS.entry }] }))).toContain("format 1");
  });

  it("refuses a file that does not have each Function one time", async () => {
    const file = await goodFile();
    expect(await reasonOf(bundleFileText({ ...file, bundles: BUNDLES.slice(0, 2) }))).toContain("each Function one time");
    expect(await reasonOf(bundleFileText({ ...file, bundles: [...BUNDLES, BUNDLES[0]!] }))).toContain("each Function one time");
  });

  it("refuses a file with no source of a Function or no lockfile in its inputs", async () => {
    const file = await goodFile();
    for (const path of [SOURCES[1]!, "../../pnpm-lock.yaml"]) {
      const inputs = Object.fromEntries(Object.entries(file.inputs).filter(([input]) => input !== path));
      expect(await reasonOf(bundleFileText({ ...file, inputs }))).toContain(path);
    }
  });

  it("refuses a file of another key: another runtime, dependency, source, module of the bundles or version of esbuild", async () => {
    const file = await goodFile();
    expect(await reasonOf(bundleFileText({ ...file, key: "0".repeat(64) }))).toContain("key of the bundles changed");
  });

  it("refuses a file after a change of an input file, and after its removal", async () => {
    const text = bundleFileText(await goodFile());
    expect((await checkBundleFile(text)).ok).toBe(true);
    await writeFile(extra, "export const a = 2;\n");
    expect(await reasonOf(text)).toContain("changed");
    await writeFile(extra, "export const a = 1;\n");
    expect((await checkBundleFile(text)).ok).toBe(true);
    await rm(extra);
    expect(await reasonOf(text)).toContain("changed");
  });

  it("refuses a file whose hash of an input is not the hash of the file now", async () => {
    const file = await goodFile();
    expect(await reasonOf(bundleFileText({ ...file, inputs: { ...file.inputs, "src/outage.ts": "0".repeat(64) } }))).toContain("src/outage.ts");
    expect(await reasonOf(bundleFileText({ ...file, inputs: { ...file.inputs, "src/outage.ts": ABSENT } }))).toContain("src/outage.ts");
  });
});

describe("outageBundles", () => {
  it("gives the bundles of a good file and makes no bundle", async () => {
    const store = memoryStore(bundleFileText(await goodFile()));
    const lines: string[] = [];
    const make = async (): Promise<BundleFile> => {
      throw new Error("The deploy made the bundles.");
    };
    expect(await outageBundles({ store, make, log: (line) => lines.push(line) })).toEqual(BUNDLES);
    expect(store.writes).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("makes the bundles for a missing or old file, writes the file, and the next deploy reads it", async () => {
    const good = await goodFile();
    for (const text of [undefined, bundleFileText({ ...good, key: "old" })]) {
      const store = memoryStore(text);
      const lines: string[] = [];
      let makes = 0;
      const make = async (): Promise<BundleFile> => {
        makes += 1;
        return good;
      };
      expect(await outageBundles({ store, make, log: (line) => lines.push(line) })).toEqual(BUNDLES);
      expect(store.writes).toEqual([bundleFileText(good)]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("makes the bundles with esbuild");
      expect(await outageBundles({ store, make })).toEqual(BUNDLES);
      expect(makes).toBe(1);
    }
  });

  it("makes the bundles at each deploy with no store, and writes nothing", async () => {
    let makes = 0;
    const make = async (): Promise<BundleFile> => {
      makes += 1;
      return goodFile();
    };
    await outageBundles({ make });
    await outageBundles({ make });
    expect(makes).toBe(2);
  });

  it("continues the deploy when the read or the write of the file fails, and stops it when the bundles fail", async () => {
    const good = await goodFile();
    const lines: string[] = [];
    const broken: BundleStore = {
      read: async () => {
        throw new Error("read refused");
      },
      write: async () => {
        throw new Error("write refused");
      },
    };
    expect(await outageBundles({ store: broken, make: async () => good, log: (line) => lines.push(line) })).toEqual(BUNDLES);
    expect(lines).toEqual([expect.stringContaining("read refused"), expect.stringContaining("write refused")]);
    await expect(
      outageBundles({
        store: memoryStore(undefined),
        make: async () => {
          throw new Error("esbuild failed");
        },
      }),
    ).rejects.toThrow("esbuild failed");
  });
});
