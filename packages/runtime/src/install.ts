/**
 * This file installs, removes or reads the boot task of the supervisor on this computer. Start it
 * from the checkout that the task runs.
 *
 * - On Windows, the install of a boot task needs an elevated shell.
 * - On Linux, the install needs no elevated shell. It writes a user unit of systemd. `loginctl enable-linger`
 *   starts the user manager at boot, before a logon. If the system refuses the linger, an admin enables it one time.
 *
 * - `node src/install.ts install` installs the task and starts it.
 * - `node src/install.ts remove` stops the supervisor and removes the task.
 * - `node src/install.ts status` tells if the task exists, its state, and the result of one readiness probe of the runtime.
 *   It also reads the check of the heartbeat on Healthchecks.io. The period plus the grace of the check must be the gap of two pings or more.
 *
 * - `node src/install.ts restart` restarts the runtime on the code of this checkout, with no elevated shell. It checks
 *   the private files with this code first. Then it waits for the new runtime and its readiness.
 *
 * `status` and `restart` also tell if the local page is not built, or older than the source files of the checkout. The
 * cloud copy has no page, thus this warning does not change the exit code.
 *
 * A change of `copy.json` needs `restart`, because the runtime reads the file only at its start.
 *
 * After each install, and after each change of `config.json` or `secrets.env`, start `status` when the
 * time of the ready wait passed. A runtime that is not ready sends no alert.
 *
 * The environment gives `ALERTS_HOME`, the folder of the private files, as for `main.ts`. Without
 * it, the folder is `.alerts` in the home folder. `ALERTS_LIVE` names the live path in place of the checkout of this
 * file, for a first deploy (`deploy.ts`).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@procedures/fs/files";
import { valueIn } from "@mark1russell7/quantity";
import { installService, nodeHostPorts, probeOnce, serviceStatus, uninstallService, type ServiceOutcome } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { fetchTransport, send, statusLine } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { pageWarning, readPageState } from "./api.ts";
import { alertsHome, configPath, readText, SECRETS_FILE } from "./config.ts";
import { readCopySettings } from "./copy.ts";
import { checkOfPingUrl, checksRequest, checkTimesProblem, heartbeatGap } from "./heartbeat.ts";
import { discoveryPid, hostReadyWindow, hostTask, readinessProbe, RUNTIME_GRACE, runtimeDiscovery, supervisorDiscovery } from "./host.ts";
import { hostFileText } from "./start-times.ts";
import { checksKeys, daemonCheck, INSTANCE_TIMES, LOUD_STEADY, USER_AGENT_NAME } from "./instance.ts";
import { checkStart, GOOD_FILE, privateFiles, readStartTexts, requestRestart, restartUse, type RestartOutcome } from "./reload.ts";
import { liveRoot } from "./slots.ts";

const ACTIONS = ["install", "remove", "status", "restart"] as const;
const action = process.argv[2];

const home = alertsHome(process.env, process.cwd());
// The path of the command line, not resolved: an install through the live link gives the task the link (AL-89).
// `ALERTS_LIVE` names the live path for a first deploy, when the live slot has an older install.ts (`liveRoot`).
const root = liveRoot(process.env, process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const spec = hostTask({ home, root, node: process.execPath });
const ports = nodeHostPorts();
// The supervisor writes this discovery file. With it, the remove stops the live process tree.
const discovery = supervisorDiscovery(home);

/** This function prints an outcome, and gives the exit code. */
function report(outcome: ServiceOutcome): number {
  switch (outcome.kind) {
    case "done":
      console.log(`Done. The files: ${outcome.files.join(", ") || "none"}.`);
      return 0;
    case "failed":
      console.error(`The command failed: ${outcome.problem}`);
      return 1;
    case "refused":
      console.error(`The spec has these problems:\n- ${outcome.problems.join("\n- ")}`);
      return 1;
    case "unsupported":
      console.error(`The platform ${outcome.platform} has no service host.`);
      return 1;
  }
}

// The longest time of one readiness probe of the status.
const PROBE_TIMEOUT_MS = 2000;

// The ready window of the supervisor: the window of the measured starts of this host.
const READY_WINDOW_MS = hostReadyWindow(home, hostFileText).ms;

// The longest wait of a restart: the longest gap of two passes, the stop of the old runtime, and the readiness of the new one.
const RESTART_WAIT_MS = heartbeatGap(INSTANCE_TIMES) + valueIn(RUNTIME_GRACE, "ms") + READY_WINDOW_MS;

/** This function prints the outcome of a restart request, and gives the exit code. No line holds a value of a private file. */
function reportRestart(outcome: RestartOutcome): number {
  switch (outcome.kind) {
    case "refused":
      console.error(`The private files have problems with the code of this checkout. No restart request was written:\n- ${outcome.problems.join("\n- ")}`);
      return 1;
    case "no-runtime":
      console.error("No runtime runs: its discovery file has no process ID. Then read: node src/install.ts status");
      return 1;
    case "no-restart":
      console.error(`The runtime (process ${outcome.pid}) did not restart in ${Math.round(RESTART_WAIT_MS / 1000)} s. The request stays, and the next pass of the runtime reads it.`);
      return 1;
    case "restarted": {
      const restarted = `The runtime restarted (process ${outcome.from}, then ${outcome.to})`;
      if (!outcome.ready) {
        console.error(`${restarted}, and it is not ready. Then read: node src/install.ts status`);
        return 1;
      }
      if (outcome.use === "files") {
        console.log(`Done. ${restarted}, it is ready, and it uses the private files.`);
        return 0;
      }
      // A runtime on the last good set sends alerts, but the deploy did not get its files. Its output tells the reason.
      console.error(
        outcome.use === "good"
          ? `${restarted}, and it is ready. Its start stopped with the private files, thus it uses the last good set ${GOOD_FILE}. The output of the runtime tells the reason.`
          : `${restarted}, and it is ready. Its start is not marked good in ${Math.round(RESTART_WAIT_MS / 1000)} s. Then read the output of the runtime.`,
      );
      return 1;
    }
  }
}

/** The result of the read of the outside check. The times are in seconds, as Healthchecks.io shows them. */
interface OutsideCheck {
  readonly ok: boolean;
  readonly status?: string;
  readonly periodSeconds?: number;
  readonly graceSeconds?: number;
  /** The period plus the grace that the heartbeat needs. */
  readonly neededSeconds: number;
  readonly problem?: string;
}

/**
 * This function reads one check of the heartbeat through the management API of Healthchecks.io. The
 * check fails when its period plus its grace is shorter than `gap`, by default the gap of two pings. The output holds no
 * key and no URL.
 */
async function outsideCheck(key: string, url: string, secrets: readonly string[], gap = heartbeatGap(INSTANCE_TIMES)): Promise<OutsideCheck> {
  const neededSeconds = Math.ceil(gap / 1000);
  // The request has the User-Agent with no contact: the status reads no configuration.
  const exchange = checksRequest(key, USER_AGENT_NAME);
  try {
    const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
    const input = { source: "Healthchecks.io", host: new URL(exchange.url).host, what: "the checks of the project", exchange, secrets, redact: redactSecrets };
    const answer = await send(pace, fetchTransport({ userAgent: USER_AGENT_NAME }), input);
    if (answer.reply.status !== 200) return { ok: false, neededSeconds, problem: `The management API gave ${statusLine(answer.reply)}.` };
    const found = checkOfPingUrl(answer.reply.body, url);
    if (!found.ok) return { ok: false, neededSeconds, problem: found.problem };
    const problem = checkTimesProblem(found.check, gap);
    const seen = { status: found.check.status, periodSeconds: found.check.timeout / 1000, graceSeconds: found.check.grace / 1000, neededSeconds };
    return problem === undefined ? { ok: true, ...seen } : { ok: false, ...seen, problem };
  } catch (error) {
    return { ok: false, neededSeconds, problem: redactSecrets(errorMessage(error), secrets) };
  }
}

if (action === "install") {
  const code = report(await installService(spec, ports, { start: true }));
  if (code === 0) console.log(`The runtime is ready in ${String(Math.ceil(READY_WINDOW_MS / 1000))} s or less. Then start: node src/install.ts status`);
  process.exitCode = code;
} else if (action === "remove") {
  process.exitCode = report(await uninstallService(spec, ports, { discovery }));
} else if (action === "status") {
  const readiness = await probeOnce(readinessProbe(), PROBE_TIMEOUT_MS, ports);
  // The status reads copy.json and secrets.env as the start does: a bad line is a problem, and no problem holds a value.
  const copy = await readCopySettings(home);
  const keys = copy.tag === "err" ? copy : checksKeys(await readText(() => readFile(join(home, SECRETS_FILE), "utf8")), copy.value);
  const neededSeconds = Math.ceil(heartbeatGap(INSTANCE_TIMES) / 1000);
  const secrets = keys.tag === "ok" ? [keys.value.key, keys.value.url, ...(keys.value.loudUrl === undefined ? [] : [keys.value.loudUrl])] : [];
  const heartbeat: OutsideCheck = keys.tag === "err" ? { ok: false, neededSeconds, problem: keys.error.join(" ") } : await outsideCheck(keys.value.key, keys.value.url, secrets);
  // The loud check is optional. Without its key, the status has no field of it. Its first success after a start waits for
  // `LOUD_STEADY`, thus a restart of the only copy needs the gap plus that wait.
  const loudGap = heartbeatGap(INSTANCE_TIMES) + LOUD_STEADY;
  const loud = keys.tag === "ok" && keys.value.loudUrl !== undefined ? { loud: await outsideCheck(keys.value.key, keys.value.loudUrl, secrets, loudGap) } : {};
  // The start marker tells the files of the runtime, and the check of the files tells the files of the next start.
  // A runtime on the last good set, or private files with problems, give the code 1. The problems hold no value.
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  const next = checkStart(await readStartTexts(files), daemonCheck);
  const start = { use: restartUse(await readText(() => readFile(files.marker, "utf8"))), files: next.tag === "ok" ? [] : next.error };
  const page = await readPageState(root);
  console.log(JSON.stringify({ task: await serviceStatus(spec, ports, { discovery }), readiness, heartbeat, ...loud, start, page }, null, 2));
  const pageLine = pageWarning(page);
  if (pageLine !== undefined) console.error(pageLine);
  if (start.use !== "files") console.error(`The runtime does not use the private files (${start.use}). Read the output of the runtime.`);
  if (start.files.length > 0) console.error(`The private files have problems, thus the next start uses the last good set ${GOOD_FILE}.`);
  const startOk = start.use === "files" && start.files.length === 0;
  if (!readiness.ok || !heartbeat.ok || ("loud" in loud && !loud.loud.ok) || !startOk) process.exitCode = 1;
} else if (action === "restart") {
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  // The check of the restart reads the three private files, as the start does. A bad copy.json stops the restart.
  const outcome = await requestRestart(
    { files, checkOf: daemonCheck, waitMs: RESTART_WAIT_MS, pollMs: 2000 },
    {
      write: (path, text) => writeFileAtomic(path, text),
      pid: async () => discoveryPid(await readText(() => readFile(runtimeDiscovery(home), "utf8"))),
      ready: async () => (await probeOnce(readinessProbe(), PROBE_TIMEOUT_MS, ports)).ok,
      sleep: (ms) => sleep(ms),
      now: () => Date.now(),
      token: () => `${new Date().toISOString()} ${randomUUID()}`,
    },
  );
  process.exitCode = reportRestart(outcome);
  const pageLine = pageWarning(await readPageState(root));
  if (pageLine !== undefined) console.error(pageLine);
} else {
  console.error(`The action is one of: ${ACTIONS.join(", ")}.`);
  process.exitCode = 2;
}
