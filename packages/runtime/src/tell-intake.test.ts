import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWith, CONFIG_FORMAT, reportSchema, type AlertConfig, type PersonId, type PlaceId, type Recipient, type Report, type TellConfig } from "@mark1russell7/alerts";
import { embeddedProcess, service, type ServiceBuilder } from "@mark1russell7/service";
import { ms, seconds } from "@procedures/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTellIntake,
  mapTell,
  readTellToken,
  TELL_BASE_PATH,
  TELL_DESCRIPTOR,
  TELL_TOKEN_FILE,
  TELL_TOKEN_LENGTH,
  tellCall,
  tellObservation,
  tellSource,
  tellToken,
  TellRefusal,
  type TellIntake,
} from "./tell-intake.ts";
import { createPositionIntake } from "./position-intake.ts";
import { runtimeHost } from "./procedures-host.ts";
import { TELL_LIFE, type TellEvent } from "./tell-message.ts";

const T0 = Date.UTC(2026, 10, 19, 18, 0);
const TOKEN = "fake-tell-token-".padEnd(TELL_TOKEN_LENGTH, "0");
const OTHER_TOKEN = "fake-other-token-".padEnd(TELL_TOKEN_LENGTH, "1");
const PHONE = "https://site.example.net:10000";
const CONFIG: TellConfig = { port: 0, dailyCap: 3, site: { local: "http://127.0.0.1:4000", phone: PHONE } };
const PEOPLE: readonly Recipient[] = [
  { watch: { person: "operator" as PersonId, places: [], rules: [], subjects: [{ system: "alerts.source" }] }, policies: [], addresses: {} },
  { watch: { person: "guest" as PersonId, places: [], rules: [] }, policies: [], addresses: {} },
];
const ASK: TellEvent = { class: "needs-you", item: "AL-92", text: "The deploy waits for your restart." };

const intakeAt = (now: { at: number }, config: TellConfig = CONFIG): TellIntake => createTellIntake({ config, recipients: PEOPLE, now: () => now.at });

const refusal = (take: () => unknown): TellRefusal => {
  try {
    take();
  } catch (error) {
    if (error instanceof TellRefusal) return error;
    throw error;
  }
  throw new Error("The intake took the message.");
};

describe("the intake of the messages of the operator (AL-92)", () => {
  it("takes a message for the operator, and gives the count of persons and the form of the link", () => {
    const intake = intakeAt({ at: T0 });
    expect(intake.take(ASK)).toEqual({ persons: 1, link: "none" });
    expect(intake.take({ ...ASK, url: "/a/graph/" })).toEqual({ persons: 1, link: "phone" });
    expect(intake.take({ ...ASK, url: "https://example.com/" })).toEqual({ persons: 1, link: "same" });
    const drained = intake.drain();
    expect(drained.map((draft) => [draft.persons, draft.url])).toEqual([
      [["operator"], undefined],
      [["operator"], `${PHONE}/a/graph/`],
      [["operator"], "https://example.com/"],
    ]);
    // Each message gets a later time than the message before it, also at the same time of the clock.
    expect(drained.map((draft) => draft.received)).toEqual([T0, T0 + 1, T0 + 2]);
    expect(intake.drain()).toEqual([]);
  });

  it("refuses a person that the configuration does not have and a loopback link that a phone cannot open, with the code BAD_REQUEST", () => {
    const intake = intakeAt({ at: T0 });
    const stranger = refusal(() => intake.take({ ...ASK, to: ["a-stranger"] }));
    expect(stranger.code).toBe("BAD_REQUEST");
    expect(stranger.message).not.toContain("a-stranger");
    expect(refusal(() => intake.take({ ...ASK, url: "http://127.0.0.1:9999/a/" })).code).toBe("BAD_REQUEST");
    expect(intake.drain()).toEqual([]);
  });

  it("refuses a message after the daily cap with the code TOO_MANY_REQUESTS, and takes messages again after 24 hours", () => {
    const now = { at: T0 };
    const intake = intakeAt(now);
    for (let index = 0; index < 3; index += 1) intake.take(ASK);
    expect(refusal(() => intake.take(ASK)).code).toBe("TOO_MANY_REQUESTS");
    now.at = T0 + TELL_LIFE;
    expect(intake.take(ASK)).toEqual({ persons: 1, link: "none" });
    expect(intake.drain()).toHaveLength(4);
  });
});

describe("the source tell (AL-92)", () => {
  it("gives one observation for each message with a report, and the map gives reports that the schema takes", async () => {
    const now = { at: T0 };
    const intake = intakeAt(now);
    const logged: Report[] = [];
    const source = tellSource(intake, () => logged, () => now.at);
    expect(source.describe()).toBe(TELL_DESCRIPTOR);
    intake.take(ASK);
    // The same facts in the same fetch give no second report.
    intake.take(ASK);
    const first = await source.fetch({ watch: undefined as never });
    if (!first.ok) throw new Error("The fetch failed.");
    expect(first.observations).toHaveLength(1);
    const mapped = source.map({ observation: first.observations[0] as never });
    expect(mapped.problems).toEqual([]);
    expect(mapped.reports.map((report) => [report.kind.code, report.op])).toEqual([["system.tell.needs-you", "alert"]]);
    expect(mapped.reports.every((report) => checkWith(reportSchema, report).tag === "ok")).toBe(true);
    logged.push(...mapped.reports);
    // A later fetch reads the lines from the reports of the log: the done message cancels the open line.
    now.at = T0 + 60_000;
    intake.take({ class: "done-you-asked", item: "AL-92", text: "The restart is done." });
    const second = await source.fetch({ watch: undefined as never });
    if (!second.ok) throw new Error("The fetch failed.");
    const done = source.map({ observation: second.observations[0] as never });
    expect(done.reports.map((report) => [report.kind.code, report.op, report.references])).toEqual([
      ["system.tell.done-you-asked", "alert", []],
      ["system.tell.needs-you", "cancel", [mapped.reports[0]?.key]],
    ]);
  });

  it("gives a fatal problem for a body of another format and for a report that the schema refuses", () => {
    const wrong = { ...tellObservation([], T0), body: JSON.stringify({ format: "other/1", reports: [] }) };
    expect(mapTell(wrong).problems).toEqual([expect.objectContaining({ fatal: true })]);
    const bad = { ...tellObservation([], T0), body: JSON.stringify({ format: "alerts-tell/1", reports: [{ id: "x" }] }) };
    expect(mapTell(bad)).toEqual({ reports: [], problems: [expect.objectContaining({ path: "reports[0]", fatal: true })] });
  });
});

/** A service with short stages, as in the test of the exchange host. */
function serviceOf(name: string): ServiceBuilder {
  return service(name)
    .readiness({ type: "debounce", interval: seconds(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: seconds(45) })
    .startup(seconds(10))
    .phase("fail readiness", ms(10))
    .phase("stop intake", ms(500))
    .phase("drain", ms(1000))
    .phase("close transports", ms(500))
    .phase("stop the poller", ms(100))
    .phase("tear down dependencies", ms(500))
    .phase("close the health server", ms(100))
    .cooperativeWindow(ms(500))
    .onRepeatSignal("ignore");
}

describe("the host of the intake (AL-92)", () => {
  it("takes a call with the token, refuses a call with another token, and gives the reason of a refusal", async () => {
    const intake = intakeAt({ at: T0 });
    const host = runtimeHost({ tell: { intake, token: TOKEN, port: 0 } });
    const life = await host.declare(serviceOf("tell-test")).run({ process: embeddedProcess() });
    try {
      const address = host.info.endpoints().find((endpoint) => endpoint.type === "http")?.address;
      if (address === undefined) throw new Error("The host has no HTTP endpoint.");
      expect(address.endsWith(TELL_BASE_PATH)).toBe(true);
      const port = Number(new URL(address).port);
      expect(new URL(address).hostname).toBe("127.0.0.1");
      expect(await tellCall({ port, token: TOKEN })(ASK)).toEqual({ persons: 1, link: "none" });
      await expect(tellCall({ port, token: OTHER_TOKEN })(ASK)).rejects.toThrow();
      await expect(tellCall({ port, token: TOKEN })({ ...ASK, url: "http://localhost:9999/" })).rejects.toThrow(/loopback/u);
      expect(intake.drain()).toHaveLength(1);
    } finally {
      await life.shutdown("the test ended");
      expect(await life.done).toBe(0);
    }
  });

  it("takes a fix of the phone with the token as a Basic password or a Bearer token, and refuses another password (AL-40)", async () => {
    const config: AlertConfig = {
      format: CONFIG_FORMAT,
      places: [{ id: "place-moving" as PlaceId, label: "Phone", codes: [{ system: "state", code: "TX" }], bufferKm: 5, moving: { device: "ph", maxAgeMinutes: 30 } }],
      people: [],
      contacts: [],
      policies: [],
    };
    const position = createPositionIntake({ config });
    const host = runtimeHost({ tell: { intake: intakeAt({ at: T0 }), token: TOKEN, port: 0, position } });
    const life = await host.declare(serviceOf("position-test")).run({ process: embeddedProcess() });
    try {
      const address = host.info.endpoints().find((endpoint) => endpoint.type === "http")?.address;
      if (address === undefined) throw new Error("The host has no HTTP endpoint.");
      // The URL of the phone: the base path of the intake, then the path of the procedure.
      const url = `${address}/alerts/position`;
      const send = (authorization: string, tst: number) =>
        fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ _type: "location", lat: 28.301234, lon: -98.551234, acc: 20, tst, tid: "ph" }) });
      const basic = (password: string): string => `Basic ${Buffer.from(`phone:${password}`).toString("base64")}`;
      const tst = Math.floor(T0 / 1000);
      const byBasic = await send(basic(TOKEN), tst);
      expect(byBasic.status).toBe(200);
      expect(await byBasic.json()).toEqual([]);
      expect(position.fixes().get("place-moving" as PlaceId)?.observedAt).toBe(tst * 1000);
      const byBearer = await send(`Bearer ${TOKEN}`, tst + 60);
      expect(byBearer.status).toBe(200);
      expect(position.fixes().get("place-moving" as PlaceId)?.observedAt).toBe((tst + 60) * 1000);
      const wrong = await send(basic(OTHER_TOKEN), tst + 120);
      expect(wrong.status).toBe(401);
      expect(position.fixes().get("place-moving" as PlaceId)?.observedAt).toBe((tst + 60) * 1000);
      // An unknown device gives the code BAD_REQUEST, and the answer holds no position.
      const unknown = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: basic(TOKEN) }, body: JSON.stringify({ _type: "location", lat: 28.301234, lon: -98.551234, acc: 20, tst, tid: "zz" }) });
      expect(unknown.status).toBe(400);
      const text = await unknown.text();
      expect(text).toContain("No moving place has this device.");
      expect(text).not.toContain("98.55");
      // The message tool keeps its Bearer token.
      expect(await tellCall({ port: Number(new URL(address).port), token: TOKEN })(ASK)).toEqual({ persons: 1, link: "none" });
    } finally {
      await life.shutdown("the test ended");
      expect(await life.done).toBe(0);
    }
  });

  it("refuses a token shorter than the least length", () => {
    expect(() => runtimeHost({ tell: { intake: intakeAt({ at: T0 }), token: "short", port: 0 } })).toThrow(/fewer than/u);
  });
});

describe("the token of the intake (AL-92)", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });
  const home = async (): Promise<string> => {
    const made = await mkdtemp(join(tmpdir(), "alerts-tell-"));
    homes.push(made);
    return made;
  };

  it("makes the file at the first call, and gives the same token at each later call", async () => {
    const folder = await home();
    expect(await readTellToken(folder)).toBeUndefined();
    const token = await tellToken(folder);
    expect(token.length).toBeGreaterThanOrEqual(TELL_TOKEN_LENGTH);
    expect(await tellToken(folder)).toBe(token);
    expect((await readFile(join(folder, TELL_TOKEN_FILE), "utf8")).trim()).toBe(token);
    // Only the user of the file can read it. Windows has no such mode bits.
    if (process.platform !== "win32") expect((await stat(join(folder, TELL_TOKEN_FILE))).mode & 0o777).toBe(0o600);
  });

  it("refuses a file with a short token", async () => {
    const folder = await home();
    await writeFile(join(folder, TELL_TOKEN_FILE), "short\n");
    await expect(tellToken(folder)).rejects.toThrow(/fewer than/u);
  });
});
