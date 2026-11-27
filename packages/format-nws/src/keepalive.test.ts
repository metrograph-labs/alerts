import { describe, expect, it } from "vitest";
import { isKeepalive, KEEPALIVE_AWIPS_ID, KEEPALIVE_MAX_AGE_MS, keepaliveCheck } from "./keepalive.ts";

describe("isKeepalive", () => {
  it("finds the keepalive from its identifier or from its AWIPS id", () => {
    expect(isKeepalive("urn:oid:2.49.0.1.840.0-KEEPALIVE-16989", [])).toBe(true);
    expect(isKeepalive("urn:oid:2.49.0.1.840.0-keepalive-1", [])).toBe(true);
    expect(isKeepalive(undefined, [KEEPALIVE_AWIPS_ID])).toBe(true);
    expect(isKeepalive("urn:oid:2.49.0.1.840.0.c31d.001.1", ["kepwbc "])).toBe(true);
    expect(isKeepalive("urn:oid:2.49.0.1.840.0.c31d.001.1", ["SMWMTR"])).toBe(false);
    expect(isKeepalive(undefined, [])).toBe(false);
  });
});

describe("keepaliveCheck", () => {
  it("passes for a keepalive at most 15 minutes old at its fetch", () => {
    expect(KEEPALIVE_MAX_AGE_MS).toBe(15 * 60_000);
    expect(keepaliveCheck({ sent: 0, fetched: 6_000 })).toEqual({ pass: true, reason: "the newest keepalive message of the NWS is 0.1 minutes old", age: 6_000, limit: KEEPALIVE_MAX_AGE_MS });
    expect(keepaliveCheck({ sent: 0, fetched: KEEPALIVE_MAX_AGE_MS }).pass).toBe(true);
    expect(keepaliveCheck({ sent: 0, fetched: KEEPALIVE_MAX_AGE_MS + 60_000 })).toEqual({
      pass: false,
      reason: "the newest keepalive message of the NWS is 16.0 minutes old: the limit is 15 minutes",
      late: true,
      age: KEEPALIVE_MAX_AGE_MS + 60_000,
      limit: KEEPALIVE_MAX_AGE_MS,
    });
    expect(keepaliveCheck(undefined)).toEqual({ pass: false, reason: "the fetch has no keepalive message of the NWS" });
  });
});
