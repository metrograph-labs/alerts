import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as sqlite from "node:sqlite";
import { openMeasuredRuntime } from "@mark1russell7/alerts-runtime";
import { wallClock } from "@mark1russell7/algebra/clock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChannels } from "./fake-channels.ts";
import { createFakeFeeds } from "./fake-feeds.ts";
import { startFake } from "./fake-server.ts";
import { readSeedRecord, seedHome } from "./seed-home.ts";

/**
 * The gate of the writes of a start to the log (AL-151). A start with live alerts writes the events of its first pass in a
 * count of transactions that does not grow with the live alerts. Each event goes through the one prepared insert of the
 * log. The count run of AL-151 gave 21 transactions with no alert, and 25 with 60, 1,000 or 4,000 alerts, with 1 or 10
 * persons. The time of the start is in the bytes of each commit and in the checkpoint after it, not in the count of
 * statements. The CPU profile of `measure-start.yml` in CI gives that time.
 */
const LOG_FILE = "runtime.sqlite";
const MINUTE = 60_000;
const SPAN = 10 * MINUTE;
const PERSONS = 2;
/** The highest count of write transactions on the log in one start. The count run gave 25. */
const TRANSACTIONS_LIMIT = 25;
/** The highest count of statements, apart from the statements of a transaction, that a start runs with `exec` on the log. */
const EXECS_LIMIT = 10;

/** The counts of the calls on the connection of the log in one start. */
interface StartWrites {
  readonly live: number;
  /** The count of `BEGIN` statements: the write transactions. */
  readonly transactions: number;
  /** The count of the other statements of `exec`, apart from `COMMIT`, `ROLLBACK` and the savepoints. */
  readonly execs: number;
  /** The count of the prepared statements. */
  readonly prepares: number;
  /** The count of the runs of the insert of an event. */
  readonly inserts: number;
}

// The class of a connection of `node:sqlite`: `Database` from Node.js 26.11, else `DatabaseSync`.
const module = sqlite as unknown as Record<string, { readonly prototype: object } | undefined>;
const Connection = (module["Database"] ?? module["DatabaseSync"])!;
const Statement = module["StatementSync"]!;
const TRANSACTION_END = /^(COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "start-writes-"));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

// This function seeds a home, starts it with the live alerts of the fake feeds, and counts the calls on the log until the end of the first pass.
async function startWrites(alerts: number): Promise<StartWrites> {
  const home = join(dir, `home-${String(alerts)}`);
  await seedHome(home, { log: 300_000, seed: "al-151", files: { shapes: 200_000, transit: 100_000 }, levels: { feeds: 0, persons: PERSONS, incidents: 0 } });
  const at = readSeedRecord(home).end + MINUTE;
  const feeds = createFakeFeeds({ streams: alerts === 0 ? [] : [{ kind: "event", perSecond: (alerts * 1000) / SPAN, eventBytes: 400 }], start: at - SPAN, seed: "al-151" });
  const servers = [await startFake(feeds.handler), await startFake(createFakeChannels().handler)];
  const counts = { transactions: 0, execs: 0, prepares: 0, inserts: 0 };
  const onLog = (db: unknown): boolean => {
    const location = (db as { location(): string | null }).location();
    return location !== null && basename(location) === LOG_FILE;
  };
  const exec = Reflect.get(Connection.prototype, "exec") as (this: unknown, sql: string) => unknown;
  const prepare = Reflect.get(Connection.prototype, "prepare") as (this: unknown, sql: string) => unknown;
  const run = Reflect.get(Statement.prototype, "run") as (this: unknown, ...values: unknown[]) => unknown;
  const spies = [
    vi.spyOn(Connection.prototype as { exec: typeof exec }, "exec").mockImplementation(function (this: unknown, sql: string) {
      if (onLog(this)) {
        if (/^BEGIN\b/iu.test(sql.trim())) counts.transactions += 1;
        else if (!TRANSACTION_END.test(sql.trim())) counts.execs += 1;
      }
      return exec.call(this, sql);
    }),
    vi.spyOn(Connection.prototype as { prepare: typeof prepare }, "prepare").mockImplementation(function (this: unknown, sql: string) {
      if (onLog(this)) counts.prepares += 1;
      return prepare.call(this, sql);
    }),
    vi.spyOn(Statement.prototype as { run: typeof run }, "run").mockImplementation(function (this: unknown, ...values: unknown[]) {
      if (/^INSERT INTO events\b/u.test((this as { sourceSQL: string }).sourceSQL)) counts.inserts += 1;
      return run.call(this, ...values);
    }),
  ];
  let fetched = 0;
  try {
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start: at }), startSnapshot: true, transitLimit: 0, services: { feeds: servers[0]!.url, channels: servers[1]!.url } });
    fetched = measured.first.fetched.length;
    await measured.close();
  } finally {
    for (const spy of spies) spy.mockRestore();
    for (const server of servers) await server.close();
  }
  return { live: feeds.counts().live, fetched, ...counts };
}

describe("the writes of a start to the log (AL-151)", () => {
  it("writes the first pass in a count of transactions and statements that does not grow with the live alerts", { timeout: 240_000 }, async ({ annotate }) => {
    // The starts go one after the other: each one has its own home and its own fakes.
    const none = await startWrites(0);
    const few = await startWrites(30);
    const many = await startWrites(120);
    await annotate(JSON.stringify({ none, few, many }));
    // A start with fewer live alerts than half of the count tells nothing: the feeds or the fetch failed.
    expect(few.live).toBeGreaterThan(15);
    expect(many.live).toBeGreaterThan(60);
    // Each live alert writes events: its observation, and an escalation and a hold for each person.
    expect(many.inserts - few.inserts).toBeGreaterThan(many.live - few.live);
    for (const writes of [none, few, many]) {
      expect(writes.transactions).toBeLessThanOrEqual(TRANSACTIONS_LIMIT);
      expect(writes.execs).toBeLessThanOrEqual(EXECS_LIMIT);
    }
    // Four times the live alerts add no transaction, no statement of `exec` and no prepared statement.
    expect(many.transactions).toBe(few.transactions);
    expect(many.execs).toBe(few.execs);
    expect(many.prepares).toBe(few.prepares);
  });
});
