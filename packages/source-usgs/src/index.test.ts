import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createUsgsSource, EARTHQUAKE_KIND, NUCLEAR_KIND, SOURCE_ID, USGS_BASE_URL, USGS_DESCRIPTOR, USGS_ORIGIN } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createUsgsSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createUsgsSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toBe(USGS_DESCRIPTOR);
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    expect(source.map({ observation: { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } } }).reports).toEqual([]);
  });

  it("describes a snapshot poll of the USGS each minute, with no key", () => {
    expect(USGS_DESCRIPTOR).toMatchObject({
      id: "usgs",
      origins: [USGS_ORIGIN],
      dependsOn: ["provider:usgs", "cdn:cloudfront"],
      kinds: [EARTHQUAKE_KIND, NUCLEAR_KIND],
      transport: "poll",
      interval: 60_000,
      auth: "none",
      uses: ["internet", "dns", "power"],
      listing: "snapshot",
    });
    expect(USGS_DESCRIPTOR.coverage).toContainEqual({ type: "code", system: "iso3166", code: "US" });
    expect(USGS_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(USGS_DESCRIPTOR.canary).toBeUndefined();
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(USGS_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createUsgsSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "" };
      },
      userAgent: "alerts-tests",
    });
    const controller = new AbortController();
    const pending = source.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});
