import { readFileSync } from "node:fs";
import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, keepaliveSent } from "./check.ts";
import { SOURCE_ID } from "./map.ts";

const read = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const KEEPALIVE = read("nws-keepalive.json");
const SENT = Date.parse(JSON.parse(KEEPALIVE).properties.sent);
const MINUTE = 60_000;

const observe = (body: string, fetched: number): Observation => ({
  id: `observation-${String(fetched)}` as ObservationId,
  source: SOURCE_ID,
  fetched,
  contentType: "application/geo+json",
  body,
  transport: { latency: 0 },
});

describe("keepaliveSent", () => {
  it("reads the sent time of a keepalive, and nothing from an alert", () => {
    expect(keepaliveSent(observe(KEEPALIVE, SENT))).toBe(SENT);
    expect(keepaliveSent(observe(read("nws-flw.json"), SENT))).toBeUndefined();
    expect(keepaliveSent(observe("not json", SENT))).toBeUndefined();
  });
});

describe("checkCanary", () => {
  it("passes when the newest keepalive is recent", () => {
    expect(checkCanary([observe(KEEPALIVE, SENT + 5 * MINUTE)])).toEqual({
      pass: true,
      reason: "the newest keepalive message of the NWS is 5.0 minutes old",
      age: 5 * MINUTE,
      limit: 15 * MINUTE,
    });
  });

  it("fails when the newest keepalive is too old", () => {
    expect(checkCanary([observe(KEEPALIVE, SENT + 20 * MINUTE)])).toMatchObject({ pass: false, late: true });
  });

  it("fails when the fetch has no keepalive", () => {
    expect(checkCanary([observe(read("nws-glw.json"), SENT)])).toEqual({ pass: false, reason: "the fetch has no keepalive message of the NWS" });
    expect(checkCanary([]).pass).toBe(false);
  });

  it("uses the newest keepalive", () => {
    const older = JSON.parse(KEEPALIVE);
    older.properties.sent = new Date(SENT - 30 * MINUTE).toISOString();
    const result = checkCanary([observe(JSON.stringify(older), SENT + MINUTE), observe(KEEPALIVE, SENT + MINUTE)]);
    expect(result.pass).toBe(true);
  });
});
