import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { embeddedProcess, lint, localDev } from "@mark1russell7/service";
import type { Rule, Scenario } from "@mark1russell7/service";
import { fakeWallClock, realClock, wallClock } from "@mark1russell7/algebra/clock";
import { HEALTH_FORMAT, HISTORY_FORMAT, INTERESTS_FORMAT, MAP_FORMAT, type HealthPayload, type HistoryPayload, type Instant, type InterestsPayload, type MapPayload, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { EXCHANGE_FORMAT } from "./exchange.ts";
import { EXCHANGE_TOKEN_LENGTH, exchangeHost } from "./exchange-http.ts";
import { EXCHANGE_WORKER, PAGE_INDEX, PROFILES, STOP_MESSAGE, createLoop, declare, outageDeployWorker, statusOf, type Pass, type Status } from "./index.ts";

const s = (value: number) => ({ value, unit: "s" });

// The caller of lint() gives the rules of the ordering law, as data. These are the drain rules O10 and O16, as @mark1russell7/kind gives them.
const O10: Rule = {
  id: "O10",
  rule: "the preStop sleep plus the shutdown of the process fits in the grace period",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "process_drain_time", coef: 1, at: "process" },
      ],
    },
    op: "<=",
    rhs: { terms: [{ knob: "termination_grace", coef: 1, at: "pod" }] },
  },
};
const O16: Rule = {
  id: "O16",
  rule: "the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep",
  expr: {
    lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
    op: "<",
    rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
  },
  expr_more: [
    {
      lhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      op: "<",
      rhs: {
        terms: [
          { knob: "termination_grace", coef: 1, at: "pod" },
          { knob: "prestop_sleep", coef: -1, at: "pod" },
        ],
      },
    },
  ],
};

// A pod with the default grace of Kubernetes (30 s) and no preStop hook
const POD: Scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(0) },
  probes: { readiness: s(30), liveness: s(30) },
};

/** This function gives a loop whose passes fetch one source and wake one minute later. */
const loopOf = () => {
  const wall = wallClock();
  return createLoop({
    clock: realClock,
    wall,
    times: { passLimit: 1000, retryBase: 1000, retryCap: 1000 },
    pass: async (): Promise<Pass> => ({ at: wall.now(), fetched: ["nws-api" as SourceId], view: {} as Pass["view"], conflicts: [], wakeAt: wall.now() + 60_000 }),
  });
};

// A map before the first pass: no incident, no place and no region.
const EMPTY_MAP: MapPayload = { format: MAP_FORMAT, at: null, view: { incidents: [], places: [], unshaped: [] }, basemap: [] };
const EMPTY_INTERESTS: InterestsPayload = { format: INTERESTS_FORMAT, people: [] };
const EMPTY_HEALTH: HealthPayload = { format: HEALTH_FORMAT, at: null, now: 0, sources: [], lateness: [], coverage: [], copies: [], quotas: [], balances: [], reads: [], channels: [] };
const historyOf = (since: Instant | null): HistoryPayload => ({ format: HISTORY_FORMAT, at: null, since, next: null, incidents: [], regions: [] });

// The deadline of each wait of the lifecycle test. A busy runner can take some seconds for the start and the first pass.
const WAIT_LIMIT_MS = 20_000;

/** This function waits until the check is true. It throws at the deadline. */
async function waitUntil(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + WAIT_LIMIT_MS;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`The test waited ${String(WAIT_LIMIT_MS)} ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** This function tells if an address answers with a status of 200 to 299. A refused connection is false. */
const answers = (url: string): Promise<boolean> => fetch(url).then((response) => response.ok, () => false);

/** This function gives a free TCP port of the loopback interface. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the declaration of the service", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    it(`passes describe() and lint() with the profile ${name}`, () => {
      // describe() throws when the declaration lacks a policy, the startup budget, the phases or the effect of a second signal
      const description = declare({ port: 0, probePort: 0, profile, loop: loopOf(), log: { close: () => undefined } }).describe();
      expect(description.dependencies.map((dependency) => dependency.name)).toEqual(["home", "log", "shapes", "transit", "quotas", "readings", "start-snapshot", "sources"]);
      expect(description.transports.map((transport) => [transport.kind, transport.name])).toEqual([
        ["server", "http"],
        ["worker", "passes"],
      ]);
      expect(description.checks.map((check) => [check.name, check.gates])).toEqual([["passes.progress", "liveness"]]);
      // A supervisor on Windows stops the service with a message, because the process cannot catch its signal.
      expect(description.shutdown.messages).toEqual([{ match: STOP_MESSAGE, as: "SIGTERM" }]);
      // each rule holds, and no field of the declaration is missing (a "depends" finding of the rule "declaration")
      const findings = lint(description, POD, [O10, O16]);
      expect(findings.map((finding) => [finding.rule, finding.verdict])).toEqual([
        ["O10", "holds"],
        ["O16", "holds"],
        ["unit-bound", "holds"],
        ["close-bound", "holds"],
      ]);
    });
  }

  it("declares the routes GET /map, GET /health, GET /history and GET /interests only with their functions", () => {
    const routes = (map?: () => MapPayload, health?: () => HealthPayload, history?: (since: Instant | null) => HistoryPayload, interests?: () => InterestsPayload) =>
      declare({ port: 0, probePort: 0, profile: localDev, loop: loopOf(), log: { close: () => undefined }, map, health, history, interests })
        .describe()
        .controllers.map((controller) => [controller.name, Object.keys(controller.routes)]);
    expect(routes()).toEqual([["api", ["GET /status"]]]);
    expect(routes(() => EMPTY_MAP)).toEqual([["api", ["GET /status", "GET /map"]]]);
    expect(routes(undefined, () => EMPTY_HEALTH)).toEqual([["api", ["GET /status", "GET /health"]]]);
    expect(routes(() => EMPTY_MAP, () => EMPTY_HEALTH)).toEqual([["api", ["GET /status", "GET /map", "GET /health"]]]);
    expect(routes(undefined, undefined, historyOf)).toEqual([["api", ["GET /status", "GET /history"]]]);
    expect(routes(undefined, undefined, undefined, () => EMPTY_INTERESTS)).toEqual([["api", ["GET /status", "GET /interests"]]]);
  });

  it("ends the shutdown of each profile with the stage that stops the context of the traces (AL-133)", () => {
    for (const [name, profile] of Object.entries(PROFILES)) expect([name, profile.phases?.at(-1)?.name]).toEqual([name, "flush the output"]);
  });

  it("declares the worker of the deploy of the outage call beside the passes, and each rule still holds", () => {
    const loop = loopOf();
    const outage = outageDeployWorker({ deploy: async () => ({ ok: false, stage: "service", errors: ["The test makes no deploy."] }), clock: realClock, wall: wallClock(), limit: loop.times.passLimit });
    const description = declare({ port: 0, probePort: 0, profile: PROFILES["pod"]!, loop, log: { close: () => undefined }, outage }).describe();
    expect(description.transports.map((transport) => [transport.kind, transport.name])).toEqual([
      ["server", "http"],
      ["worker", "passes"],
      ["worker", "outage"],
    ]);
    const findings = lint(description, POD, [O10, O16]);
    expect(findings.map((finding) => finding.rule)).toContain("unit-bound");
    expect(findings.filter((finding) => finding.verdict !== "holds")).toEqual([]);
    // The status shows the state of the deploy only for an instance with an outage call.
    expect(statusOf(loop, outage).outage).toEqual({ state: "pending" });
    expect("outage" in statusOf(loop)).toBe(false);
    // The status shows the files of the start, thus a runtime on the last good set is plain to see.
    expect(statusOf(loop, outage, { use: "good", reasons: 1 }).start).toEqual({ use: "good", reasons: 1 });
    expect("start" in statusOf(loop, outage)).toBe(false);
    // The status shows the last read of each other copy, thus a deploy can tell if another copy is up (AL-186).
    const watch = { copy: "b", skewLimit: 2_000, maxAge: 60_000, since: 1, read: { at: 9, skew: 0, sameConfig: true } };
    expect(statusOf(loop, outage, undefined, { watches: () => [watch, { copy: "c", skewLimit: 2_000, maxAge: 60_000, since: 1 }] }).copies).toEqual([
      { copy: "b", readAt: 9 },
      { copy: "c", readAt: null },
    ]);
    expect("copies" in statusOf(loop, outage)).toBe(false);
  });

  it("declares the worker and the host of the exchange together, as a copy with peers and a listener has them", () => {
    // A copy with peers and the address listen has the two parts. Each name of a server or a worker is unique in the service.
    const host = exchangeHost({
      source: {
        runtime: { share: (after) => ({ format: EXCHANGE_FORMAT, copy: "copy-b", log: "started:run-b", after, next: after, head: after, items: [] }) },
        clock: fakeWallClock(0),
        configHash: "0".repeat(64),
      },
      token: "t".repeat(EXCHANGE_TOKEN_LENGTH),
      listen: { host: "127.0.0.1", port: 0 },
    });
    const loop = loopOf();
    const description = declare({ port: 0, probePort: 0, profile: PROFILES["pod"]!, loop, log: { close: () => undefined }, exchange: { loop: loopOf().worker, host } }).describe();
    const names = description.transports.map((transport) => transport.name);
    expect(new Set(names).size).toBe(names.length);
    expect(description.transports.filter((transport) => transport.kind === "worker").map((transport) => transport.name)).toEqual(["passes", EXCHANGE_WORKER]);
    expect(names).toContain("exchange");
    expect(lint(description, POD, [O10, O16]).filter((finding) => finding.verdict !== "holds")).toEqual([]);
  });
});

describe("the lifecycle of the service", () => {
  it("runs the passes, answers the status and the probes, and exits 0 after the shutdown", async () => {
    const port = await freePort();
    const probePort = await freePort();
    // embeddedProcess() adds no signal handler and does not end the process of the test
    const loop = loopOf();
    let closes = 0;
    // The shutdown ends the sessions of the sources first, then it closes the log and releases the lock of the home folder.
    const closed: string[] = [];
    const log = {
      close: () => {
        closes += 1;
        closed.push("log");
      },
    };
    const home = {
      release: () => {
        closed.push("home");
        return Promise.resolve();
      },
    };
    const sources = {
      close: () => {
        closed.push("sources");
        return Promise.resolve();
      },
    };
    // The context of the traces stops in the last stage, flush the output, after the lock of the home folder (AL-82).
    const telemetry = {
      shutdown: () => {
        closed.push("telemetry");
        return Promise.resolve();
      },
    };
    // A built page with one file. The path / gives it.
    const page = await mkdtemp(join(tmpdir(), "alerts-page-"));
    await writeFile(join(page, PAGE_INDEX), "<!doctype html><title>the map</title>");
    // The history route records each value of the query that it gets.
    const asked: (Instant | null)[] = [];
    const history = (since: Instant | null): HistoryPayload => {
      asked.push(since);
      return historyOf(since);
    };
    const life = await declare({ port, probePort, profile: localDev, loop, log, home, sources, telemetry, map: () => EMPTY_MAP, health: () => EMPTY_HEALTH, history, interests: () => EMPTY_INTERESTS, page }).run({ process: embeddedProcess() });
    try {
      // The probe answers after the start of each transport. The worker starts the first pass at the start of the service.
      await waitUntil(() => answers(`http://127.0.0.1:${probePort}/readiness`), "the readiness probe");
      await waitUntil(() => loop.last() !== undefined, "the first pass");
      const status = await fetch(`http://127.0.0.1:${port}/status`);
      expect(status.status).toBe(200);
      const body = (await status.json()) as Status;
      expect(body).toEqual({ at: loop.last()?.at, wakeAt: loop.last()?.wakeAt, fetched: ["nws-api"], sent: 0, conflicts: 0, stuck: null });
      const map = await fetch(`http://127.0.0.1:${port}/map`);
      expect(map.status).toBe(200);
      expect(await map.json()).toEqual(EMPTY_MAP);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual(EMPTY_HEALTH);
      const interests = await fetch(`http://127.0.0.1:${port}/interests`);
      expect(interests.status).toBe(200);
      expect(await interests.json()).toEqual(EMPTY_INTERESTS);
      // The history route gives each incident with no query, and the changes at a time or later with the query since.
      expect(await (await fetch(`http://127.0.0.1:${port}/history`)).json()).toEqual(historyOf(null));
      const later = await fetch(`http://127.0.0.1:${port}/history?since=1800000000000`);
      expect(later.status).toBe(200);
      expect(await later.json()).toEqual(historyOf(1_800_000_000_000));
      // A bad query gets 400 with the problem, and the route does not read the history.
      for (const query of ["since=-1", "since=1.5", "since=01", "since=", "since=1&since=2", "since=99999999999999999"]) {
        const bad = await fetch(`http://127.0.0.1:${port}/history?${query}`);
        expect(bad.status, query).toBe(400);
        expect(((await bad.json()) as { problem: string }).problem, query).toContain("since");
      }
      expect(asked).toEqual([null, 1_800_000_000_000]);
      // The path / gives the page with the policy of the folder. The routes come first, and a path of no file gets 404.
      const home = await fetch(`http://127.0.0.1:${port}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toContain("text/html");
      expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await home.text()).toContain("<title>the map</title>");
      expect((await fetch(`http://127.0.0.1:${port}/hello`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${probePort}/readiness`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${probePort}/liveness`)).status).toBe(200);
      // The log and the sessions of the sources stay open while the service operates.
      expect(closes).toBe(0);
      expect(closed).toEqual([]);
    } finally {
      await life.shutdown("the test ended");
      await rm(page, { recursive: true, force: true });
    }
    expect(await life.done).toBe(0);
    expect(life.errors).toEqual([]);
    expect(closes).toBe(1);
    expect(closed).toEqual(["sources", "log", "home", "telemetry"]);
  }, 3 * WAIT_LIMIT_MS);
});
