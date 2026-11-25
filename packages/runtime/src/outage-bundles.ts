/**
 * This file makes the bundles of the outage Functions and writes them to the file of the slot (AL-112).
 * The stage of a slot starts it after the install: `node src/outage-bundles.ts`.
 *
 * - The file is `packages/channel-twilio/build/outage-bundles.json`. Git does not keep the folder `build/`, thus the slot stays clean.
 * - A deploy of the runtime reads the file. When the file is good, the deploy starts no esbuild.
 * - After the write, this file checks the file as a deploy checks it. Thus the stage fails when a deploy cannot use the file.
 * - The exit code is 0 for a good file and 1 for a failure. The output holds counts only.
 */
import { bundleFileText, checkBundleFile, makeBundleFile, OUTAGE_BUNDLE_FILE } from "@mark1russell7/alerts-channel-twilio";
import { countOf, errorMessage } from "@mark1russell7/text";
import { createPrinter } from "@mark1russell7/text/print";
import { fileBundleStore } from "./outage.ts";

// The output of this command for a person goes through one printer, which removes the shapes of tokens (no raw console).
const print = createPrinter({ out: process.stdout, err: process.stderr });

let code = 0;
try {
  const store = fileBundleStore(OUTAGE_BUNDLE_FILE);
  const file = await makeBundleFile();
  await store.write(bundleFileText(file));
  const check = await checkBundleFile(await store.read());
  if (!check.ok) throw new Error(check.reason);
  print.line(`The file of the outage bundles has ${countOf(file.bundles.length, "bundle")} and ${countOf(Object.keys(file.inputs).length, "input file")}.`);
} catch (error) {
  print.error(`The outage bundles failed: ${errorMessage(error)}`);
  code = 1;
}
process.exitCode = code;
