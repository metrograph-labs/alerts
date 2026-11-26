/**
 * This module gives the host of the live instance on one computer, as data. A boot task starts the
 * supervisor (`main.ts supervise`). The supervisor starts the runtime (`main.ts`). It starts the runtime
 * again after an exit, or after the liveness probe fails. The entry gives the paths and the ports.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { add, sum, valueIn, type Quantity } from "@mark1russell7/quantity";
import { daemon, service, type Profile, type ServiceBuilder } from "@mark1russell7/service";
import { nextReadyWindow, readyTimesPath, type AliveStall, type GroupSpec, type ReadyMeasure, type ReadySpec, type ReadyWindow, type ServiceSpec } from "@mark1russell7/service/host";
import { holdingPasses, READINESS, STARTUP_BUDGET, STOP_MESSAGE } from "./index.ts";
import { alertsHome, HOME_VARIABLE, readText, type FileText } from "./config.ts";
import { INSTANCE_TIMES } from "./instance.ts";

const ms = (value: number): Quantity => ({ value, unit: "ms" });
const s = (value: number): Quantity => ({ value, unit: "s" });

/** The name of the boot task, of the group of the supervisor and of its folder. */
export const HOST_NAME = "alerts";

/** The node flag that closes the inspector to `SIGUSR1`. Node 22.14 and later know it. */
export const NO_SIGUSR1 = "--disable-sigusr1";

/**
 * This function gives the node flags of the supervisor and the runtime. The runtime holds the keys of the send services,
 * so a signal must not open its inspector. A node that does not know the flag gets no flag, because an unknown flag stops the start.
 */
export const nodeFlags = (known: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): string[] => (known.has(NO_SIGUSR1) ? [NO_SIGUSR1] : []);

/**
 * This function gives the warning of a process with an open inspector signal, or null. The entry writes it at each start,
 * thus a node without the flag shows the gap.
 */
export const signalWarning = (execArgv: readonly string[] = process.execArgv, version: string = process.version): string | null =>
  execArgv.includes(NO_SIGUSR1) ? null : `The inspector signal is not disabled: node ${version}.`;

/** The state of the inspector signal of a live process: closed by the flag, open, or no read. */
export type SignalState = "closed" | "open" | "no read";

/**
 * This function gives the state of the inspector signal from the text of `/proc/<pid>/cmdline`. Only the node flags before
 * the script count. No text, or a process that does not start `main.ts`, gives "no read".
 */
export function signalState(cmdline: string | null): SignalState {
  if (cmdline === null || cmdline === "") return "no read";
  const args = cmdline.split("\0").slice(1);
  const script = args.findIndex((arg) => !arg.startsWith("-"));
  if (script < 0 || !args[script]!.endsWith("main.ts")) return "no read";
  return args.slice(0, script).includes(NO_SIGUSR1) ? "closed" : "open";
}

/** The states of the inspector signal of the supervisor and the runtime. */
export interface SignalStates {
  readonly supervisor: SignalState;
  readonly runtime: SignalState;
}

/**
 * This function reads the states of the inspector signal of the supervisor and the runtime. It reads their discovery files,
 * then `/proc`. A missing file, a process that stopped or a host with no `/proc` gives "no read".
 */
export async function readSignals(home: string, read: (path: string) => Promise<FileText> = (path) => readText(() => readFile(path, "utf8"))): Promise<SignalStates> {
  const state = async (discovery: string): Promise<SignalState> => {
    const pid = discoveryPid(await read(discovery));
    if (pid === undefined) return "no read";
    const cmdline = await read(`/proc/${String(pid)}/cmdline`);
    return signalState("code" in cmdline ? null : cmdline.text);
  };
  return { supervisor: await state(supervisorDiscovery(home)), runtime: await state(runtimeDiscovery(home)) };
}

/** This function gives the line of the check for the states of the inspector signal. */
export const signalText = (states: SignalStates): string => `The inspector signal: the supervisor ${states.supervisor}, the runtime ${states.runtime}.`;

/** The ports of the live instance. They are below the dynamic ports of Windows, and away from the usual ports of servers in development. */
export const HOST_PORTS: { readonly port: number; readonly probePort: number } = { port: 4750, probePort: 4751 };

/** The supervisor waits this time for the first ready probe of the runtime: its startup budget and one readiness interval. */
export const READY_WITHIN: Quantity = add(STARTUP_BUDGET, READINESS.interval);

/**
 * The longest answer time of each probe of the runtime. The readiness probe and the liveness probe use the same time. Thus the
 * supervisor does not stop a start as not ready when the liveness probe accepts the same answer as alive (AL-159).
 */
export const PROBE_TIMEOUT: Quantity = s(2);

/** The ready window of each start before the host has measured starts. A start on a slow host fits in it. */
export const FIRST_READY_WINDOW: Quantity = s(120);

/**
 * The measure of the ready window (AL-84). The supervisor measures each start from its spawn to the first pass of `/readiness`.
 * - After 5 ready starts, the window is the worst of the last 20 times, plus the worst minus the best.
 * - The window is not shorter than `READY_WITHIN` and not longer than 10 min.
 * - A start that misses its window makes the next window at least two times longer. Thus a slow host gets a start through.
 */
export const READY_MEASURE: ReadyMeasure = { after: 5, keep: 20, floor: READY_WITHIN, cap: s(600) };

/**
 * This function gives the ready spec of the runtime: the readiness probe and the measured window. The cap of the window is not
 * shorter than `within`, because the runner refuses a cap shorter than `within`.
 */
export function runtimeReady(probePort: number = HOST_PORTS.probePort, within: Quantity = FIRST_READY_WINDOW): ReadySpec {
  const cap = ms(Math.max(valueIn(READY_MEASURE.cap, "ms"), valueIn(within, "ms")));
  return { probe: readinessProbe(probePort), interval: ms(500), timeout: PROBE_TIMEOUT, within, measured: { ...READY_MEASURE, cap } };
}

/** This function gives the readiness probe of the runtime on its probe port. The supervisor and the install use it. */
export const readinessProbe = (probePort: number = HOST_PORTS.probePort): { readonly kind: "http"; readonly url: string } => ({ kind: "http", url: `http://127.0.0.1:${probePort}/readiness` });

/** The options of the host. */
export interface HostOptions {
  /** The folder of the private files: `config.json`, `secrets.env` and the log. The host keeps its own files in the subfolder `host`. */
  readonly home: string;
  /** The folder of the package `runtime` in a checkout. */
  readonly root: string;
  /** The path of Node. */
  readonly node: string;
  readonly port?: number | undefined;
  readonly probePort?: number | undefined;
  /** The ready window of the first starts of the runtime, before the measured starts. The default is `FIRST_READY_WINDOW`. */
  readonly readyWithin?: Quantity | undefined;
}

/** The shutdown profile of the runtime under the supervisor: `daemon`, with a drain that holds the pass in flight. */
export const RUNTIME_PROFILE: Profile = holdingPasses(daemon, INSTANCE_TIMES.passLimit);

/** This function gives the longest shutdown of a profile: the sum of the caps of its phases. */
export const shutdownCap = (profile: Profile): Quantity =>
  sum(
    (profile.phases ?? []).map((phase) => phase.cap),
    "ms",
  );

/**
 * The stop grace of the runtime: its longest shutdown, plus 2 s for the exit of the process. After the
 * grace, the supervisor stops the process tree. Thus a stop does not cut a pass.
 */
export const RUNTIME_GRACE: Quantity = add(shutdownCap(RUNTIME_PROFILE), s(2));

/**
 * This function gives the folder of the private files from the argument of the supervisor. It resolves
 * the argument as the runtime resolves `ALERTS_HOME`: `~` is the home folder, and a relative path is
 * relative to `base`. Thus the supervisor and the runtime use the same folder. An empty argument is an error.
 */
export function supervisorHome(argument: string | undefined, base: string, home: string = homedir()): string {
  if (argument === undefined || argument === "") throw new Error("The supervisor needs one argument: the folder of the private files.");
  return alertsHome({ [HOME_VARIABLE]: argument }, base, home);
}

/** The folder of the files of the host: the task file, the lock, the discovery file and the logs. */
export const hostFolder = (home: string): string => join(home, "host");

/** The discovery file of the supervisor. Each program of the group has its own file in the same folder, by its name. */
export const supervisorDiscovery = (home: string): string => join(hostFolder(home), "supervisor.json");

/** The name of the runtime in the group of the supervisor. */
export const RUNTIME_PROGRAM = "runtime";

/** The discovery file of the runtime. The supervisor writes the process ID of each start of the runtime into it. */
export const runtimeDiscovery = (home: string): string => join(hostFolder(home), `${RUNTIME_PROGRAM}.json`);

/** This function gives the text of a file of the host, or `undefined` when the file cannot be read. */
export function hostFileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * This function gives the window of the next start of the runtime, from the measured starts of the host (AL-84). The supervisor
 * keeps them in the file `host/runtime.ready.json`. The function `read` gives the text of a file, or `undefined` when the file is missing.
 */
export function hostReadyWindow(home: string, read: (path: string) => string | undefined, platform: string = process.platform): ReadyWindow {
  return nextReadyWindow(runtimeReady(), read(readyTimesPath(platform, hostFolder(home), RUNTIME_PROGRAM)) ?? null);
}

/** This function gives the process ID in the text of a discovery file, or `undefined` when the text has no process ID. */
export function discoveryPid(text: FileText): number | undefined {
  if ("code" in text) return undefined;
  try {
    const record: unknown = JSON.parse(text.text);
    const pid = typeof record === "object" && record !== null && "pid" in record ? record.pid : undefined;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stall excuse of the liveness probe (AL-180). On a small Linux host, a swap-in or an IO wait stops each task for many
 * seconds. The runtime then does not answer, but it does not hang. A failure counts only when the host was in a full stall
 * for less than half of its span. At most 6 failures in sequence are excused, approximately 1 min. Then each failure counts.
 */
export const LIVENESS_STALL: AliveStall = { share: 0.5, most: 6 };

/**
 * This function gives the group of the supervisor: one program, the runtime.
 *
 * - The runtime is ready when `/readiness` passes in the ready window. The window comes from the measured starts of the host
 *   (`READY_MEASURE`, AL-84), and the first starts get `options.readyWithin`, or else `FIRST_READY_WINDOW`.
 * - A start that is not ready in its window makes the next window at least two times longer. Thus a slow host does not stop each
 *   start at the same time.
 * - A ready runtime that fails `/liveness` 3 times in sequence, 10 s apart, stops. Then the supervisor
 *   starts it again. One slow answer does not stop it.
 * - A failure in a full stall of the host does not count, up to `LIVENESS_STALL.most` in sequence (AL-180).
 * - The stop goes on the IPC channel, because a Windows process cannot catch a signal of its parent.
 * - The runtime starts with `nodeFlags()`. Thus a `SIGUSR1` does not open the inspector of a process that holds the keys.
 */
export function hostGroup(options: HostOptions): GroupSpec {
  const port = options.port ?? HOST_PORTS.port;
  const probePort = options.probePort ?? HOST_PORTS.probePort;
  const probes = `http://127.0.0.1:${probePort}`;
  return {
    name: HOST_NAME,
    stateDir: hostFolder(options.home),
    programs: [
      {
        name: RUNTIME_PROGRAM,
        program: options.node,
        args: [...nodeFlags(), "src/main.ts"],
        cwd: options.root,
        env: { ALERTS_HOME: options.home, PORT: String(port), PROBE_PORT: String(probePort), SERVICE_PROFILE: "daemon" },
        ipc: true,
        ready: runtimeReady(probePort, options.readyWithin),
        alive: { probe: { kind: "http", url: `${probes}/liveness` }, interval: s(10), timeout: PROBE_TIMEOUT, failures: 3, stall: LIVENESS_STALL },
        stop: { grace: RUNTIME_GRACE, message: STOP_MESSAGE },
        listen: { port, url: `http://127.0.0.1:${port}/` },
      },
    ],
  };
}

/**
 * This function gives the boot task. It starts the supervisor at the start of the computer, before a
 * logon, and again 1 minute after it stops. The task gets the folder of the private files as its argument.
 *
 * On Linux, only the supervisor gets the stop signal of systemd. The supervisor stops the runtime in stages.
 * After `SUPERVISOR_GRACE`, systemd stops each process of the unit with `SIGKILL`. On Windows, these two fields change nothing.
 */
export function hostTask(options: HostOptions): ServiceSpec {
  return {
    name: HOST_NAME,
    description: "The alerts runtime: a supervisor that keeps the runtime alive.",
    program: options.node,
    args: [...nodeFlags(), join(options.root, "src", "main.ts"), "supervise", options.home],
    cwd: options.root,
    start: "boot",
    restart: { after: { value: 1, unit: "min" } },
    background: true,
    stateDir: hostFolder(options.home),
    stopsChildren: true,
    stopGrace: SUPERVISOR_GRACE,
  };
}

/** The shutdown profile of the supervisor. The phase `tear down dependencies` holds the staged stop of the runtime. */
export const SUPERVISOR_PROFILE: Profile = {
  ...daemon,
  phases: daemon.phases?.map((phase) => (phase.name === "tear down dependencies" ? { ...phase, cap: add(phase.cap, RUNTIME_GRACE) } : phase)),
};

/**
 * The stop grace of the supervisor: its longest shutdown, plus 2 s for the exit of the process. The longest
 * shutdown holds the stop grace of the runtime. Thus a stop of systemd does not cut a pass.
 */
export const SUPERVISOR_GRACE: Quantity = add(shutdownCap(SUPERVISOR_PROFILE), s(2));

/** The group of the supervisor, as its service sees it. The entry adds the discovery file to the start and the stop of the group. */
export interface HostedGroup {
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

/**
 * This function tells if the supervisor watches the console that started it (AL-141). On Windows, the boot task starts
 * the supervisor in a headless console (`conhost.exe`), and a stop of the task ends only the console. Then the input of
 * the supervisor closes. A Linux unit gives an input that is not a console, thus systemd stops the supervisor itself.
 */
export const watchesConsole = (platform: NodeJS.Platform, inputIsConsole: boolean | undefined): boolean =>
  platform === "win32" && inputIsConsole === true;

/**
 * This function declares the service of the supervisor. The group is its one dependency: the start
 * connects it, and the shutdown stops each program in stages. Only the entry `main.ts` uses `run()`.
 * When `consoleWatch` is true, the end of the input also starts the shutdown (`watchesConsole`).
 */
export const declareSupervisor = (group: HostedGroup, consoleWatch = false): ServiceBuilder => {
  const builder = service(`${HOST_NAME}-host`)
    .dependency("group", { system: null, knobs: {}, operations: {} }, { connect: () => group.start(), close: () => group.stop() })
    .readiness(READINESS)
    .liveness({ type: "window", failAfter: s(45) })
    .startup(STARTUP_BUDGET)
    .profile(SUPERVISOR_PROFILE);
  return consoleWatch ? builder.trigger("stdin-close") : builder;
};
