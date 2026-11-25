/**
 * This file is the entry of the process, and the only file that uses `run()`. It starts one of two services:
 *
 * - `node src/main.ts` starts the runtime.
 * - `node src/main.ts supervise <folder>` starts the supervisor of the runtime (`supervise.ts`). The boot task starts it.
 * - `node src/main.ts load` loads each module of the runtime, and stops with the code 0. It starts no service. The stage of a
 *   deploy uses it to check the code of a new slot (`deploy.ts`).
 * - `node src/main.ts fold [files|good]` folds the log, writes the snapshot of the start, and stops. It starts no service
 *   (`fold-mode.ts`). With no set, it folds for the set of the next start. `deploy.ts fold` starts it for each set (AL-169).
 *
 * The lifecycle owns the signals of the process. After SIGTERM or Ctrl-C, the service stops in its
 * phases, and the process exits with 0 or 1.
 *
 * The environment gives `PORT` (8080), `PROBE_PORT` (9090), `SERVICE_PROFILE` (`local`) and
 * `ALERTS_HOME` (the folder `.alerts` in the home folder). The value in parentheses is the value
 * without the variable. An empty value counts as no value, and a relative path starts at the working
 * folder. The folder holds the private files of the instance: `config.json`,
 * `secrets.env`, the log `runtime.sqlite`, the outlines `shapes.sqlite` and the counts of the quotas
 * `quotas.sqlite`. It also holds the use reads of the caps, `use.json` (AL-91). No repository holds them.
 *
 * The key `HEALTHCHECKS_PING_URL` of `secrets.env` gives the outside heartbeat (`heartbeat.ts`). The
 * profile `daemon` of the live instance does not start without it. Another profile starts with a warning.
 * The optional key `HEALTHCHECKS_LOUD_PING_URL` gives a second check. The heartbeat sends each ping to it too.
 *
 * The API also serves the built local page of `packages/site/dist` at the path `/`. Build it before the start:
 * `pnpm --filter ./packages/site build`. Without the build, the path `/` gives 404, and the routes still answer. The
 * start line tells if the page is not built, or older than the source files of the checkout.
 *
 * The optional file `copy.json` gives the settings of this copy of the system (`copy.ts`): its rank and the key of its
 * first check. Without the file, the runtime is the only copy.
 *
 * The field `outage` of `config.json` gives the outage call. It needs the keys of Twilio and the key
 * `OUTAGE_TOKEN`. The worker `outage` deploys its Functions to Twilio (`outage.ts`).
 *
 * A copy with other copies reads them over HTTP (`exchange-http.ts`). A copy with the address `listen` serves its
 * shared events on that address. Both need the key `COPY_TOKEN` of `secrets.env`, with 32 or more characters.
 *
 * The start uses the private files `config.json`, `secrets.env` and `copy.json` (`reload.ts`). Files with problems give way
 * to the last good set `start.good.json`. A start that stopped before it was ready also gives way to it. The start is good
 * when the service operates and one pass ended. In the profile `daemon`, a change of the private files that passes the
 * check stops the runtime. The supervisor starts it again.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { configHash, LOOP_BLOCK_LIMIT } from "@mark1russell7/alerts";
import { watchEventLoop } from "@mark1russell7/lag/node";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES } from "@mark1russell7/alerts-channel-pushover";
import { OUTAGE_BUNDLE_FILE } from "@mark1russell7/alerts-channel-twilio";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import type { ServiceBuilder } from "@mark1russell7/service";
import { nodeHostPorts } from "@mark1russell7/service/host";
import { countOf, errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { SqliteHostStateStore } from "polite-crawler";
import { fetchTransport, quotaGate } from "polite-crawler/api";
import { writeFileAtomic } from "@procedures/fs/files";
import { configFilesOf, configSync } from "./config-sync.ts";
import { alertsHome, ConfigRefused, configPath, envSecrets } from "./config.ts";
import { pageFolder, pageWarning, readPageState } from "./api.ts";
import { COPY_TOKEN_KEY } from "./copy.ts";
import { configFilesCall, EXCHANGE_TOKEN_LENGTH, exchangeCall, exchangeHost } from "./exchange-http.ts";
import { createPositionIntake, FIXES_FILE, readFixes, writeFixes } from "./position-intake.ts";
import { createTellIntake, tellHost, tellToken } from "./tell-intake.ts";
import { heartbeat, heldOf } from "./heartbeat.ts";
import type { Pass } from "./runtime.ts";
import { COVERAGE_FILE, coverageFile } from "./coverage-file.ts";
import { holdHome } from "./home-lock.ts";
import { quotaNote } from "./quota.ts";
import { replyNotes } from "./replies.ts";
import { spendNotes } from "./balance.ts";
import { USE_FILE, useFile } from "./spend-use.ts";
import { PROFILES, declare } from "./index.ts";
import { daemonCheck, instanceCheck, instanceContextKey, LOUD_PING_URL_KEY, openInstance, pingKeyOf, pingTargets, userAgent } from "./instance.ts";
import { openCheckedRuntimeLog } from "./log.ts";
import { blockLine, startLoopWatch, type LoopWatch } from "./loop-watch.ts";
import { foldText, writeFold } from "./fold-mode.ts";
import { startBlockWatch, type BlockWatch } from "./block-watch.ts";
import { fileBundleStore } from "./outage.ts";
import type { ExchangeRound } from "./peers.ts";
import { loadPriors } from "./priors.ts";
import { openReadingStore, READINGS_FILE } from "./readings.ts";
import { GOOD_FILE, privateFiles, readStartTexts, reloadHook, startConfig, type CheckOf, type StartUse } from "./reload.ts";
import { shapeReport, zoneCodesText } from "./shapes.ts";
import { openTransitCache, TRANSIT_FILE, transitReport, transitText } from "./transit.ts";
import { hostFolder, signalWarning } from "./host.ts";
import { recordRunningCode } from "./running.ts";
import { checkoutOf, liveRoot, slotsOfCheckout } from "./slots.ts";
import { openStartSnapshots, START_SNAPSHOTS_FOLDER, startReadText } from "./start-snapshot.ts";
import { supervisor } from "./supervise.ts";
import { outputOf, timedLogger } from "./output.ts";
import { runtimeVersion, startTelemetry } from "./telemetry.ts";

// Each line of the runtime starts with the time of the wall clock: the log file of the runtime has no other time (AL-120).
const out = outputOf(timedLogger());

// The watch of long blocks (AL-119). Its worker writes a line to the error output during a block of 10 s or more. The
// supervisor writes that output to the log file of the runtime, thus a liveness stop in a block has its cause on file.
let blockWatch: BlockWatch | undefined;

/** This function gives a port from the environment, or the fallback when the variable is not set. */
const port = (name: string, fallback: number): number => {
  const text = process.env[name];
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} is not a port: ${text}`);
  return value;
};

/** This function makes the service of the runtime from the environment and the private files. */
// The mode `fold` (AL-153) folds the log and writes the snapshot of the start, then it gives no service (`fold-mode.ts`).
// It folds for the set of the next start, or for the set that `pick` names (AL-169).
async function runtime(fold: boolean, pick?: StartUse): Promise<ServiceBuilder | undefined> {
  const name = process.env["SERVICE_PROFILE"] ?? "local";
  const profile = PROFILES[name];
  if (profile === undefined) throw new Error(`SERVICE_PROFILE is "${name}". The profiles are: ${Object.keys(PROFILES).join(", ")}.`);
  // A fault of the watch stops only the watch.
  try {
    blockWatch = startBlockWatch({ target: 2, onError: (error) => out.error(`The watch of long blocks stopped: ${errorMessage(error)}`) });
    blockWatch.phase("start: files");
  } catch (error) {
    out.error(`The watch of long blocks did not start: ${errorMessage(error)}`);
  }

  const home = alertsHome(process.env, process.cwd());
  // The lock of the home folder comes before each read and each write of its files (AL-58). A second runtime on the folder
  // stops here. A start that stops after this line leaves a stale lock, and the next start removes it.
  const held = await holdHome(home, nodeHostPorts());
  if (held.recovered !== undefined) out.log(`The lock of a runtime that stopped went: ${held.recovered}`);
  // The record of the code of this start (AL-167). The probes of a deploy do not tell the slot that runs.
  if (!fold) {
    const checkout = checkoutOf(liveRoot(process.env, process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), "..")));
    await recordRunningCode(await slotsOfCheckout(checkout), checkout, hostFolder(home), process.pid, new Date()).catch((error: unknown) => {
      out.error(`The record of the running code was not written: ${errorMessage(error)}`);
    });
  }

  // The start checks config.json with the keys of secrets.env and the settings of copy.json. Files with problems, or files
  // of a start that stopped before it was ready, give way to the last good set. A problem names the line and the key of a
  // bad line, or the code of a read error. It holds no value, no address, no URL and no path.
  // The last good set holds the keys, thus each file that the start writes has the permissions 0600.
  const checkOf: CheckOf = name === "daemon" ? daemonCheck : instanceCheck;
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  // The mode fold is not a start: it does not change the start marker or the last good set. Thus it uses the set that the next start uses.
  const startPorts = fold
    ? { write: () => Promise.resolve(), remove: () => Promise.resolve() }
    : { write: (path: string, text: string) => writeFileAtomic(path, text, { mode: 0o600 }), remove: (path: string) => rm(path, { force: true }) };
  const loaded = await startConfig(files, checkOf, startPorts, pick);
  if (fold) {
    // The fold names its set. When the two sets have the same texts, they have one key, thus a fold for the good set does nothing new.
    if (pick === "good" && loaded.same) {
      out.log("The last good set has the same texts as the private files. Their snapshot is one snapshot, thus this fold stops.");
      held.lock.release();
      return undefined;
    }
    out.log(`The mode fold folds for the set of ${loaded.use === "files" ? "the private files" : `the last good set ${GOOD_FILE}`}.`);
  }
  if (loaded.use === "good") out.error(`The runtime uses the last good set ${GOOD_FILE} of the private files:\n- ${loaded.fallback.join("\n- ")}`);
  for (const note of loaded.notes) out.error(note);
  // The settings of this copy of the system, from the files of the start.
  const copy = loaded.copy;
  // The context of the traces, with the resource of this copy (AL-82). No span leaves the process. The service stops it.
  const telemetry = startTelemetry({ version: await runtimeVersion(), copy: copy.id });
  const peers = copy.peers ?? [];
  if (peers.length > 0) out.log(`This runtime is the copy ${copy.id} with rank ${String(copy.rank)}. The other copies: ${peers.map((peer) => peer.id).join(", ")}.`);
  const keys = loaded.keys;
  const values = Object.values(keys);

  const secret = envSecrets(keys);
  const wall = wallClock();
  const config = loaded.parsed;
  // Each request to the server of another party has this User-Agent.
  const agent = userAgent(config.config.contact);

  // The exchange with the other copies. Each copy has the same token, and a problem holds no value of the token.
  const exchanges = peers.length > 0 || copy.listen !== undefined;
  const token = exchanges ? secret(COPY_TOKEN_KEY) : undefined;
  if (exchanges && (token === undefined || token.length < EXCHANGE_TOKEN_LENGTH)) {
    throw new ConfigRefused([`The file secrets.env needs ${COPY_TOKEN_KEY} with ${String(EXCHANGE_TOKEN_LENGTH)} or more characters. A copy with other copies or the address listen uses it.`]);
  }
  // Each problem of a page goes to the output. A failed read of a copy goes to the output once when it starts and once when it ends.
  const failing = new Set<string>();
  const onExchange = (round: ExchangeRound): void => {
    for (const problem of round.problems) out.error(redactSecrets(`The exchange: ${problem}`, values));
    for (const id of round.conflicts) out.error(`The exchange: the import ${id} has the id of a different event of the log. The log kept its event.`);
    for (const peer of peers) {
      const failure = instance.copies?.worker?.failure(peer.id);
      if (failure !== undefined && !failing.has(peer.id)) {
        failing.add(peer.id);
        out.error(redactSecrets(`The reads of the copy ${peer.id} fail: ${failure}`, values));
      } else if (failure === undefined && failing.delete(peer.id)) {
        out.log(`The reads of the copy ${peer.id} work again.`);
      }
    }
  };

  // The count of the Pushover messages of the month. The file keeps it across a restart. The key names the application, not its token.
  const quotas = new SqliteHostStateStore(join(home, "quotas.sqlite"));
  // The file of the use reads holds amounts of the account. Thus only the user of the folder reads it.
  const uses = useFile({
    write: (text) => writeFileAtomic(join(home, USE_FILE), text, { mode: 0o600 }),
    onError: (error) => out.error(`A write of ${USE_FILE} failed: ${error instanceof Error ? error.name : typeof error}.`),
  });
  // The coverage report of each watched place and kind, with the health of each source (AL-196). It names the places, thus only the user of the folder reads it.
  const coverageReport = coverageFile({
    write: (text) => writeFileAtomic(join(home, COVERAGE_FILE), text, { mode: 0o600 }),
    onError: (error) => out.error(`A write of ${COVERAGE_FILE} failed: ${error instanceof Error ? error.name : typeof error}.`),
  });
  const pushoverQuota = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", store: quotas, now: () => wall.now() });
  const pushoverReserveNotices = quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", store: quotas, now: () => wall.now() });

  // The outside heartbeat. Without it, a stop of this process is silent. The check of the profile daemon needs it.
  // Each check has its own hook, thus a slow ping to one check does not hold the other. The loud check gets only the success pings.
  const targets = pingTargets(secret, copy);
  if (!targets.some((target) => target.key === pingKeyOf(copy))) out.warn(`The file secrets.env has no ${pingKeyOf(copy)}. This runtime has no outside heartbeat.`);
  const beats = targets.map((target) =>
    heartbeat({
      url: target.url,
      fetch,
      clock: wall,
      userAgent: agent,
      held: (at) => heldOf(instance.runtime.state(), at),
      // The body of each ping tells the state of each quota, and each failed read of the replies or of the spend. Thus the check shows the reserve.
      notes: () => [...instance.quotas().map(quotaNote), ...replyNotes(instance.replies), ...spendNotes(instance.spend)],
      // The shared loud check gets only the success pings, after a steady run (AL-100). Thus it calls only when no copy can
      // tell the person, and one time for each outage.
      successOnly: target.successOnly,
      steadyAfter: target.steadyAfter,
      onError: (message) => out.error(redactSecrets(target.key === LOUD_PING_URL_KEY ? `The loud check: ${message}` : message, values)),
    }),
  );

  // A copy with the field configFrom takes config.json and the parts from that copy (AL-17). The sync writes the files before a
  // read of the reload hook, thus the hook reads the whole set and starts the runtime again.
  const configSource = copy.configFrom === undefined ? undefined : peers.find((peer) => peer.id === copy.configFrom);
  const sync =
    name !== "daemon" || configSource === undefined || token === undefined
      ? undefined
      : configSync({
          source: configSource,
          files,
          checkOf,
          read: () => instance.copies?.worker?.watches().find((watch) => watch.copy === configSource.id)?.read,
          call: configFilesCall({ token }),
          clock: wall,
          ports: {
            read: () => readStartTexts(files),
            makeFolder: async (path) => {
              await mkdir(path, { recursive: true, mode: 0o700 });
            },
            write: (path, text) => writeFileAtomic(path, text, { mode: 0o600 }),
            remove: (path) => rm(path, { force: true }),
          },
          report: (message) => out.error(`The sync of the configuration: ${message}`),
        });
  // A change of the private files, or a restart request, restarts the runtime. Only the profile daemon has a supervisor that starts it again.
  const reload =
    name === "daemon"
      ? reloadHook({
          files,
          checkOf,
          ...(sync === undefined
            ? {}
            : {
                beforeRead: async () => {
                  await sync.step();
                },
              }),
          started: loaded.texts,
          request: loaded.request,
          restart: (cause) => {
            const reason = cause === "requested" ? "A restart request came." : "The private files changed, and they pass the check.";
            out.error(`${reason} The runtime stops, and the supervisor starts it again.`);
            void service.lifecycle?.shutdown(cause === "requested" ? "A restart request came." : "The private files changed.");
          },
          onRefused: (problems) => out.error(`A change of the private files has problems. The runtime keeps its files:\n- ${problems.join("\n- ")}`),
        })
      : undefined;
  // The start is good after the startup of the service and one pass. Then the start writes the last good set, and it removes the
  // start marker. A stop before that point gives way to the last good set at the next start with the same files.
  let marked = false;
  // The watch of the event loop starts at the good start (AL-88). A start folds the log in one block, and the ready window of the supervisor measures it.
  let loopWatch: LoopWatch | undefined;
  const onPass = (pass: Pass): void => {
    for (const beat of beats) beat(pass);
    reload?.onPass();
    // The use reads of the cap of Twilio go into the private folder when they change (AL-91).
    if (instance.useReads !== undefined) uses.update(instance.useReads());
    coverageReport.update(pass.view);
    if (marked || service.lifecycle?.state !== "running") return;
    marked = true;
    blockWatch?.phase("run after the good start");
    // Each block of 1 s or more goes to the output at once, and the next pass writes it into the log. Thus a stop after a
    // block has its cause on file.
    loopWatch = startLoopWatch({
      watch: watchEventLoop({ limitMs: LOOP_BLOCK_LIMIT }),
      mono: () => performance.now(),
      wall: () => wall.now(),
      onBlock: (block) => {
        out.error(blockLine(block));
        instance.loop.wake();
      },
    });
    // The deploy of the outage call waits for the good start and its steady wait (AL-112).
    instance.outage?.steady();
    void loaded.ready().then((notes) => {
      for (const note of notes) out.error(note);
    });
  };

  blockWatch?.phase("start: open and fold of the log");
  // A broken log file goes into quarantine. The new file gets each event that the salvage reads, and a system report tells the loss.
  const { log, recovered } = openCheckedRuntimeLog(join(home, "runtime.sqlite"), { now: () => wall.now() });
  if (recovered !== undefined) out.error(`The log file was broken. It is in the quarantine folder ${recovered.quarantine}. The new log kept ${String(recovered.added)} events and lost ${String(recovered.lost)}.`);
  // The snapshots of the start (AL-105), one for each key (AL-169). A salvaged log has a new key, and the clear frees the rows of the old log.
  const snapshot = openStartSnapshots(home, {
    onQuarantine: () => out.error(`A file of the snapshots of the start was broken. It is in quarantine, and the start folds the whole log.`),
  });
  if (snapshot.fault !== undefined) out.error(`The folder ${START_SNAPSHOTS_FOLDER} did not open (${snapshot.fault}). Each start folds the whole log.`);
  if (recovered !== undefined) snapshot.store?.clear();
  // A broken file of shapes goes into quarantine, and the store starts empty. Then the outlines come again from the NWS API.
  const shapes = openShapeCache(join(home, SHAPES_FILE));
  if (shapes.quarantined !== undefined) out.error(`The file ${SHAPES_FILE} was broken. It is in quarantine, and the store of shapes starts empty.`);
  // A broken file of readings goes into quarantine, and the store starts empty. Each series has no read until its history fills again.
  const readings = openReadingStore(join(home, READINGS_FILE));
  if (readings.quarantined !== undefined) out.error(`The file ${READINGS_FILE} was broken. It is in quarantine, and the store of readings starts empty.`);
  // A bad copy of the transit catalog gives no feed. The next good read of the catalog replaces the file.
  const transit = openTransitCache(join(home, TRANSIT_FILE), (problem) => out.error(`The copy of the transit catalog is not used: ${problem}.`));
  // Only the profile daemon has a supervisor that starts the runtime again. Each other profile tells the person to start it again.
  const restart = (what: string, reason: string): void => {
    if (name !== "daemon") {
      out.error(`${what} Start the runtime again to use them.`);
      return;
    }
    out.error(`${what} The runtime stops, and the supervisor starts it again.`);
    void service.lifecycle?.shutdown(reason);
  };
  // The priors of the shadow score. A fault of the file stops only the score.
  const priors = loadPriors((message) => out.error(message));
  // The intake of the messages of the operator (AL-92). Only the entry tell of config.json opens it.
  const tellConfig = config.config.tell;
  const tellIntake = tellConfig === undefined ? undefined : createTellIntake({ config: tellConfig, recipients: config.recipients, now: () => wall.now() });
  // The intake of the fixes of the moving places (AL-40). It is on the listener of the intake of the operator. The file fixes.json
  // gives the last fix of each moving place at the start. No line of the log holds a position.
  const moving = config.config.places.some((place) => place.moving !== undefined);
  const stored = tellIntake === undefined || !moving ? undefined : await readFixes(home, config.config);
  if (stored?.problem !== undefined) out.error(stored.problem);
  const positionIntake =
    stored === undefined
      ? undefined
      : createPositionIntake({ config: config.config, fixes: stored.fixes, write: (fixes) => writeFixes(home, fixes), onFault: (error) => out.error(`The runtime did not write the file ${FIXES_FILE}: ${errorMessage(error)}`) });
  if (moving && tellIntake === undefined) out.error("The configuration has a moving place, but no entry tell. This copy takes no fix, and it does not watch the moving places.");
  const instance = openInstance({
    config,
    secret,
    log,
    ...(priors === undefined ? {} : { priors }),
    clock: realClock,
    wall,
    transport: fetchTransport({ userAgent: agent }),
    pushover: fetch,
    pushoverQuota,
    pushoverReserveNotices,
    // The Twilio calls and the read of the balance. The cap of the spend counts in quotas.sqlite.
    twilio: fetch,
    webhook: fetch,
    // The stage of the slot writes the outage bundles to this file. A deploy reads it, thus it starts no esbuild (AL-112).
    outageBundles: fileBundleStore(OUTAGE_BUNDLE_FILE),
    spendStore: quotas,
    run: randomUUID(),
    copy,
    ...(tellIntake === undefined ? {} : { tell: tellIntake }),
    ...(positionIntake === undefined ? {} : { position: positionIntake }),
    ...(token === undefined ? {} : { exchange: { call: exchangeCall({ token }), configHash: configHash(config.config) }, onExchange }),
    onPass,
    // The output gets no secret, also when an error quotes a request.
    onError: (error, failures) => out.error(`A pass failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
    shapes,
    readings,
    // The kind of the error only: its message can quote a value of a reading.
    onReadingsFault: (error, action) => out.error(`The store of readings failed (${action}): ${error instanceof Error ? error.name : typeof error}.`),
    ...(snapshot.store === undefined ? {} : { startSnapshot: snapshot.store }),
    // The kind of the error only, as for the readings.
    onStartSnapshotFault: (error) => out.error(`A write of the snapshot of the start failed: ${error instanceof Error ? error.name : typeof error}.`),
    // The store of shapes and the keeper of the transit catalog start their work at a pass after the good start (AL-75).
    startGood: () => marked,
    onShapes: (outcome) => {
      const report = shapeReport(outcome);
      if (report !== undefined) out.error(redactSecrets(report, values));
    },
    // New outlines change the codes of a place. Only the profile daemon has a supervisor that starts the runtime again.
    onPlaceCodes: () => restart("New outlines change the codes of a place.", "The codes of a place changed."),
    transit,
    onTransit: (outcome) => {
      const report = transitReport(outcome);
      if (report !== undefined) out.error(redactSecrets(report, values));
    },
    // A new copy of the catalog changes the transit feeds of the places. The same restart applies.
    onTransitFeeds: () => restart("A new copy of the transit catalog changes the transit feeds of the places.", "The transit feeds changed."),
    // The worker of the outage call deploys its Functions 10 minutes after the good start, then once in each day. A failed deploy goes again after a backoff.
    onOutageLog: (line) => out.log(line),
    loopBlocks: () => loopWatch?.blocks() ?? [],
    onOutageError: (error, failures) => out.error(`A deploy of the outage call failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
  });
  blockWatch?.phase("start: service and first pass");
  if (instance.zones !== undefined) out.log(zoneCodesText(instance.zones));
  if (instance.transit !== undefined) out.log(transitText(instance.transit.chosen, instance.transit.copied));
  out.log(startReadText(instance.runtime.start));
  if (instance.runtime.skipped > 0) {
    out.error(`The log has ${String(instance.runtime.skipped)} events of types that this build does not know. A later build wrote them. The runtime skips them.`);
  }
  // The mode fold writes the snapshot of this fold. Then it closes the files in the sequence of the shutdown of the service.
  if (fold) {
    const store = snapshot.store;
    if (store === undefined) throw new Error(`The folder ${START_SNAPSHOTS_FOLDER} did not open. The mode fold writes no snapshot.`);
    blockWatch?.phase("fold: write of the snapshot");
    const transitKeeper = instance.transit;
    const rows = await writeFold({
      runtime: instance.runtime,
      closes: [() => store.close(), () => readings.close(), () => quotas.close(), () => transitKeeper?.close(), () => instance.shapes.close(), () => log.close(), () => held.lock.release()],
    });
    out.log(foldText(rows, instance.runtime.start.events));
    return undefined;
  }

  // The listener of the exchange is on the address listen of copy.json. Only the token check of the host guards it.
  const copies = instance.copies;
  const host = copies === undefined || copy.listen === undefined || token === undefined ? undefined : exchangeHost({ source: copies.source, token, listen: copy.listen, configFiles: configFilesOf({ copy, use: loaded.use, texts: loaded.texts, configHash: configHash(config.config) }) });
  const exchange = { ...(copies?.loop === undefined ? {} : { loop: copies.loop }), ...(host === undefined ? {} : { host }) };
  // The listener of the intake is on the loopback address. The runtime makes the file tell.token at its first start with the entry.
  const tell = tellIntake === undefined || tellConfig === undefined ? undefined : tellHost({ intake: tellIntake, token: await tellToken(home), port: tellConfig.port, ...(positionIntake === undefined ? {} : { position: positionIntake }) });
  if (tell !== undefined) out.log("The intake of the messages of the operator is on the loopback address.");
  if (positionIntake !== undefined) out.log(`The intake of the fixes of the moving places is on the same listener. It has the last fixes of ${countOf(positionIntake.fixes().size, "place")}.`);

  // The built local page. The line tells the state of the page, and it holds no path.
  const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
  const page = pageFolder(runtimeRoot);
  out.log(pageWarning(await readPageState(runtimeRoot)) ?? "The API serves the local page at the path /.");

  // The service closes the log, the store of shapes and the sessions of the sources in its shutdown.
  const service = declare({
    port: port("PORT", 8080),
    probePort: port("PROBE_PORT", 9090),
    profile,
    loop: instance.loop,
    log,
    shapes: instance.shapes,
    ...(instance.transit === undefined ? {} : { transit: instance.transit }),
    quotas,
    readings,
    ...(snapshot.store === undefined ? {} : { startSnapshot: snapshot.store }),
    sources: instance.runtime,
    map: instance.map,
    health: instance.health,
    history: instance.history,
    interests: instance.interests,
    page,
    ...(instance.outage === undefined ? {} : { outage: instance.outage }),
    start: { use: loaded.use, reasons: loaded.fallback.length },
    exchange,
    ...(tell === undefined ? {} : { tell }),
    home: held.lock,
    telemetry,
  });
  return service;
}

/**
 * The mode `key` (AL-169) prints the context key of the fold for each set of a start. The sets are the private files and
 * the last good set. The mode holds no lock of the home folder and writes no file, thus a live runtime can operate next to
 * it. A stage starts it with the code of each slot, and it tells when the next start folds the whole log.
 */
async function keyMode(): Promise<void> {
  const name = process.env["SERVICE_PROFILE"] ?? "local";
  const home = alertsHome(process.env, process.cwd());
  const checkOf: CheckOf = name === "daemon" ? daemonCheck : instanceCheck;
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  const none = { write: () => Promise.resolve(), remove: () => Promise.resolve() };
  const keyOf = async (pick: StartUse): Promise<string> => {
    const loaded = await startConfig(files, checkOf, none, pick);
    const config = loaded.parsed;
    const tellConfig = config.config.tell;
    const tell = tellConfig === undefined ? undefined : createTellIntake({ config: tellConfig, recipients: config.recipients, now: () => wallClock().now() });
    const options = { config, secret: envSecrets(loaded.keys), transport: fetchTransport({ userAgent: userAgent(config.config.contact) }), transit: openTransitCache(join(home, TRANSIT_FILE)), copy: loaded.copy, ...(tell === undefined ? {} : { tell }) };
    return instanceContextKey(options, realClock, wallClock());
  };
  const good = existsSync(join(home, GOOD_FILE)) ? await keyOf("good") : null;
  // One line of JSON on the standard output. The stage reads the last line.
  process.stdout.write(`${JSON.stringify({ files: await keyOf("files"), good })}\n`);
}

const MODES = ["supervise", "load", "fold", "key"];
// The set of the mode fold: `files`, `good`, or no argument for the set of the next start (AL-169).
function foldPick(argument: string | undefined): StartUse | undefined {
  if (argument === undefined || argument === "files" || argument === "good") return argument;
  throw new Error(`The set of the fold is "${argument}". Give files, good, or no argument for the set of the next start.`);
}
const mode = process.argv[2];
if (mode !== undefined && !MODES.includes(mode)) throw new Error(`The first argument is "${mode}". Give no argument for the runtime, or one of: ${MODES.join(", ")}.`);

// The static imports above loaded each module. Thus `load` stops here, before a service starts.
if (mode === "load") {
  out.log("Each module of the runtime loads.");
  process.exit(0);
}

if (mode === "key") {
  await keyMode();
  process.exit(0);
}

// A supervisor or a runtime with an open inspector signal tells so at each start (AL-93).
const signal = signalWarning();
if (signal !== null) out.warn(signal);

// The process exits after the shutdown of the service.
const started = mode === "supervise" ? supervisor(process.argv[3]) : await runtime(mode === "fold", mode === "fold" ? foldPick(process.argv[3]) : undefined);
// The mode fold has no service. Its timers of the telemetry and of the watches end with the process.
if (started === undefined) {
  await blockWatch?.stop();
  process.exit(0);
}
await started.run();
await blockWatch?.stop();
