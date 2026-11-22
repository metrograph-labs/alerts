import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { ChannelId } from "@mark1russell7/alerts";
import { SqliteHostStateStore } from "polite-crawler";
import { memoryQuotaStore, quotaGate, type QuotaStore } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { balanceWatch, spendGates, spendNotes, spendQuota, spendUnits, spendWatch, type BalanceReading, type BalanceWatchOptions, type SpendReading, type SpendWatchOptions } from "./balance.ts";

const T0 = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CALL = "twilio-call" as ChannelId;

function watchOf(read: BalanceWatchOptions["read"], extra: Partial<BalanceWatchOptions> = {}) {
  return balanceWatch({ provider: "provider:twilio", title: "Twilio", channels: [CALL], floors: [5], read, ...extra });
}

// A reader that gives the next answer of a list, and counts its reads.
function scripted(answers: readonly (BalanceReading | Error)[]) {
  let reads = 0;
  const read = async (): Promise<BalanceReading> => {
    const answer = answers[Math.min(reads, answers.length - 1)]!;
    reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, reads: () => reads };
}

const ok = (balance: number): BalanceReading => ({ ok: true, balance, currency: "USD" });

describe("the balance watch", () => {
  it("reads at the first check, then once a day, and gives the watch as data of the core", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(12.5), ok(3)]);
    const watch = watchOf(reader.read);
    expect(watch.balance()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
    await watch.check(clock);
    expect(watch.balance()).toEqual({ provider: "provider:twilio", title: "Twilio", channels: [CALL], floors: [5], maxAge: 2 * DAY, since: T0, read: { balance: 12.5, currency: "USD", at: T0 } });
    expect(watch.nextReadAt()).toBe(T0 + DAY);
    await clock.advance(DAY - 1);
    await watch.check(clock);
    expect(reader.reads()).toBe(1);
    await clock.advance(1);
    await watch.check(clock);
    expect(reader.reads()).toBe(2);
    expect(watch.balance()?.read).toEqual({ balance: 3, currency: "USD", at: T0 + DAY });
  });

  it("keeps the last read after a failure, a throw, a bad answer or a timeout, and reads again after the retry", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(9), { ok: false, message: "The key is not valid." }, new Error("The network is down."), { ok: true, balance: Number.NaN, currency: "USD" }, { ok: true, balance: 1, currency: "usd" }, ok(8)]);
    const watch = watchOf(reader.read);
    await watch.check(clock);
    const failures: (string | undefined)[] = [];
    for (let day = 1; day <= 5; day += 1) {
      await clock.advance(day === 1 ? DAY : HOUR);
      await watch.check(clock);
      failures.push(watch.failure());
      expect(watch.balance()?.read?.balance).toBe(day === 5 ? 8 : 9);
    }
    expect(failures).toEqual([
      "The key is not valid.",
      "The read of the balance failed: The network is down.",
      "The read of the balance gave no finite balance or no currency code.",
      "The read of the balance gave no finite balance or no currency code.",
      undefined,
    ]);
    expect(reader.reads()).toBe(6);

    const hanging = watchOf((signal) => new Promise<BalanceReading>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }))), { limit: 5_000 });
    const running = hanging.check(clock);
    await clock.advance(5_000);
    await running;
    expect(hanging.failure()).toBe("The read of the balance took longer than 5000 ms.");
    expect(hanging.nextReadAt()).toBe(clock.now() + HOUR);
  });

  it("aborts the read at the stop, and keeps no failure of it", async () => {
    const clock = fakeWallClock(T0);
    let seen: AbortSignal | undefined;
    const watch = watchOf((signal) => {
      seen = signal;
      return new Promise<BalanceReading>((resolve) => {
        if (signal.aborted) resolve({ ok: false, message: "aborted" });
        signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }));
      });
    });
    const stop = new AbortController();
    const running = watch.check(clock, stop.signal);
    stop.abort(new Error("shutdown"));
    await running;
    expect(seen?.aborted).toBe(true);
    expect(watch.failure()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
  });

  it("starts one read for two checks at the same time", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(9)]);
    const watch = watchOf(reader.read);
    await Promise.all([watch.check(clock), watch.check(clock)]);
    expect(reader.reads()).toBe(1);
  });

  it("refuses a watch with no channel, no floor, a floor that is not a number or a time that is not valid", () => {
    const read = scripted([ok(1)]).read;
    expect(() => watchOf(read, { channels: [] })).toThrow("has no channel");
    expect(() => watchOf(read, { floors: [5, Number.NaN] })).toThrow("not a number");
    expect(() => watchOf(read, { floors: [] })).toThrow("no floor");
    for (const extra of [{ every: 0 }, { retry: -1 }, { maxAge: 1.5 }, { limit: Number.POSITIVE_INFINITY }]) expect(() => watchOf(read, extra), JSON.stringify(extra)).toThrow("whole count");
  });
});

describe("the spend watch", () => {
  // A cap of 15 US dollars less a fixed cost of 2.15 gives 1285 cents. The month is the month of New York.
  const ZONE = "America/New_York";
  const quota = spendQuota({ name: "Twilio spend", monthlyUsd: 15, fixed: [{ what: "toll-free number", usd: 2.15 }], reserveUsd: 3, timeZone: ZONE });
  // The month of November starts at 00:00 EDT, and the month of December at 00:00 EST.
  const NOVEMBER = Date.UTC(2026, 10, 1, 4);
  const DECEMBER = Date.UTC(2026, 11, 1, 5);
  const spent = (usedUsd: number): SpendReading => ({ ok: true, usedUsd });

  function setup(answers: readonly (SpendReading | Error)[], extra: Partial<SpendWatchOptions> & { readonly at?: number; readonly store?: QuotaStore } = {}) {
    const { at = T0, store = memoryQuotaStore(), ...options } = extra;
    const clock = fakeWallClock(at);
    const gates = spendGates(quota, { key: "twilio:account", store, now: () => clock.now() });
    const froms: number[] = [];
    let reads = 0;
    const read = async (from: number): Promise<SpendReading> => {
      froms.push(from);
      const answer = answers[Math.min(reads, answers.length - 1)]!;
      reads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const watch = spendWatch({ provider: "provider:twilio", gates, timeZone: ZONE, read, ...options });
    return { clock, gates, watch, froms, reads: () => reads };
  }

  it("keeps the own count apart: the gate of the own count gets no read of the provider, and its store keeps it (AL-91)", async () => {
    const store = memoryQuotaStore();
    const { clock, gates, watch } = setup([spent(3.2105)], { store });
    gates.gate.take(4);
    gates.own.take(4);
    await watch.check(clock);
    expect([gates.gate.state().used, gates.own.state().used]).toEqual([322, 4]);
    expect(gates.own.quota.reserve).toBe(0);
    const again = spendGates(quota, { key: "twilio:account", store, now: () => clock.now() });
    expect([again.gate.state().used, again.own.state().used]).toEqual([322, 4]);
  });

  it("gives its health with no amount and no message", async () => {
    const { clock, watch } = setup([spent(3.2105), { ok: false, message: "Twilio did not give the usage totalprice (server)." }]);
    expect(watch.health()).toEqual({ what: "spend of provider:twilio", at: null, failed: false, next: null });
    await watch.check(clock);
    expect(watch.health()).toEqual({ what: "spend of provider:twilio", at: T0, failed: false, next: T0 + HOUR });
    await clock.advance(HOUR);
    await watch.check(clock);
    expect(watch.health()).toEqual({ what: "spend of provider:twilio", at: T0, failed: true, next: T0 + HOUR + 15 * 60_000 });
  });

  it("gives a note for the heartbeat after a failed read, with the provider and no amount", async () => {
    const { clock, watch } = setup([{ ok: false, message: "Twilio did not give the usage totalprice (server): 12.34" }, spent(1)]);
    expect(spendNotes(undefined)).toEqual([]);
    expect(spendNotes(watch)).toEqual([]);
    await watch.check(clock);
    expect(spendNotes(watch)).toEqual(["The last read of the spend of provider:twilio failed. The cap has no usage outside the sends since the last read that passed."]);
    await clock.advance(15 * 60_000);
    await watch.check(clock);
    expect(spendNotes(watch)).toEqual([]);
  });

  it("reads the spend from the start of the month at the first check, then each hour, and makes the count of the gates larger", async () => {
    const { clock, gates, watch, froms, reads } = setup([spent(3.2105), spent(2), spent(4)]);
    expect(watch.nextReadAt()).toBeUndefined();
    gates.gate.take(4);
    await watch.check(clock);
    expect(froms).toEqual([NOVEMBER]);
    expect(watch.spend()).toEqual({ usedUsd: 3.2105, units: 322, at: T0 });
    expect([gates.gate.state().used, gates.lifeSafety.state().used]).toEqual([322, 322]);
    expect(watch.nextReadAt()).toBe(T0 + HOUR);
    await clock.advance(HOUR - 1);
    await watch.check(clock);
    expect(reads()).toBe(1);
    // A smaller spend changes nothing: the count keeps the sends of the gates.
    await clock.advance(1);
    gates.gate.take(4);
    await watch.check(clock);
    expect(gates.gate.state().used).toBe(326);
    await clock.advance(HOUR);
    await watch.check(clock);
    expect(gates.gate.state().used).toBe(400);
    expect(watch.failure()).toBeUndefined();
  });

  it("fills the month for a spend above the cap with no block, and keeps the count for a credit", async () => {
    const full = setup([spent(40)]);
    await full.watch.check(full.clock);
    expect(full.watch.spend()?.units).toBe(4_000);
    expect(full.gates.gate.state()).toMatchObject({ used: 1_285, left: 0 });
    expect(full.gates.gate.state().blockedUntil).toBeUndefined();
    // The month is full, thus life-safety is refused too, as the count of the gates refuses it.
    expect(() => full.gates.lifeSafety.take(4)).toThrow();

    const credit = setup([spent(-1.5)]);
    credit.gates.gate.take(4);
    await credit.watch.check(credit.clock);
    expect(credit.watch.spend()).toEqual({ usedUsd: -1.5, units: 0, at: T0 });
    expect(credit.gates.gate.state().used).toBe(4);
  });

  it("keeps the last read after a failure, a throw, a bad amount or a timeout, and reads again after 15 minutes", async () => {
    const { clock, gates, watch } = setup([spent(1), { ok: false, message: "The key is not valid." }, new Error("The network is down."), spent(Number.NaN), spent(2)]);
    await watch.check(clock);
    const failures: (string | undefined)[] = [];
    for (let step = 1; step <= 4; step += 1) {
      await clock.advance(step === 1 ? HOUR : 15 * 60_000);
      await watch.check(clock);
      failures.push(watch.failure());
      expect(watch.spend()?.usedUsd).toBe(step === 4 ? 2 : 1);
    }
    expect(failures).toEqual(["The key is not valid.", "The read of the spend failed: The network is down.", "The read of the spend gave no finite amount.", undefined]);
    expect(gates.gate.state().used).toBe(200);

    const hanging = spendWatch({
      provider: "provider:twilio",
      gates,
      timeZone: ZONE,
      limit: 5_000,
      read: (_from, signal) => new Promise<SpendReading>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }))),
    });
    const running = hanging.check(clock);
    await clock.advance(5_000);
    await running;
    expect(hanging.failure()).toBe("The read of the spend took longer than 5000 ms.");
    expect(hanging.nextReadAt()).toBe(clock.now() + 15 * 60_000);
  });

  it("takes no read that ends in the next month, and the next read reads the new month", async () => {
    const start = DECEMBER - 1_000;
    const clock = fakeWallClock(start);
    const gates = spendGates(quota, { key: "twilio:account", store: memoryQuotaStore(), now: () => clock.now() });
    const froms: number[] = [];
    const watch = spendWatch({
      provider: "provider:twilio",
      gates,
      timeZone: ZONE,
      read: (from) => {
        froms.push(from);
        return new Promise<SpendReading>((resolve) => clock.after(2_000, () => resolve(spent(5))));
      },
    });
    const running = watch.check(clock);
    await clock.advance(2_000);
    await running;
    expect(watch.failure()).toBe("The month of the cap ended during the read of the spend.");
    expect(watch.spend()).toBeUndefined();
    expect(gates.gate.state().used).toBe(0);
    await clock.advance(15 * 60_000);
    const again = watch.check(clock);
    await clock.advance(2_000);
    await again;
    expect(froms).toEqual([NOVEMBER, DECEMBER]);
    expect(gates.gate.state().used).toBe(500);
  });

  it("gives a failure when the store of the gates fails", async () => {
    const broken: QuotaStore = {
      changeQuota: () => {
        throw new Error("The disk is full.");
      },
    };
    const { clock, watch } = setup([spent(1)], { store: broken });
    await watch.check(clock);
    expect(watch.failure()).toBe("The count of the spend did not take the read: The disk is full.");
    expect(watch.spend()).toBeUndefined();
  });

  it("refuses a time that is not valid and a name that is not a time zone", () => {
    for (const extra of [{ every: 0 }, { retry: -1 }, { limit: 1.5 }]) expect(() => setup([spent(1)], extra), JSON.stringify(extra)).toThrow("whole count");
    expect(() => setup([spent(1)], { timeZone: "Mars/Olympus" })).toThrow("not an IANA time zone");
  });
});

describe("the quota of the spend", () => {
  it("counts cents in the calendar month, and keeps the reserve for life-safety", () => {
    const quota = spendQuota({ name: "Twilio spend", monthlyUsd: 20, reserveUsd: 5, timeZone: "America/Chicago" });
    expect(quota).toEqual({ name: "Twilio spend", limit: 2_000, reserve: 500, window: { kind: "calendar", unit: "month", timeZone: "America/Chicago" } });
    // A gate of polite-crawler takes the quota: 1500 cents before the reserve, so 375 calls at 4 cents.
    const gate = quotaGate(quota, { key: "twilio:account", store: memoryQuotaStore(), now: () => T0 });
    for (let call = 0; call < 375; call += 1) gate.take(spendUnits(0.04));
    expect(gate.state()).toMatchObject({ used: 1_500, left: 0 });
    expect(() => gate.take(spendUnits(0.04))).toThrow();
  });

  it("rounds the cost of a send up to whole cents, after a round to a millionth of a dollar", () => {
    expect([0, 0.0075, 0.01, 0.04, 0.07, 0.1, 0.123, 1.5].map(spendUnits)).toEqual([0, 1, 1, 4, 7, 10, 13, 150]);
    for (const cost of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => spendUnits(cost)).toThrow();
  });

  it("gives two gates on one count: the reserve is only for life-safety, and the file keeps the count across a restart", () => {
    const quota = spendQuota({ name: "Twilio spend", monthlyUsd: 0.2, reserveUsd: 0.08, timeZone: "America/Chicago" });
    const folder = mkdtempSync(join(tmpdir(), "alerts-spend-"));
    try {
      const open = () => new SqliteHostStateStore(join(folder, "quotas.sqlite"));
      const first = open();
      const gates = spendGates(quota, { key: "twilio:account", store: first, now: () => T0 });
      for (let call = 0; call < 3; call += 1) gates.gate.take(4);
      expect(() => gates.gate.take(4)).toThrow();
      gates.lifeSafety.take(4);
      expect([gates.gate.state().used, gates.lifeSafety.state().used]).toEqual([16, 16]);
      first.close();
      // A restart opens the file again. The new gates see the 16 cents, so life-safety has one call left.
      const second = open();
      const again = spendGates(quota, { key: "twilio:account", store: second, now: () => T0 });
      again.lifeSafety.take(4);
      expect(() => again.lifeSafety.take(4)).toThrow();
      expect(again.gate.state()).toMatchObject({ used: 20, left: 0 });
      second.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("takes the fixed costs off the cap in cents, and refuses fixed costs that use all of the cap", () => {
    const fixed = [
      { what: "toll-free number", usd: 2.15 },
      { what: "local number", usd: 1.15 },
    ];
    expect(spendQuota({ name: "Twilio spend", monthlyUsd: 15, fixed, reserveUsd: 3, timeZone: "UTC" })).toMatchObject({ limit: 1170, reserve: 300 });
    expect(spendQuota({ name: "Twilio spend", monthlyUsd: 15, fixed: [], timeZone: "UTC" }).limit).toBe(1500);
    for (const extra of [{ monthlyUsd: 3.3 }, { monthlyUsd: 3 }, { reserveUsd: 11.7 }, { fixed: [{ what: "refund", usd: -1 }] }]) {
      expect(() => spendQuota({ name: "Twilio spend", monthlyUsd: 15, fixed, timeZone: "UTC", ...extra }), JSON.stringify(extra)).toThrow();
    }
  });

  it("refuses a cap of 0 or less, and a reserve that is not below the cap", () => {
    const cap = { name: "Twilio spend", monthlyUsd: 20, timeZone: "UTC" };
    expect(spendQuota(cap).reserve).toBe(0);
    for (const extra of [{ monthlyUsd: 0 }, { monthlyUsd: -5 }, { monthlyUsd: Number.NaN }, { reserveUsd: 20 }, { reserveUsd: -1 }]) {
      expect(() => spendQuota({ ...cap, ...extra }), JSON.stringify(extra)).toThrow();
    }
  });
});
