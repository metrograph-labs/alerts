import { checkWith, sourceDescriptorSchema } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createFirmsSource, FETCH_INTERVAL_MS, FIRMS_DESCRIPTOR, FIRMS_ORIGIN, HOTSPOT_KIND, MAX_BOXES, MIN_INTERVAL_MS, PRODUCTS, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createFirmsSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createFirmsSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
      mapKey: "k",
    });
    expect(source.describe()).toEqual(FIRMS_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a global poll each 10 minutes with a key and the kind of the hotspots, and passes the schema of the core", () => {
    expect(checkWith(sourceDescriptorSchema, FIRMS_DESCRIPTOR).tag).toBe("ok");
    expect(FIRMS_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: [FIRMS_ORIGIN],
      dependsOn: ["provider:nasa-firms"],
      kinds: [HOTSPOT_KIND],
      coverage: "global",
      transport: "poll",
      interval: FETCH_INTERVAL_MS,
      auth: "key",
      uses: ["internet", "dns", "power"],
    });
    // A quiet box is normal: a fire is rare. The canary reads the dates of the data.
    expect(FIRMS_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(FIRMS_DESCRIPTOR.canary).toBeTypeOf("string");
  });

  it("sends at most 49 requests in one interval, far below the limit of 5000 transactions in 10 minutes", () => {
    const requests = 1 + MAX_BOXES * PRODUCTS.length;
    expect(requests).toBe(49);
    expect(requests * MIN_INTERVAL_MS).toBeLessThan(FETCH_INTERVAL_MS);
  });
});
