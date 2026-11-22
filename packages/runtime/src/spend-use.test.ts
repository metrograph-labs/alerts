import type { UseRead } from "@mark1russell7/stack-spend";
import { memoryQuotaStore, type QuotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { spendGates, spendQuota, type SpendRead } from "./balance.ts";
import { spendUseReads, USE_FILE, useFile } from "./spend-use.ts";

const ZONE = "America/Chicago";
// 22:00 on 31 October in Chicago is 03:00 on 1 November in UTC. Thus the date of the reads is in October.
const AT = Date.UTC(2026, 10, 1, 3);
const quota = spendQuota({ name: "Twilio spend", monthlyUsd: 10, reserveUsd: 3, timeZone: ZONE });

function setup(last?: SpendRead) {
  const gates = spendGates(quota, { key: "provider:twilio:spend", store: memoryQuotaStore(), now: () => AT });
  const options = { provider: "provider:twilio", copy: "home", timeZone: ZONE, own: gates.own, spend: () => last };
  return { gates, options };
}

describe("the use reads of a cap", () => {
  it("gives the cost of the own sends of the copy and the last spend of the account, with the dates of the zone", () => {
    const { gates, options } = setup({ usedUsd: 1.2345, units: 124, at: Date.UTC(2026, 9, 15, 12) });
    for (let send = 0; send < 3; send += 1) {
      gates.gate.take(4);
      gates.own.take(4);
    }
    expect(spendUseReads(options, AT)).toEqual([
      { part: "meter:twilio-home", source: "count", amount: 0.12, date: "2026-10-31" },
      { part: "account:twilio", source: "provider", amount: 1.2345, date: "2026-10-15" },
    ]);
  });

  it("gives no read of the account when its last read is in the month before", () => {
    // 23:00 on 30 September in Chicago.
    const { options } = setup({ usedUsd: 5, units: 500, at: Date.UTC(2026, 9, 1, 4) });
    expect(spendUseReads(options, AT)).toEqual([{ part: "meter:twilio-home", source: "count", amount: 0, date: "2026-10-31" }]);
  });

  it("gives the amount 0 for a credit, and no count read when the store of the own gate fails", () => {
    const { options } = setup({ usedUsd: -0.5, units: 0, at: AT - 60_000 });
    const broken: QuotaGate = { ...options.own, state: () => {
      throw new Error("The disk is full.");
    } };
    expect(spendUseReads({ ...options, own: broken }, AT)).toEqual([{ part: "account:twilio", source: "provider", amount: 0, date: "2026-10-31" }]);
  });

  it("refuses a time zone that is not an IANA time zone", () => {
    const { options } = setup();
    expect(() => spendUseReads({ ...options, timeZone: "Nowhere/Town" }, AT)).toThrow("IANA");
  });
});

describe("the file of the use reads", () => {
  const read = (amount: number): readonly UseRead[] => [{ part: "meter:twilio-home", source: "count", amount, date: "2026-10-31" }];
  const textOf = (reads: readonly UseRead[]): string => `${JSON.stringify(reads, null, 2)}\n`;

  it("writes the list when its text changes, one write at a time, and the last text wins", async () => {
    const writes: string[] = [];
    let release: () => void = () => undefined;
    const write = async (text: string): Promise<void> => {
      writes.push(text);
      if (writes.length === 1) await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const file = useFile({ write, onError: () => undefined });
    file.update(read(0.04));
    file.update(read(0.08));
    file.update(read(0.12));
    expect(writes).toEqual([textOf(read(0.04))]);
    release();
    await file.idle();
    expect(writes).toEqual([textOf(read(0.04)), textOf(read(0.12))]);
    file.update(read(0.12));
    await file.idle();
    expect(writes).toHaveLength(2);
    expect(USE_FILE).toBe("use.json");
  });

  it("gives the error of a failed write to its handler, and writes the same text again at the next update", async () => {
    const writes: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const write = async (text: string): Promise<void> => {
      writes.push(text);
      if (fail) throw new Error("The disk is full.");
    };
    const file = useFile({ write, onError: (error) => errors.push(error) });
    file.update(read(0.04));
    await file.idle();
    expect(errors).toHaveLength(1);
    fail = false;
    file.update(read(0.04));
    await file.idle();
    file.update(read(0.04));
    await file.idle();
    expect(writes).toHaveLength(2);
  });

  it("writes again after a handler of the error that throws", async () => {
    let writes = 0;
    const write = async (): Promise<void> => {
      writes += 1;
      if (writes === 1) throw new Error("The disk is full.");
    };
    const file = useFile({ write, onError: () => {
      throw new Error("The handler failed.");
    } });
    file.update(read(0.04));
    await file.idle();
    file.update(read(0.04));
    await file.idle();
    expect(writes).toBe(2);
  });
});
