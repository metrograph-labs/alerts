/**
 * This module makes the supervisor of the runtime. The boot task starts it through the entry, with
 * the folder of the private files: `node src/main.ts supervise <folder>`. The supervisor starts the
 * runtime and keeps it alive. At its own shutdown, it stops the runtime in stages, and the runtime
 * drains its pass.
 *
 * - `node src/main.ts supervise <folder>` starts the supervisor in a console. Ctrl-C stops it.
 * - `src/install.ts` installs the boot task that starts it.
 * - When the runtime stops again and again, the supervisor sends a notice to the receiver of the copy (`loop-notice.ts`).
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONLY_COPY } from "@mark1russell7/alerts";
import type { Clock } from "@mark1russell7/algebra/clock";
import type { Logger, ServiceBuilder } from "@mark1russell7/service";
import { discoveryOf, nodeHostPorts, removeDiscovery, superviseGroup, writeDiscovery } from "@mark1russell7/service/host";
import { writeFileAtomic } from "@procedures/fs/files";
import { parseSecrets, readText, SECRETS_FILE } from "./config.ts";
import { readCopySettings } from "./copy.ts";
import { declareSupervisor, hostFolder, hostGroup, hostReadyWindow, supervisorDiscovery, supervisorHome, supervisorLogger } from "./host.ts";
import { WEBHOOK_USER_AGENT } from "./instance.ts";
import { loopNotifier, loopReceiver, type LoopNotifier } from "./loop-notice.ts";
import { outputOf, timedLogger, type Output } from "./output.ts";
import { entryRoot } from "./slots.ts";
import { addMissedStart, hostFileText, readyWindowText, startTimesPath } from "./start-times.ts";

// The folder of the package. The runtime starts from the same checkout as the supervisor, through the path of the command
// line. Thus a live path that is a link to a slot gives each start the slot that the link names at that time (AL-89).
const ROOT = entryRoot(process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), ".."));

/**
 * This function adds one missed start to the file of the start times of the host. The runtime adds the good starts to
 * the same file. Each write replaces the file in one step, thus a reader gets the old file or the new file.
 */
async function recordMissed(home: string, windowMs: number): Promise<void> {
  const folder = hostFolder(home);
  const path = startTimesPath(folder);
  const text = await readFile(path, "utf8").catch(() => undefined);
  await mkdir(folder, { recursive: true });
  await writeFileAtomic(path, addMissedStart(text, new Date().toISOString(), windowMs));
}

/**
 * This function makes the notifier of the loops of the runtime from `secrets.env` and `copy.json` of the folder. A copy
 * with no receiver gets no notifier. A bad key writes one warning and gives no notifier, because a notice does not stop
 * the supervisor. The warning holds no value.
 */
async function notifierOf(home: string, clock: Clock, out: Output): Promise<LoopNotifier | undefined> {
  const file = await readText(() => readFile(join(home, SECRETS_FILE), "utf8"));
  if ("code" in file && file.code === "ENOENT") return undefined;
  const secrets = parseSecrets(file);
  const receiver = secrets.tag === "ok" ? loopReceiver((name) => secrets.value[name]) : secrets;
  if (receiver.tag === "err") {
    out.warn(`The supervisor sends no notice of a loop of the runtime: ${receiver.error.join(" ")}`);
    return undefined;
  }
  if (receiver.value === undefined) return undefined;
  const copy = await readCopySettings(home);
  if (copy.tag === "err") out.warn(`The notices of the supervisor use the copy id ${ONLY_COPY.id}: ${copy.error.join(" ")}`);
  return loopNotifier({ copy: copy.tag === "ok" ? copy.value.id : ONLY_COPY.id, receiver: receiver.value, fetch, userAgent: WEBHOOK_USER_AGENT, clock, wall: () => Date.now(), warn: (text) => out.warn(text) });
}

/**
 * This function makes the service of the supervisor for the folder of the private files. The service
 * starts the group, and its shutdown stops the group. The entry `main.ts` starts the service.
 */
export function supervisor(argument: string | undefined): ServiceBuilder {
  // A console argument can be `~/x` or `./x`. The runtime gets the resolved folder, thus its files are the files of the supervisor.
  const home = supervisorHome(argument, process.cwd());
  // The supervisor writes its log to its output. Each start that misses its ready window also goes to the file of the start
  // times, thus the next supervisor starts with a longer window (AL-99).
  // Each line starts with the time of the wall clock (AL-120).
  const timed = timedLogger();
  const out = outputOf(timed);
  const logger = supervisorLogger(timed, (windowMs) => {
    recordMissed(home, windowMs).catch((error: unknown) => out.warn(`The missed start was not written to the file of the start times: ${error instanceof Error ? error.message : String(error)}`));
  });
  // The notifier of the loops reads each line of the log of the group (AL-55). The start sets it.
  let notifier: LoopNotifier | undefined;
  const hooked: Logger = {
    log(level, message, fields) {
      logger.log(level, message, fields);
      try {
        notifier?.log(level, message, fields);
      } catch {
        // A notice is a hint for a service of the owner. The log already has the entry.
      }
    },
  };
  const ports = nodeHostPorts({ logger: hooked });
  // The ready window comes from the measured starts of this host. A new window takes effect at the next start of the supervisor.
  const window = hostReadyWindow(home, hostFileText);
  out.log(readyWindowText(window));
  const group = superviseGroup(hostGroup({ home, root: ROOT, node: process.execPath, readyWithin: { value: window.ms, unit: "ms" } }), ports);
  // The discovery file names this process. With it, the remove of the task stops the process tree.
  const discovery = supervisorDiscovery(home);
  return declareSupervisor({
    start: async () => {
      notifier = await notifierOf(home, ports.clock, out);
      await writeDiscovery(discovery, discoveryOf({}, ports), ports);
      group.start();
    },
    stop: async () => {
      await group.stop();
      notifier?.stop();
      await removeDiscovery(discovery, ports);
    },
  });
}
