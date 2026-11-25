/**
 * This file gives one message of the operator to the intake of the runtime on this computer (AL-92, `tell-intake.ts`).
 * The runtime routes the message as a private report. Thus the merge, the send limit, the quiet window and the quota gate apply to it.
 *
 * - `node src/tell.ts --class <class> --item <item> --message <text> [--title <title>] [--url <link>] [--to <person>]... [--urgent]`
 * - The classes are `needs-you`, `done-you-asked` and `live`. Only a message `needs-you` can be urgent.
 * - With no `--to`, the message goes to the operator: the one person who watches each source.
 * - The runtime changes a link of the local site, or a path that starts with `/`, to its phone form.
 * - The runtime refuses each other link on the loopback address.
 * - The command reads the port from the entry `tell` of `config.json`, and the token from the file `tell.token`. It reads no secret.
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The output holds no person and no token.
 * The exit code is 0 when the runtime took the message, 1 for a refusal or a failed call, and 2 for a wrong command.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { tellConfigSchema } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { createPrinter } from "@mark1russell7/text/print";
import { alertsHome, configPath, readText } from "./config.ts";
import { readTellToken, TELL_CALL_LIMIT, TELL_TOKEN_FILE, tellCall } from "./tell-intake.ts";
import { tellEventSchema, type TellEvent } from "./tell-message.ts";

// The output of this command for a person goes through one printer, which removes the shapes of tokens (no raw console).
const print = createPrinter({ out: process.stdout, err: process.stderr });

const USAGE =
  "The command is: node src/tell.ts --class <needs-you|done-you-asked|live> --item <item> --message <text> [--title <title>] [--url <link>] [--to <person>]... [--urgent]";

/** This function gives the message of the command, or the problem of the command. */
function command(args: readonly string[]): { readonly event: TellEvent } | { readonly problem: string } {
  let values: { class?: string; item?: string; message?: string; title?: string; url?: string; to?: string[]; urgent?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        class: { type: "string" },
        item: { type: "string" },
        message: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        to: { type: "string", multiple: true },
        urgent: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { problem: errorMessage(error) };
  }
  const parsed = tellEventSchema.safeParse({
    class: values.class,
    item: values.item,
    text: values.message,
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.url === undefined ? {} : { url: values.url }),
    ...(values.to === undefined ? {} : { to: values.to }),
    ...(values.urgent === true ? { urgent: true } : {}),
  });
  // A problem names the field, not its value.
  if (!parsed.success) return { problem: parsed.error.issues.map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`).join(" ") };
  return { event: parsed.data };
}

/** This function reads the port and the token of the intake, gives the message to the runtime, and gives the exit code. */
async function tell(event: TellEvent): Promise<number> {
  const file = await readText(() => readFile(configPath(process.env, process.cwd()), "utf8"));
  if (!("text" in file)) {
    print.error(`The file config.json cannot be read (${file.code}).`);
    return 1;
  }
  let entry: unknown;
  try {
    entry = (JSON.parse(file.text) as { tell?: unknown }).tell;
  } catch {
    print.error("The file config.json is not JSON. Start `node src/check.ts` to see the problem.");
    return 1;
  }
  if (entry === undefined) {
    print.error("The file config.json has no entry tell. Thus the runtime has no intake.");
    return 1;
  }
  const config = tellConfigSchema.safeParse(entry);
  if (!config.success) {
    print.error("The entry tell of config.json has a problem. Start `node src/check.ts` to see it.");
    return 1;
  }
  const token = await readTellToken(alertsHome(process.env, process.cwd()));
  if (token === undefined) {
    print.error(`The file ${TELL_TOKEN_FILE} is absent. The runtime makes it at its first start with the entry tell.`);
    return 1;
  }
  const call = tellCall({ port: config.data.port, token });
  const receipt = (await call(event, AbortSignal.timeout(TELL_CALL_LIMIT + 1_000))) as { persons?: number; link?: string };
  const persons = receipt.persons === 1 ? "1 person" : `${String(receipt.persons ?? 0)} people`;
  print.line(`The runtime took the message for ${persons}${receipt.link === "phone" ? ", with the phone form of the link" : ""}.`);
  return 0;
}

const parsed = command(process.argv.slice(2));
if ("problem" in parsed) {
  print.error(`${parsed.problem}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await tell(parsed.event);
  } catch (error) {
    // The intake gives the reason of a refusal. The message holds no person and no token.
    print.error(`The runtime did not take the message: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
