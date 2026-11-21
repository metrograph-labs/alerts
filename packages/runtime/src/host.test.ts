import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import { groupProblems, renderSystemdUnit, renderTaskXml, serviceProblems, superviseGroup } from "@mark1russell7/service/host";
import { fakeHost } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { addMissedStart, addStartTime, BOOTSTRAP_WINDOW_MS, parseStartTimes, READY_GROWTH_FACTOR, startTimesPath, WINDOW_CAP_MS } from "./start-times.ts";
import {
  declareSupervisor,
  discoveryPid,
  HOST_PORTS,
  hostFolder,
  hostGroup,
  hostReadyWindow,
  hostTask,
  nodeFlags,
  NO_SIGUSR1,
  readSignals,
  signalState,
  signalText,
  signalWarning,
  READY_WITHIN,
  readinessProbe,
  RUNTIME_GRACE,
  RUNTIME_PROFILE,
  RUNTIME_PROGRAM,
  runtimeDiscovery,
  shutdownCap,
  SUPERVISOR_GRACE,
  SUPERVISOR_PROFILE,
  supervisorDiscovery,
  supervisorHome,
  supervisorLogger,
  missedWindow,
} from "./host.ts";
import { STOP_MESSAGE } from "./index.ts";
import { INSTANCE_TIMES } from "./instance.ts";

// A folder of the private files with no user name in it.
const HOME = join("/var/lib", "alerts");
const ROOT = join("/srv/alerts", "packages", "runtime");
const NODE = "/usr/bin/node";
const OPTIONS = { home: HOME, root: ROOT, node: NODE };
const PROBES = `http://127.0.0.1:${HOST_PORTS.probePort}`;

const msOf = (amount: { value: number; unit: string }): number => valueIn(amount, "ms");
const capOf = (phases: readonly { name: string; cap: { value: number; unit: string } }[], name: string): number => msOf(phases.find((phase) => phase.name === name)!.cap);

/** This function starts the group on a fake host whose runtime answers each probe. */
async function started() {
  const host = fakeHost({ platform: "win32" });
  // A polite child ends at a staged stop, as the runtime does after its drain.
  host.polite = true;
  host.http.set(`${PROBES}/readiness`, 200);
  host.http.set(`${PROBES}/liveness`, 200);
  const group = superviseGroup(hostGroup(OPTIONS), host.ports, { random: () => 0 });
  group.start();
  await host.settle();
  await host.clock.advance(1000);
  await host.settle();
  return { host, group };
}

/** This function moves the fake clock in steps of one second. */
async function pass(host: Awaited<ReturnType<typeof started>>["host"], seconds: number): Promise<void> {
  for (let step = 0; step < seconds; step++) {
    await host.clock.advance(1000);
    await host.settle();
  }
}

/** This helper starts a node with the flags, sends it `SIGUSR1` and gives its error output. Port 0 gives a free inspector port. */
const afterSigusr1 = (flags: readonly string[]): Promise<string> =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [...flags, "--inspect-port=0", "-e", "process.stdout.write('up'); setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    const end = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.stderr.on("data", (chunk: Buffer) => {
      errors += String(chunk);
      if (errors.includes("Debugger listening")) child.kill("SIGKILL");
    });
    child.stdout.once("data", () => child.kill("SIGUSR1"));
    child.on("error", fail);
    child.on("close", () => {
      clearTimeout(end);
      done(errors);
    });
  });

describe("the host of the instance", () => {
  it("resolves the folder argument of the supervisor as the runtime resolves ALERTS_HOME", () => {
    const user = join("/home", "owner");
    const base = join("/srv", "console");
    // The folder is absolute. On Windows, it starts with the drive of the base.
    expect(supervisorHome("~/private", base, user)).toBe(resolve(user, "private"));
    expect(supervisorHome("./private", base, user)).toBe(resolve(base, "private"));
    expect(supervisorHome(HOME, base, user)).toBe(resolve(HOME));
    expect(() => supervisorHome("", base, user)).toThrow("The supervisor needs one argument: the folder of the private files.");
    expect(() => supervisorHome(undefined, base, user)).toThrow("The supervisor needs one argument: the folder of the private files.");
  });

  it("gives the install the readiness probe and the ready wait of the supervisor", () => {
    const ready = hostGroup(OPTIONS).programs[0]?.ready;
    expect(readinessProbe()).toEqual({ kind: "http", url: `${PROBES}/readiness` });
    expect(ready?.probe).toEqual(readinessProbe());
    expect(ready?.within).toEqual(READY_WITHIN);
    expect(ready?.grow?.factor).toBe(READY_GROWTH_FACTOR);
  });

  it("gives the supervisor the ready window of the measured starts of its host", () => {
    expect(hostGroup({ ...OPTIONS, readyWithin: { value: 90_000, unit: "ms" } }).programs[0]?.ready?.within).toEqual({ value: 90_000, unit: "ms" });
    const starts = [40_000, 44_000, 52_000, 41_000, 47_000].map((ms, index) => ({ at: `2026-11-18T21:0${String(index)}:00.000Z`, ms }));
    const text = starts.reduce<string | undefined>((file, start) => addStartTime(file, start), undefined);
    const read = (path: string) => (path === startTimesPath(hostFolder(HOME)) ? text : undefined);
    // The worst start is 52 s, and the spread is 12 s.
    expect(hostReadyWindow(HOME, read)).toEqual({ ms: 64_000, starts: 5, measured: true, missed: 0 });
    expect(hostReadyWindow(join(HOME, "other"), read)).toEqual({ ms: BOOTSTRAP_WINDOW_MS, starts: 0, measured: false, missed: 0 });
  });

  it("gives the runtime a ready window that grows after each missed start, to the cap", () => {
    expect(hostGroup(OPTIONS).programs[0]?.ready?.grow).toEqual({ factor: READY_GROWTH_FACTOR, cap: { value: WINDOW_CAP_MS, unit: "ms" } });
    // A window longer than the cap keeps a cap of the window, because the runner refuses a cap shorter than the window.
    const long = hostGroup({ ...OPTIONS, readyWithin: { value: WINDOW_CAP_MS + 1, unit: "ms" } });
    expect(long.programs[0]?.ready?.grow?.cap).toEqual({ value: WINDOW_CAP_MS + 1, unit: "ms" });
    expect(groupProblems(long)).toEqual([]);
  });

  it("records each start that the supervisor stops at its ready window, with the window of the try", async () => {
    // The runtime never answers its readiness probe. The supervisor stops each start at its window.
    const misses: number[] = [];
    const entries: string[] = [];
    const logger = supervisorLogger({ log: (_level, message) => entries.push(message) }, (windowMs) => misses.push(windowMs));
    const host = fakeHost({ platform: "win32", logger });
    host.polite = true;
    const within = 1000;
    const group = superviseGroup(hostGroup({ ...OPTIONS, readyWithin: { value: within, unit: "ms" } }), host.ports, { random: () => 0 });
    group.start();
    await host.settle();
    for (let steps = 0; steps < 2000 && misses.length < 3; steps += 1) {
      await host.clock.advance(100);
      await host.settle();
    }
    await group.stop();
    expect(misses).toEqual([within, within * READY_GROWTH_FACTOR, within * READY_GROWTH_FACTOR ** 2]);
    expect(entries.filter((entry) => entry.includes("is not ready in its time"))).toHaveLength(3);
    // The file of the start times then gives the next supervisor the window after the last miss.
    const text = misses.reduce<string | undefined>((file, windowMs, index) => addMissedStart(file, `2026-11-21T16:0${String(index)}:00.000Z`, windowMs), undefined);
    expect(parseStartTimes(text)).toHaveLength(3);
    expect(hostReadyWindow(HOME, (path) => (path === startTimesPath(hostFolder(HOME)) ? text : undefined)).ms).toBe(Math.max(BOOTSTRAP_WINDOW_MS, within * READY_GROWTH_FACTOR ** 3));
  });

  it("reads a missed window only from the warning of the runtime with a window and a next window", () => {
    const fields = { program: RUNTIME_PROGRAM, window: { value: 5000, unit: "ms" }, next: { value: 10_000, unit: "ms" } };
    expect(missedWindow("warn", fields)).toBe(5000);
    expect(missedWindow("info", fields)).toBeUndefined();
    expect(missedWindow("warn", { ...fields, program: "other" })).toBeUndefined();
    expect(missedWindow("warn", { ...fields, next: undefined })).toBeUndefined();
    expect(missedWindow("warn", { ...fields, window: { value: 5, unit: "s" } })).toBeUndefined();
    // A fault of the record does not stop the log.
    const entries: string[] = [];
    const logger = supervisorLogger({ log: (_level, message) => entries.push(message) }, () => {
      throw new Error("The disk is full.");
    });
    expect(() => logger.log("warn", "runtime is not ready in its time, thus it stops", fields)).not.toThrow();
    expect(entries).toEqual(["runtime is not ready in its time, thus it stops"]);
  });

  it("gives a group and a boot task with no problems", () => {
    expect(groupProblems(hostGroup(OPTIONS))).toEqual([]);
    expect(serviceProblems(hostTask(OPTIONS))).toEqual([]);
  });

  it("gives the runtime a stop grace that holds its longest shutdown, and the supervisor a stop that holds the grace", () => {
    // The drain holds one whole pass. Thus a stop does not cut a send.
    expect(capOf(RUNTIME_PROFILE.phases ?? [], "drain")).toBeGreaterThanOrEqual(INSTANCE_TIMES.passLimit);
    expect(msOf(RUNTIME_GRACE)).toBeGreaterThan(msOf(shutdownCap(RUNTIME_PROFILE)));
    const description = declareSupervisor({ start: () => undefined, stop: async () => undefined }).describe();
    expect(description.dependencies.map((dependency) => dependency.name)).toEqual(["group"]);
    expect(capOf(description.shutdown.phases, "tear down dependencies")).toBeGreaterThan(msOf(RUNTIME_GRACE));
  });

  it("starts the runtime with the folder, the ports, the daemon profile and an IPC channel", async () => {
    const { host, group } = await started();
    expect(host.children).toHaveLength(1);
    const { request } = host.children[0]!;
    expect(request).toMatchObject({ program: NODE, args: [...nodeFlags(), "src/main.ts"], cwd: ROOT, ipc: true });
    expect(request.env).toMatchObject({ ALERTS_HOME: HOME, PORT: String(HOST_PORTS.port), PROBE_PORT: String(HOST_PORTS.probePort), SERVICE_PROFILE: "daemon" });
    expect(group.states()[0]).toMatchObject({ name: "runtime", phase: "ready", restarts: 0 });
    await group.stop();
  });

  it("stops the runtime with the message that the runtime matches", async () => {
    const { host, group } = await started();
    const child = host.children[0]!;
    await group.stop();
    expect(child.sent).toEqual([STOP_MESSAGE]);
    expect(child.ended).toBe(true);
    // The staged stop ended the runtime in its grace. Thus the supervisor did not stop the process tree.
    expect(host.commands.filter((command) => command.args.includes("/F"))).toEqual([]);
  });

  it("starts the runtime again after 3 failed liveness probes in sequence", async () => {
    const { host, group } = await started();
    const first = host.children[0]!;
    host.http.set(`${PROBES}/liveness`, 503);
    // Two failures do not stop the runtime.
    await pass(host, 20);
    expect(first.ended).toBe(false);
    // The third failure stops it in stages, and the supervisor starts it again after the backoff.
    await pass(host, 20);
    expect(first.sent).toEqual([STOP_MESSAGE]);
    expect(first.ended).toBe(true);
    host.http.set(`${PROBES}/liveness`, 200);
    await pass(host, 30);
    expect(host.children).toHaveLength(2);
    expect(group.states()[0]).toMatchObject({ phase: "ready", restarts: 1 });
    await group.stop();
  });

  it("gives a boot task that starts the supervisor with the folder of the private files, and starts it again 1 minute after a stop", () => {
    const spec = hostTask(OPTIONS);
    expect(spec.args).toEqual([...nodeFlags(), join(ROOT, "src", "main.ts"), "supervise", HOME]);
    expect(supervisorDiscovery(HOME)).toBe(join(HOME, "host", "supervisor.json"));
    const xml = renderTaskXml(spec, { user: "HOST\\test", conhost: "C:\\Windows\\System32\\conhost.exe" });
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("S4U");
  });

  it("gives a systemd unit in which only the supervisor gets the stop signal, with a stop grace that holds its longest shutdown", () => {
    const spec = hostTask(OPTIONS);
    expect(spec.stopsChildren).toBe(true);
    expect(msOf(SUPERVISOR_GRACE)).toBeGreaterThan(msOf(shutdownCap(SUPERVISOR_PROFILE)));
    // The longest shutdown of the supervisor holds the stop grace of the runtime.
    expect(msOf(shutdownCap(SUPERVISOR_PROFILE))).toBeGreaterThan(msOf(RUNTIME_GRACE));
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain(`TimeoutStopSec=${Math.ceil(msOf(SUPERVISOR_GRACE) / 1000)}`);
    expect(unit).toContain("Restart=always");
  });

  it("starts the supervisor and the runtime with the inspector closed to SIGUSR1, when the node knows the flag", () => {
    expect(nodeFlags(new Set([NO_SIGUSR1]))).toEqual([NO_SIGUSR1]);
    expect(nodeFlags(new Set())).toEqual([]);
    // The node of CI is 22.14 or later. Thus the boot task, the systemd unit and the runtime get the flag.
    expect(process.allowedNodeEnvironmentFlags.has(NO_SIGUSR1)).toBe(true);
    const spec = hostTask(OPTIONS);
    expect(spec.args?.[0]).toBe(NO_SIGUSR1);
    expect(renderSystemdUnit(spec)).toMatch(/^ExecStart=.*--disable-sigusr1/m);
    expect(hostGroup(OPTIONS).programs[0]!.args?.[0]).toBe(NO_SIGUSR1);
  });

  it("warns at the start of a process with an open inspector signal, and is silent with the flag", () => {
    expect(signalWarning([], "v22.3.0")).toBe("The inspector signal is not disabled: node v22.3.0.");
    expect(signalWarning([NO_SIGUSR1], "v24.0.0")).toBeNull();
  });

  it("reads the flag from the command line of a process before its script, and gives no read for another process", () => {
    expect(signalState("/opt/node\0--disable-sigusr1\0src/main.ts")).toBe("closed");
    expect(signalState("/opt/node\0src/main.ts\0supervise\0/srv/a")).toBe("open");
    // A flag after the script is an argument of the script, not a flag of node.
    expect(signalState("/opt/node\0src/main.ts\0--disable-sigusr1")).toBe("open");
    expect(signalState("/bin/sh\0-c\0sleep 1")).toBe("no read");
    expect(signalState("")).toBe("no read");
    expect(signalState(null)).toBe("no read");
  });

  it("reads the states of the supervisor and the runtime through their discovery files", async () => {
    const files = new Map([
      [join(HOME, "host", "supervisor.json"), JSON.stringify({ pid: 11 })],
      [join(HOME, "host", "runtime.json"), JSON.stringify({ pid: 12 })],
      ["/proc/11/cmdline", "/opt/node\0--disable-sigusr1\0/srv/a/src/main.ts\0supervise\0/srv/h"],
    ]);
    const read = async (path: string) => (files.has(path) ? { text: files.get(path)! } : { code: "ENOENT" });
    const states = await readSignals(HOME, read);
    expect(states).toEqual({ supervisor: "closed", runtime: "no read" });
    expect(signalText(states)).toBe("The inspector signal: the supervisor closed, the runtime no read.");
  });

  it.skipIf(process.platform !== "linux")("reads the flag of a real process through /proc", async () => {
    const home = await mkdtemp(join(tmpdir(), "alerts-signal-"));
    await writeFile(join(home, "main.ts"), "process.stdout.write('up'); setInterval(() => {}, 1000);\n");
    await mkdir(join(home, "host"));
    const child = spawn(process.execPath, [NO_SIGUSR1, join(home, "main.ts")], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      // The first output comes after the exec of node, thus /proc gives the command line of node.
      await new Promise((up) => child.stdout.once("data", up));
      await writeFile(join(home, "host", "runtime.json"), JSON.stringify({ pid: child.pid }));
      expect(await readSignals(home)).toEqual({ supervisor: "no read", runtime: "closed" });
    } finally {
      child.kill("SIGKILL");
      await rm(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "gives a SIGUSR1 no inspector in a node with the flag, and an inspector in a node without it",
    async () => {
      expect(await afterSigusr1([])).toContain("Debugger listening");
      expect(await afterSigusr1([NO_SIGUSR1])).not.toContain("Debugger listening");
    },
    15_000,
  );
});

describe("the discovery file of the runtime", () => {
  it("is the file of the runtime program in the folder of the host", () => {
    expect(hostGroup(OPTIONS).programs.map((program) => program.name)).toEqual([RUNTIME_PROGRAM]);
    expect(runtimeDiscovery(HOME)).toBe(join(hostFolder(HOME), `${RUNTIME_PROGRAM}.json`));
  });

  it("gives the process ID of a discovery file, and no ID for a file with no process", () => {
    expect(discoveryPid({ text: JSON.stringify({ pid: 4242, startedAt: "2026-11-16T07:00:00Z", port: 4750 }) })).toBe(4242);
    expect(discoveryPid({ code: "ENOENT" })).toBeUndefined();
    expect(discoveryPid({ text: "{" })).toBeUndefined();
    expect(discoveryPid({ text: "null" })).toBeUndefined();
    for (const pid of [0, -1, 1.5, "4242", Number.MAX_SAFE_INTEGER + 1]) expect(discoveryPid({ text: JSON.stringify({ pid }) })).toBeUndefined();
  });
});
