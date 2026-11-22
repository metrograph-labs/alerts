/**
 * This module makes the supervisor of the runtime. The boot task starts it through the entry, with
 * the folder of the private files: `node src/main.ts supervise <folder>`. The supervisor starts the
 * runtime and keeps it alive. At its own shutdown, it stops the runtime in stages, and the runtime
 * drains its pass.
 *
 * - `node src/main.ts supervise <folder>` starts the supervisor in a console. Ctrl-C stops it.
 * - `src/install.ts` installs the boot task that starts it.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceBuilder } from "@mark1russell7/service";
import { discoveryOf, nodeHostPorts, removeDiscovery, superviseGroup, writeDiscovery } from "@mark1russell7/service/host";
import { writeFileAtomic } from "@procedures/fs/files";
import { declareSupervisor, hostFolder, hostGroup, hostReadyWindow, supervisorDiscovery, supervisorHome, supervisorLogger } from "./host.ts";
import { outputOf, timedLogger } from "./output.ts";
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
  const ports = nodeHostPorts({ logger });
  // The ready window comes from the measured starts of this host. A new window takes effect at the next start of the supervisor.
  const window = hostReadyWindow(home, hostFileText);
  out.log(readyWindowText(window));
  const group = superviseGroup(hostGroup({ home, root: ROOT, node: process.execPath, readyWithin: { value: window.ms, unit: "ms" } }), ports);
  // The discovery file names this process. With it, the remove of the task stops the process tree.
  const discovery = supervisorDiscovery(home);
  return declareSupervisor({
    start: async () => {
      await writeDiscovery(discovery, discoveryOf({}, ports), ports);
      group.start();
    },
    stop: async () => {
      await group.stop();
      await removeDiscovery(discovery, ports);
    },
  });
}
