/**
 * This file checks a configuration file before the file replaces `config.json`, or a part before the part replaces
 * its file in the folder `parts`. A bad file stops the next start of the runtime. Thus a writer writes a new file
 * and starts this check. It renames the file only when the check passes.
 *
 * - `node src/check.ts <file>` checks the file. Without a file, it checks `config.json` in the private folder.
 * - `node src/check.ts --part <name> <file>` checks `config.json` and the parts, with the file in place of the part `<name>`.
 * - A writer of a part writes its new file outside the folder `parts`, then renames it to `parts/<name>.json`.
 * - The check uses the keys of `secrets.env`, the settings of the copy `copy.json` and the check of the live instance, the profile `daemon`.
 * - It finds each problem that stops the start: the form of a key, a missing key and a place that no regional source covers.
 * - The exit code is 0 for a valid file, 1 for a file with problems and 2 for a wrong command.
 * - It also tells if the inspector signal of the live supervisor and runtime is closed. This line does not change the exit code.
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The output holds no value of the file, no
 * value of a key and no path.
 */
import { resolve } from "node:path";
import { PART_NAME } from "@mark1russell7/alerts";
import { countOf } from "@mark1russell7/text";
import { createPrinter } from "@mark1russell7/text/print";
import { alertsHome, checkConfig, configPath, fileSource, type PartSource } from "./config.ts";
import { readCopySettings } from "./copy.ts";
import { readSignals, signalText } from "./host.ts";
import { daemonCheck } from "./instance.ts";

// The output of this command for a person goes through one printer, which removes the shapes of tokens (no raw console).
const print = createPrinter({ out: process.stdout, err: process.stderr });

const USAGE = "The command is: node src/check.ts [file], or node src/check.ts --part <name> <file>";

// The file of the configuration and the new part, or undefined for a wrong command.
function command(args: readonly string[]): { readonly file: string | undefined; readonly part: { readonly name: string; readonly file: string } | undefined } | undefined {
  if (args[0] === "--part") {
    const [, name, file] = args;
    return args.length === 3 && name !== undefined && PART_NAME.test(name) && file !== undefined && !file.startsWith("-") ? { file: undefined, part: { name, file } } : undefined;
  }
  return args.length > 1 || args[0]?.startsWith("-") === true ? undefined : { file: args[0], part: undefined };
}

const parsed = command(process.argv.slice(2));

if (parsed === undefined) {
  print.error(`${USAGE}. The name of a part has small letters, digits and hyphens, with a letter first.`);
  process.exitCode = 2;
} else {
  const path = parsed.file === undefined ? configPath(process.env, process.cwd()) : resolve(parsed.file);
  const home = alertsHome(process.env, process.cwd());
  const part: PartSource | undefined = parsed.part === undefined ? undefined : { name: parsed.part.name, source: fileSource(resolve(parsed.part.file)) };
  const copy = await readCopySettings(home);
  const result = copy.tag === "err" ? copy : await checkConfig(fileSource(path), home, daemonCheck(copy.value), part);
  if (result.tag === "ok") {
    const { places, people, contacts, policies } = result.value.config;
    const counts = [countOf(places.length, "place"), countOf(people.length, "person", "people"), countOf(contacts.length, "contact"), countOf(policies.length, "policy", "policies")];
    print.line(`The configuration is valid${part === undefined ? "" : ` with the new part ${part.name}`}: ${counts.join(", ")}.`);
  } else {
    print.error(`The configuration has ${countOf(result.error.length, "problem")}:\n- ${result.error.join("\n- ")}`);
    process.exitCode = 1;
  }
  print.line(signalText(await readSignals(home)));
}
