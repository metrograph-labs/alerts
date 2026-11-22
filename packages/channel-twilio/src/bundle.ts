/**
 * The bundles of the three outage Functions. esbuild makes one CommonJS file for each Function, with
 * each module that it imports. The Functions runtime of Twilio gives only the Node built-ins and the
 * helper library of Twilio, so a bundle imports nothing else.
 *
 * The module `index.ts` does not export this module. `makeBundleFile` of `bundle-file.ts` loads it with a
 * dynamic import. Thus the runtime of the instance loads esbuild only when the file of the bundles is missing or old.
 * The text of this module is a part of the key of the file. Thus a change of an option of esbuild makes the file old.
 */

import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { FUNCTION_RUNTIME, FUNCTION_SOURCES, PACKAGE_ROOT, type BundleBuild, type FunctionBundle } from "./bundle-file.ts";

/**
 * This pattern finds the folder of a package in the store of pnpm, in a module path of a bundle. The tool pnpm names this
 * folder from the package, its version and its peers. It shortens a long name with a hash, and the longest name is shorter on Windows.
 * Thus the same commit gives different module paths on two hosts.
 */
const STORE_FOLDER = /node_modules\/\.pnpm\/[^/"'`\s]+\/node_modules\//gu;

/**
 * This function removes the folders of the store of pnpm from the module paths of a bundle. Each module path then names
 * only the package and its file. Thus each host gives the same code and the same version of the plan for one commit.
 *
 * esbuild writes a module path only in a comment and in the key of a module wrapper. Thus the change keeps the behavior of the code.
 */
export function withoutStoreFolders(code: string): string {
  return code.replace(STORE_FOLDER, () => "node_modules/");
}

/**
 * This function makes the bundle of each Function. The same sources, the same packages and the same esbuild give the
 * same code from each start folder and on each host.
 *
 * After the bundles, the function stops the service of esbuild. The service is a child process that keeps approximately
 * 160 MB until its stop, and a deploy comes once a day. The next bundle starts a new service.
 */
export async function bundleFunctions(): Promise<FunctionBundle[]> {
  return [...(await bundleBuild()).bundles];
}

/**
 * This function makes the bundle of each Function, as `bundleFunctions` does. It also gives the module files that esbuild
 * read, each relative to the folder of this package, with `/` between the parts.
 */
export async function bundleBuild(): Promise<BundleBuild> {
  try {
    const each = await bundleEach();
    const inputs = new Set(each.flatMap((result) => result.inputs));
    return { bundles: each.map((result) => result.bundle), inputs: [...inputs].sort() };
  } finally {
    await stop();
  }
}

function bundleEach(): Promise<{ readonly bundle: FunctionBundle; readonly inputs: readonly string[] }[]> {
  return Promise.all(
    FUNCTION_SOURCES.map(async (source) => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(source.file, import.meta.url))],
        absWorkingDir: PACKAGE_ROOT,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: FUNCTION_RUNTIME,
        write: false,
        sourcemap: false,
        legalComments: "none",
        charset: "utf8",
        logLevel: "silent",
        metafile: true,
      });
      const [file] = result.outputFiles;
      if (file === undefined || result.outputFiles.length !== 1) throw new Error(`The bundle of ${source.path} is not one file.`);
      const bundle = { path: source.path, visibility: source.visibility, code: withoutStoreFolders(file.text) };
      return { bundle, inputs: Object.keys(result.metafile.inputs) };
    }),
  );
}
