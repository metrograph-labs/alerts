import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import { CONFIG_FORMAT, parseConfig, type AlertConfig, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId, type SecretLookup, type SpendConfig } from "@mark1russell7/alerts";
import { checkBundleFile, OUTAGE_TEXT_MESSAGE, type TwilioFetch, type TwilioServerlessDeployResult } from "@mark1russell7/alerts-channel-twilio";
import { seedsFrom } from "@mark1russell7/rigor-generators";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANCE_CHANNELS } from "./instance.ts";
import { fileBundleStore, OUTAGE_TOKEN_KEY, outageDeploy, outageDeployWorker, outageMonthCapOf, outageSetup, type OutageDeployOptions, type OutageDeployWorker, type OutageKeys } from "./outage.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 3, 1, 18);

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** This function moves the clock in steps of one second, thus each timer and each deploy ends in its step. */
async function walk(clock: FakeClock, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += SECOND) {
    await clock.advance(Math.min(SECOND, ms - done));
    await settle();
  }
}

// Fake keys, a fake token and fake numbers: the country code +999 has no country. A test looks for the values in each problem.
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;
const pushover = "pushover" as ChannelId;
const call = "twilio-call" as ChannelId;
const TOKEN = "t".repeat(40);
const KEYS: OutageKeys = { credentials: { accountSid: `AC${"0".repeat(32)}`, keySid: `SK${"1".repeat(32)}`, secret: "s".repeat(32) }, from: "+99900000001" };
const SECRETS = { PUSHOVER_USER_KEY: "u".repeat(30), PHONE: "+99900000002", [OUTAGE_TOKEN_KEY]: TOKEN };
const store =
  (values: Readonly<Record<string, string>>): SecretLookup =>
  (name) =>
    values[name];

const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

// A public place in Texas. The outage call reads no place.
const CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [{ id: place, label: "Place", at: [-98.55, 28.3], codes: [{ system: "state", code: "TX" }], bufferKm: 5 }],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [
    { person, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } },
    { person, channel: call, address: { to: { secret: "PHONE" } } },
  ],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
};
// A fake cap of the spend. The monthly cap of the Functions comes from it.
const SPEND: SpendConfig = { provider: "provider:twilio", monthlyUsd: 10, reserveUsd: 3, floor: 5, timeZone: "America/Chicago" };
const withOutage = (steps: readonly ChannelId[], spend: readonly SpendConfig[] = [SPEND]): AlertConfig => ({ ...CONFIG, outage: { people: [{ person, chain: { steps } }] }, spend });

const parse = (config: AlertConfig, secret: SecretLookup) => {
  const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHANNELS, secret);
  if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
  return parsed.value;
};

describe("outageSetup", () => {
  it("gives no setup for a configuration with no outage call", () => {
    expect(outageSetup(parse(CONFIG, store(SECRETS)), store(SECRETS), undefined)).toEqual({ tag: "ok", value: undefined });
  });

  it("gives the keys, the number, the token and the list of the outage call", () => {
    const secret = store(SECRETS);
    const setup = outageSetup(parse(withOutage([call, call]), secret), secret, KEYS);
    if (setup.tag === "err" || setup.value === undefined) throw new Error("The setup has problems.");
    expect(setup.value).toMatchObject({ credentials: KEYS.credentials, from: KEYS.from, token: TOKEN });
    expect(setup.value.list.people).toEqual([{ person, to: SECRETS.PHONE, chain: { steps: [call, call] } }]);
    // 10 US dollars at 4 cents a call give 250 calls in the calendar month of the time zone of the spend.
    expect(setup.value.list.month).toEqual({ maxCalls: 250, timeZone: "America/Chicago" });
  });

  it("gives the text and its sender with the number of the texts in the keys", () => {
    const secret = store(SECRETS);
    const setup = outageSetup(parse(withOutage([call, call]), secret), secret, { ...KEYS, textFrom: "+99900000003" });
    if (setup.tag === "err" || setup.value === undefined) throw new Error("The setup has problems.");
    expect(setup.value.textFrom).toBe("+99900000003");
    expect(setup.value.list.textMessage).toBe(OUTAGE_TEXT_MESSAGE);
    // The number of the person is not on the opt-in list. Thus the person gets no text.
    expect(setup.value.list.people.map((entry) => entry.text)).toEqual([undefined]);
    const yes = { number: { secret: "PHONE" }, at: "2026-11-17T21:30:00Z", way: "written" as const, words: "texts-consent/1" };
    const listed = outageSetup(parse({ ...withOutage([call, call]), optIn: [yes] }, secret), secret, { ...KEYS, textFrom: "+99900000003" });
    if (listed.tag === "err" || listed.value === undefined) throw new Error("The setup has problems.");
    expect(listed.value.list.people.map((entry) => entry.text)).toEqual([true]);
    const none = outageSetup(parse(withOutage([call, call]), secret), secret, KEYS);
    if (none.tag === "err" || none.value === undefined) throw new Error("The setup has problems.");
    expect(none.value).not.toHaveProperty("textFrom");
    expect(none.value.list).not.toHaveProperty("textMessage");
  });

  it("gives the problem of an outage call with no spend entry for Twilio", () => {
    const secret = store(SECRETS);
    const setup = outageSetup(parse(withOutage([call], []), secret), secret, KEYS);
    expect(setup.tag === "err" ? setup.error : []).toEqual([expect.stringContaining("no spend entry for the provider of the calls")]);
  });

  it("gives the monthly cap from the cap of the spend: whole calls of 4 cents, at most the highest cap", () => {
    expect(outageMonthCapOf({ monthlyUsd: 10, timeZone: "UTC" })).toEqual({ maxCalls: 250, timeZone: "UTC" });
    // The cents of a part of a call do not make a call.
    expect(outageMonthCapOf({ monthlyUsd: 0.11, timeZone: "UTC" }).maxCalls).toBe(2);
    expect(outageMonthCapOf({ monthlyUsd: 1000, timeZone: "UTC" }).maxCalls).toBe(1000);
    // A cap below one call gives 0 calls. The list then gives a problem, and no Function deploys.
    expect(outageMonthCapOf({ monthlyUsd: 0.03, timeZone: "UTC" }).maxCalls).toBe(0);
    // The fixed costs come off the cap first: 15 US dollars less 3.30 is 1170 cents, or 292 whole calls.
    expect(outageMonthCapOf({ monthlyUsd: 15, fixed: [{ what: "toll-free number", usd: 2.15 }, { what: "local number", usd: 1.15 }], timeZone: "UTC" }).maxCalls).toBe(292);
    expect(outageMonthCapOf({ monthlyUsd: 3.3, fixed: [{ what: "numbers", usd: 3.3 }], timeZone: "UTC" }).maxCalls).toBe(0);
    const secret = store(SECRETS);
    const low = outageSetup(parse(withOutage([call], [{ ...SPEND, monthlyUsd: 0.03, reserveUsd: 0, floor: 0 }]), secret), secret, KEYS);
    expect(low.tag === "err" ? low.error : []).toContain("The monthly cap of calls is not a whole number from 1 to 1000.");
  });

  it("gives the problems of no keys of Twilio, no token, a token of a bad form and a bad list, and no problem holds a value", () => {
    const config = withOutage([call]);
    const noKeys = outageSetup(parse(config, store(SECRETS)), store(SECRETS), undefined);
    expect(noKeys.tag === "err" ? noKeys.error : []).toEqual([expect.stringContaining("no keys of Twilio")]);
    const empty = store({ ...SECRETS, [OUTAGE_TOKEN_KEY]: "" });
    const noToken = outageSetup(parse(config, empty), empty, KEYS);
    expect(noToken.tag === "err" ? noToken.error : []).toEqual([expect.stringContaining(`no value for ${OUTAGE_TOKEN_KEY}`)]);
    const short = store({ ...SECRETS, [OUTAGE_TOKEN_KEY]: "short-bad-value" });
    const badToken = outageSetup(parse(config, short), short, KEYS);
    expect(badToken.tag === "err" ? badToken.error : []).toEqual([expect.stringContaining(`The value of ${OUTAGE_TOKEN_KEY} is not 32 to 128`)]);
    // The configuration accepts a step on Pushover. The outage call makes only calls, so its list refuses it.
    const badList = outageSetup(parse(withOutage([pushover]), store(SECRETS)), store(SECRETS), KEYS);
    expect(badList.tag === "err" ? badList.error : []).toContainEqual(expect.stringContaining(`uses the channel ${pushover}`));
    for (const result of [noKeys, noToken, badToken, badList]) {
      expect(result.tag).toBe("err");
      expect(JSON.stringify(result)).not.toMatch(/short-bad-value|t{40}|s{32}|\+999/u);
    }
  });
});

type Step = TwilioServerlessDeployResult | Error | "hang";
const DONE: TwilioServerlessDeployResult = { ok: true, changed: true, serviceSid: `ZS${"a".repeat(32)}`, environmentSid: `ZE${"b".repeat(32)}`, domainName: "alerts-outage-1234-prod.twil.io", buildSid: `ZB${"c".repeat(32)}` };
const SAME: TwilioServerlessDeployResult = { ...DONE, changed: false };
const failed = (stage: "build" | "upload"): TwilioServerlessDeployResult => ({ ok: false, stage, errors: [`The ${stage} failed.`] });

const TIMES = { limit: 20 * SECOND, every: 5 * MINUTE, steadyWait: 30 * SECOND, retryBase: 10 * SECOND, retryCap: 40 * SECOND };
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
const running: OutageDeployWorker[] = [];

/**
 * This function starts a worker whose deploys give the steps in order, then `SAME`. The fake clock starts one steady wait
 * before T0. With `steady`, the start is good at once, thus the first deploy comes at T0.
 */
async function start(steps: readonly Step[], more: Partial<OutageDeployOptions> = {}, steady = true) {
  const steadyWait = more.steadyWait ?? TIMES.steadyWait;
  const clock = fakeClock(T0 - steadyWait);
  // The time of the fake clock is also the instant of the test, and the two clocks move together.
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  const script = [...steps];
  const starts: number[] = [];
  const lines: string[] = [];
  const errors: Array<[string, number]> = [];
  const outage = outageDeployWorker({
    ...TIMES,
    clock,
    wall,
    random: () => 0,
    log: (line) => lines.push(line),
    onError: (error, failures) => errors.push([error instanceof Error ? error.message : String(error), failures]),
    deploy: async (signal) => {
      starts.push(clock.now() - T0);
      const step = script.shift() ?? SAME;
      if (step === "hang") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      if (step instanceof Error) throw step;
      return step;
    },
    ...more,
  });
  running.push(outage);
  expect(outage.state()).toEqual({ state: "pending" });
  await outage.worker.start(new AbortController().signal, detachedLifecycle(clock));
  await clock.advance(0);
  await settle();
  if (steady) {
    outage.steady();
    await walk(clock, steadyWait);
  }
  return { clock, outage, starts, lines, errors };
}

afterEach(async () => {
  for (const outage of running.splice(0)) {
    await outage.worker.stopIntake();
    await outage.worker.close();
  }
});

describe("outageDeployWorker", () => {
  it("deploys at the start, then once in each period, and logs only a deploy that changed the Functions", async () => {
    const { clock, outage, starts, lines } = await start([DONE]);
    expect(starts).toEqual([0]);
    expect(outage.state()).toEqual({ state: "current", at: T0, changed: true });
    expect(lines).toEqual(["The deploy of the outage call changed the Functions. The new build is live."]);
    await walk(clock, TIMES.every);
    expect(starts).toEqual([0, TIMES.every]);
    expect(outage.state()).toEqual({ state: "current", at: T0 + TIMES.every, changed: false });
    expect(lines).toHaveLength(1);
  });

  it("waits a backoff that doubles after each failure in sequence, up to its cap, and heals at the next deploy that passes", async () => {
    const { clock, outage, starts, errors } = await start([failed("build"), failed("upload"), new Error("The bundle failed."), failed("build"), DONE]);
    expect(outage.state()).toEqual({ state: "failed", at: T0, stage: "build", failures: 1 });
    await walk(clock, 2 * MINUTE);
    // The waits are 10 s, 20 s, 40 s and 40 s: the cap.
    expect(starts).toEqual([0, 10 * SECOND, 30 * SECOND, 70 * SECOND, 110 * SECOND]);
    expect(errors).toEqual([
      ["The deploy of the outage call failed at the stage build: The build failed.", 1],
      ["The deploy of the outage call failed at the stage upload: The upload failed.", 2],
      ["The deploy of the outage call failed at the stage plan: The bundle failed.", 3],
      ["The deploy of the outage call failed at the stage build: The build failed.", 4],
    ]);
    expect(outage.state()).toEqual({ state: "current", at: T0 + 110 * SECOND, changed: true });
    // After a deploy that passes, the next deploy comes after the period, not after a backoff.
    await walk(clock, TIMES.every);
    expect(starts.at(-1)).toBe(110 * SECOND + TIMES.every);
  });

  it("aborts a deploy at its limit, and the state tells the abort", async () => {
    const { clock, outage, starts } = await start(["hang"]);
    await walk(clock, TIMES.limit + SECOND);
    expect(outage.state()).toMatchObject({ state: "failed", stage: "abort", failures: 1 });
    await walk(clock, TIMES.retryBase);
    expect(starts).toEqual([0, TIMES.limit + TIMES.retryBase]);
    expect(outage.state()).toMatchObject({ state: "current", changed: false });
  });

  it("deploys nothing before the start is good, thus a start that does not get steady leaves the Functions of Twilio as they are (AL-112)", async () => {
    const { clock, outage, starts } = await start([DONE], {}, false);
    await walk(clock, 4 * TIMES.every);
    expect(starts).toEqual([]);
    expect(outage.state()).toEqual({ state: "pending" });
  });

  it("deploys first one steady wait after the good start, and a second call of steady() moves nothing (AL-112)", async () => {
    const { clock, outage, starts } = await start([DONE], {}, false);
    const good = 7 * SECOND;
    await walk(clock, good);
    outage.steady();
    await walk(clock, TIMES.steadyWait - SECOND);
    outage.steady();
    expect(starts).toEqual([]);
    await walk(clock, SECOND);
    // The clock started one steady wait before T0. Thus the deploy at the good start plus the wait is at T0 + good.
    expect(starts).toEqual([good]);
    await walk(clock, TIMES.every);
    expect(starts).toEqual([good, good + TIMES.every]);
  });

  it.each(SEEDS)("never deploys before the good start plus its steady wait, at each time of the good start (seed %i)", async (seed) => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 1, max: 90 }), async (goodSeconds, waitSeconds) => {
        const steadyWait = waitSeconds * SECOND;
        const { clock, outage, starts } = await start([DONE], { steadyWait }, false);
        await walk(clock, goodSeconds * SECOND);
        outage.steady();
        await walk(clock, steadyWait - SECOND);
        expect(starts).toEqual([]);
        await walk(clock, SECOND);
        expect(starts).toEqual([goodSeconds * SECOND]);
        running.splice(running.indexOf(outage), 1);
        outage.worker.stopIntake();
        await outage.worker.close();
      }),
      { numRuns: 10, seed },
    );
  });

  it("refuses a time that is not a whole count of milliseconds above 0, and a cap below the first wait", () => {
    const options = { ...TIMES, clock: fakeClock(T0), wall: { time: "wall", now: () => T0, after: () => () => undefined } as unknown as WallClock, deploy: async () => SAME };
    expect(() => outageDeployWorker({ ...options, limit: 0 })).toThrow("The time limit");
    expect(() => outageDeployWorker({ ...options, every: 1.5 })).toThrow("The time every");
    expect(() => outageDeployWorker({ ...options, steadyWait: 0 })).toThrow("The time steadyWait");
    expect(() => outageDeployWorker({ ...options, retryCap: 5 * SECOND })).toThrow("shorter than its first wait");
  });
});

describe("outageDeploy", () => {
  let folder = "";
  afterEach(async () => {
    if (folder !== "") await rm(folder, { recursive: true, force: true });
    folder = "";
  });

  it("makes the bundles and sends the requests of the deploy through the fetch of the instance", async () => {
    const urls: string[] = [];
    const fetch: TwilioFetch = async (url) => {
      urls.push(url);
      return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate", status: 401 }), headers: { get: () => null } };
    };
    const secret = store(SECRETS);
    const setup = outageSetup(parse(withOutage([call]), secret), secret, KEYS);
    if (setup.tag === "err" || setup.value === undefined) throw new Error("The setup has problems.");
    const deploy = outageDeploy(setup.value, { fetch, clock: fakeClock(T0) });
    const result = await deploy(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, stage: "service" });
    expect(urls).toEqual(["https://serverless.twilio.com/v1/Services/alerts-outage"]);
  }, 30_000);

  it("writes the file of the bundles at the first deploy, and the next deploy reads the file (AL-112)", async () => {
    folder = await mkdtemp(join(tmpdir(), "alerts-outage-bundles-"));
    const bundles = fileBundleStore(join(folder, "build", "outage-bundles.json"));
    expect(await bundles.read()).toBeUndefined();
    const fetch: TwilioFetch = async () => ({ status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate", status: 401 }), headers: { get: () => null } });
    const lines: string[] = [];
    const secret = store(SECRETS);
    const setup = outageSetup(parse(withOutage([call]), secret), secret, KEYS);
    if (setup.tag === "err" || setup.value === undefined) throw new Error("The setup has problems.");
    const deploy = outageDeploy(setup.value, { fetch, clock: fakeClock(T0), bundles, log: (line) => lines.push(line) });
    expect(await deploy(new AbortController().signal)).toMatchObject({ ok: false, stage: "service" });
    expect(lines.filter((line) => line.includes("bundles"))).toEqual([expect.stringContaining("does not exist")]);
    expect((await checkBundleFile(await bundles.read())).ok).toBe(true);
    // The second deploy finds a good file. Thus it gives no line of the bundles, and it starts no esbuild.
    lines.length = 0;
    expect(await deploy(new AbortController().signal)).toMatchObject({ ok: false, stage: "service" });
    expect(lines.filter((line) => line.includes("bundles"))).toEqual([]);
  }, 60_000);
});

// The packages of the workspace, by name. Each package has its entry in `src/index.ts`.
const PACKAGES = new URL("../../", import.meta.url);
const ENTRIES = new Map(
  readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const name = (JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, PACKAGES), "utf8")) as { name: string }).name;
        return [[name, new URL(`${entry.name}/src/index.ts`, PACKAGES).href] as const];
      } catch {
        return [];
      }
    }),
);
// A static import or export of a module. Type imports go away at the load, so they do not count. A dynamic import() does not match.
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/gmu;

/** This function gives the modules of the workspace that a load of the entry loads, and the outside packages that they import. */
function staticGraph(entry: URL): { readonly files: ReadonlySet<string>; readonly outside: ReadonlySet<string> } {
  const files = new Set<string>();
  const outside = new Set<string>();
  const queue = [entry.href];
  for (let href = queue.pop(); href !== undefined; href = queue.pop()) {
    if (files.has(href)) continue;
    files.add(href);
    for (const [, specifier = ""] of readFileSync(new URL(href), "utf8").matchAll(STATIC_IMPORT)) {
      if (specifier.startsWith(".")) queue.push(new URL(specifier, href).href);
      else if (ENTRIES.has(specifier)) queue.push(ENTRIES.get(specifier) ?? "");
      else if ([...ENTRIES.keys()].some((name) => specifier.startsWith(`${name}/`))) throw new Error(`The walk does not read the subpath ${specifier}.`);
      else if (!specifier.startsWith("node:")) outside.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return { files, outside };
}

describe("the load of the bundles (AL-112)", () => {
  it("loads esbuild and the module of the bundles only in the call of a deploy, never in the static load of the entry", () => {
    const graph = staticGraph(new URL("./main.ts", import.meta.url));
    // The walk reaches the deploy, thus a static import of the bundles from it is in the walk.
    expect([...graph.files].some((file) => file.endsWith("/channel-twilio/src/deploy.ts"))).toBe(true);
    expect([...graph.files].filter((file) => file.endsWith("/channel-twilio/src/bundle.ts"))).toEqual([]);
    // The read of the file of the bundles is in the static load. It imports no esbuild.
    expect([...graph.files].some((file) => file.endsWith("/channel-twilio/src/bundle-file.ts"))).toBe(true);
    expect([...graph.outside]).not.toContain("esbuild");
    expect(graph.outside.size).toBeGreaterThan(3);
  });
});
