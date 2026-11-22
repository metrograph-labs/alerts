import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { collectReadings, LAB_READINGS, LabMetricReader } from "./lab-readings.ts";

const AT = Date.UTC(2026, 10, 22, 18, 0);

function setup() {
  const reader = new LabMetricReader();
  const meter = new MeterProvider({ readers: [reader] }).getMeter("alerts-runtime");
  return { reader, meter };
}

describe("the readings of the lab run (AL-132)", () => {
  it("gives one reading for each sum and each gauge, in the order of the names, at the UTC time of the collection", async () => {
    const { reader, meter } = setup();
    const counter = meter.createCounter("b.counter");
    const gauge = meter.createObservableGauge("a.gauge");
    gauge.addCallback((result) => result.observe(7));
    meter.createHistogram("c.histogram").record(3);
    counter.add(2, { kind: "one" });
    counter.add(5, { kind: "two" });
    const collection = await collectReadings(reader, AT);
    expect(collection).toEqual({
      readings: [
        { series: "a.gauge", at: "2026-11-22T18:00:00.000Z", value: 7 },
        // The value of a series is the sum of its points over all attributes. A histogram has no reading.
        { series: "b.counter", at: "2026-11-22T18:00:00.000Z", value: 7 },
      ],
      errors: 0,
    });
    counter.add(1);
    expect((await collectReadings(reader, AT + 60_000)).readings.find((reading) => reading.series === "b.counter")).toEqual({ series: "b.counter", at: "2026-11-22T18:01:00.000Z", value: 8 });
    expect(LAB_READINGS).toBe("lab-readings");
  });

  it("counts a callback that throws as an error, and gives the other readings", async () => {
    const { reader, meter } = setup();
    meter.createCounter("a.counter").add(0);
    meter.createObservableGauge("b.gauge").addCallback(() => {
      throw new Error("The level read failed.");
    });
    const collection = await collectReadings(reader, AT);
    expect(collection.errors).toBe(1);
    expect(collection.readings).toEqual([{ series: "a.counter", at: "2026-11-22T18:00:00.000Z", value: 0 }]);
  });
});
