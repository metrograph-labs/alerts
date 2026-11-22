/**
 * The file of the outage bundles (AL-112, step 2).
 *
 * The stage of a slot makes the bundles of the three Functions with esbuild, and it writes them to a file of the slot.
 * A deploy of the runtime reads the file. Thus the runtime does not start esbuild, a second process of approximately 160 MB.
 *
 * - The file holds the key of the build and the SHA-256 of each input file of the bundles.
 * - The inputs are each module of the bundles, the lockfile and the files of the workspace that tell how esbuild finds a module.
 * - Before a deploy uses the file, it reads each input file again and compares the hashes. Thus a bundle of old code does not go to Twilio.
 * - When the file is missing or old, `outageBundles` makes the bundles with esbuild, as before, and it writes the file again.
 *
 * This module does not import esbuild. `makeBundleFile` loads the module `bundle.ts` with a dynamic import.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, sha256Hex } from "@mark1russell7/rigor-generators";
import { errorMessage } from "@mark1russell7/text";
import { z } from "zod";
import { OUTAGE_PATHS } from "./outage.ts";

/**
 * The Node runtime of the Functions on the server of Twilio. Node 24 is the Active LTS runtime of
 * Twilio Functions, and Node 22 is in maintenance.
 */
export const FUNCTION_RUNTIME = "node24";

/**
 * The npm packages of the build, each with an exact version. Twilio refuses a range for the runtime
 * handler. On Node 24 the platform keeps the handler at 2.1.2 or later.
 */
export const FUNCTION_DEPENDENCIES: Readonly<Record<string, string>> = { "@twilio/runtime-handler": "2.1.2" };

/** The bundle of one Function. */
export interface FunctionBundle {
  /** The path of the Function on the domain of the service. */
  readonly path: (typeof OUTAGE_PATHS)[keyof typeof OUTAGE_PATHS];
  /** The entry is public, and it checks its own token. Twilio signs each request to a protected Function. */
  readonly visibility: "public" | "protected";
  /** The CommonJS code of the bundle. */
  readonly code: string;
}

/** The source of one Function: its path, its visibility, and its file relative to this module. */
export interface FunctionSource {
  readonly path: FunctionBundle["path"];
  readonly visibility: FunctionBundle["visibility"];
  readonly file: string;
}

/** The source file of each Function, by its path. */
export const FUNCTION_SOURCES: readonly FunctionSource[] = [
  { path: OUTAGE_PATHS.entry, visibility: "public", file: "./functions/outage.ts" },
  { path: OUTAGE_PATHS.press, visibility: "protected", file: "./functions/press.ts" },
  { path: OUTAGE_PATHS.ended, visibility: "protected", file: "./functions/ended.ts" },
];

/**
 * The folder of this package. esbuild writes the path of each module into the bundle, relative to its working folder.
 * This folder is fixed. Thus the start folder of the process does not change the code or the version of the plan.
 */
export const PACKAGE_ROOT: string = fileURLToPath(new URL("..", import.meta.url));

/** The root folder of the workspace. */
const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The file of the bundles in the folder of this package. Git does not keep the folder `build/`. */
export const OUTAGE_BUNDLE_FILE: string = fileURLToPath(new URL("../build/outage-bundles.json", import.meta.url));

/** The format of the file. A new form of the file raises it. Thus a file of the old form does not match. */
const FORMAT = 1;

/** The hash of an input file that does not exist. A file that comes later changes the hash. */
export const ABSENT = "absent";

/** The module that makes the bundles. Its text is a part of the key, thus a new option of esbuild makes a new key. */
const BUNDLE_MODULE = fileURLToPath(new URL("./bundle.ts", import.meta.url));

/**
 * The files of the root of the workspace that are inputs of each file. The lockfile pins each package of the store,
 * and an installed package does not change. Thus its hash also covers the files of the packages that esbuild reads.
 */
const ROOT_FILES = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"] as const;

/** The files of a package of the workspace that tell esbuild how to find and read its modules. */
const PACKAGE_FILES = ["package.json", "tsconfig.json"] as const;

/** The result of a build: the bundles and the input files, each relative to the folder of this package. */
export interface BundleBuild {
  readonly bundles: readonly FunctionBundle[];
  readonly inputs: readonly string[];
}

/** The file of the bundles. */
export interface BundleFile {
  readonly format: number;
  /** The key of the build. It is a hash of the format, the runtime, the dependencies, the sources, the module of the bundles and the esbuild version. */
  readonly key: string;
  /** The SHA-256 of each input file, or `ABSENT`, by its path relative to the folder of this package. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly bundles: readonly FunctionBundle[];
}

/** The store of the file. `read` gives `undefined` when the file does not exist. */
export interface BundleStore {
  readonly read: () => Promise<string | undefined>;
  readonly write: (text: string) => Promise<void>;
}

/** The result of the check of a file: the bundles, or the reason that the file is not good. */
export type BundleFileCheck = { readonly ok: true; readonly bundles: readonly FunctionBundle[] } | { readonly ok: false; readonly reason: string };

const FILE_SCHEMA = z.object({
  format: z.number(),
  key: z.string(),
  inputs: z.record(z.string(), z.string()),
  bundles: z.array(z.object({ path: z.string(), visibility: z.enum(["public", "protected"]), code: z.string() })),
});

/** This function gives the path of a file relative to `from`, with `/` between the parts, as esbuild writes it. */
function slashPath(from: string, file: string): string {
  return relative(from, file).split(sep).join("/");
}

/** The paths that each file must have in its inputs: the source of each Function and the files of the root of the workspace. */
const REQUIRED_INPUTS = [
  ...FUNCTION_SOURCES.map((source) => slashPath(PACKAGE_ROOT, fileURLToPath(new URL(source.file, import.meta.url)))),
  ...ROOT_FILES.map((file) => slashPath(PACKAGE_ROOT, resolve(WORKSPACE_ROOT, file))),
];

/**
 * This function gives the SHA-256 of the text of a file, by its path relative to the folder of this package. It gives
 * `ABSENT` when the file does not exist.
 *
 * @throws Error when the read fails for another reason.
 */
async function inputHash(path: string): Promise<string> {
  try {
    return sha256Hex(await readFile(resolve(PACKAGE_ROOT, path), "utf8"));
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return ABSENT;
    throw error;
  }
}

/**
 * This function gives the input files of a build. They are its modules and the files of the root of the workspace.
 * They also include the `package.json` and `tsconfig.json` of each package of the workspace with a module of the build.
 */
export function inputFiles(modules: readonly string[]): readonly string[] {
  const files = new Set([...modules, ...REQUIRED_INPUTS]);
  for (const module of modules) {
    const parts = slashPath(WORKSPACE_ROOT, resolve(PACKAGE_ROOT, module)).split("/");
    if (parts[0] !== "packages" || parts.length < 3 || parts.includes("node_modules")) continue;
    for (const file of PACKAGE_FILES) files.add(slashPath(PACKAGE_ROOT, resolve(WORKSPACE_ROOT, "packages", parts[1] ?? "", file)));
  }
  return [...files].sort();
}

/** This function gives the key of the build of this code. A read of the package file of esbuild gives its version, and it does not start esbuild. */
export async function bundleKey(): Promise<string> {
  const esbuild = (JSON.parse(await readFile(createRequire(import.meta.url).resolve("esbuild/package.json"), "utf8")) as { readonly version?: unknown }).version;
  const module = sha256Hex(await readFile(BUNDLE_MODULE, "utf8"));
  return canonicalHash({ format: FORMAT, runtime: FUNCTION_RUNTIME, dependencies: FUNCTION_DEPENDENCIES, sources: FUNCTION_SOURCES, module, esbuild }, { form: "json" });
}

/**
 * This function gives the file of a build, with the hash of each input file.
 *
 * @throws Error when a module of the build does not exist, or when a read fails.
 */
export async function bundleFileOf(build: BundleBuild): Promise<BundleFile> {
  const inputs: Record<string, string> = {};
  for (const path of inputFiles(build.inputs)) inputs[path] = await inputHash(path);
  const absent = build.inputs.filter((path) => inputs[path] === ABSENT);
  if (absent.length > 0) throw new Error(`These modules of the bundles do not exist after the build: ${absent.join(", ")}.`);
  return { format: FORMAT, key: await bundleKey(), inputs, bundles: build.bundles };
}

/**
 * This function makes the bundles with esbuild and gives the file of them.
 *
 * @throws Error when the bundles fail, or when a read of an input file fails.
 */
export async function makeBundleFile(): Promise<BundleFile> {
  const { bundleBuild } = await import("./bundle.ts");
  return bundleFileOf(await bundleBuild());
}

/** This function gives the text of a file of the bundles. */
export function bundleFileText(file: BundleFile): string {
  return `${JSON.stringify(file)}\n`;
}

/**
 * This function checks the text of a file of the bundles against the files of this workspace. The file is good only
 * when its form, its key and the hash of each input file are the same. Also, it has each Function one time.
 */
export async function checkBundleFile(text: string | undefined): Promise<BundleFileCheck> {
  if (text === undefined) return { ok: false, reason: "The file of the bundles does not exist." };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The file of the bundles is not JSON." };
  }
  const parsed = FILE_SCHEMA.safeParse(json);
  if (!parsed.success || parsed.data.format !== FORMAT) return { ok: false, reason: `The file of the bundles does not have the form of format ${FORMAT}.` };
  const file = parsed.data;
  const paths = file.bundles.map((bundle) => bundle.path).sort();
  if (paths.join(" ") !== Object.values(OUTAGE_PATHS).sort().join(" ")) return { ok: false, reason: "The file of the bundles does not have each Function one time." };
  const missing = REQUIRED_INPUTS.filter((path) => !Object.hasOwn(file.inputs, path));
  if (missing.length > 0) return { ok: false, reason: `The inputs of the file of the bundles do not have ${missing.join(", ")}.` };
  if (file.key !== (await bundleKey())) return { ok: false, reason: "The key of the bundles changed: the runtime, the dependencies, the sources, the module of the bundles or the version of esbuild." };
  for (const [path, hash] of Object.entries(file.inputs)) {
    if ((await inputHash(path)) !== hash) return { ok: false, reason: `The input file ${path} of the bundles changed.` };
  }
  return { ok: true, bundles: file.bundles as readonly FunctionBundle[] };
}

/** The options of `outageBundles`. */
export interface OutageBundlesOptions {
  /** The store of the file. Without it, the function makes the bundles each time, and it writes no file. */
  readonly store?: BundleStore;
  /** This function gets a line when the file is not good, and when its write fails. */
  readonly log?: (line: string) => void;
  /** This function makes the file. The default makes the bundles with esbuild. */
  readonly make?: () => Promise<BundleFile>;
}

/**
 * This function gives the bundles of a deploy. A good file gives them with no esbuild. Else the function makes them,
 * writes the file for the next deploy, and gives them. A failed read or write of the file does not stop the deploy.
 *
 * @throws Error when the bundles fail.
 */
export async function outageBundles(options: OutageBundlesOptions = {}): Promise<readonly FunctionBundle[]> {
  const { store, log, make = makeBundleFile } = options;
  if (store !== undefined) {
    let check: BundleFileCheck;
    try {
      check = await checkBundleFile(await store.read());
    } catch (error) {
      check = { ok: false, reason: `The check of the file of the bundles failed: ${errorMessage(error)}` };
    }
    if (check.ok) return check.bundles;
    log?.(`${check.reason} Thus the deploy makes the bundles with esbuild.`);
  }
  const file = await make();
  if (store !== undefined) {
    try {
      await store.write(bundleFileText(file));
    } catch (error) {
      log?.(`The write of the file of the bundles failed: ${errorMessage(error)}`);
    }
  }
  return file.bundles;
}
