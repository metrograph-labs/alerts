import { reportId, type Report, type SourceId } from "@mark1russell7/alerts";
import { DataPointType, MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { descriptionBytes, openIncidents, RUNTIME_METRICS, runtimeMetrics, type RuntimeLevels } from "./metrics.ts";

const T0 = Date.UTC(2026, 10, 22, 18, 0);
const SOURCE = "api" as SourceId;

// A reader that collects only when the test asks.
class TestReader extends MetricReader {
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// The value of each sum and each gauge of one collection, by the name of the instrument.
async function values(reader: MetricReader): Promise<Readonly<Record<string, number>>> {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  const out: Record<string, number> = {};
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.dataPointType !== DataPointType.SUM && metric.dataPointType !== DataPointType.GAUGE) continue;
      out[metric.descriptor.name] = metric.dataPoints.reduce((sum, point) => sum + point.value, 0);
    }
  }
  return out;
}

function report(key: string, references: readonly string[], description?: string): Report {
  return {
    id: reportId({ source: SOURCE, key, sent: T0 }),
    source: SOURCE,
    origin: "nws",
    key,
    references,
    correlation: [],
    status: "actual",
    op: references.length === 0 ? "alert" : "update",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: T0,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "nws",
    headline: "Tornado Warning",
    ...(description === undefined ? {} : { description }),
    observation: `obs:${key}` as Report["observation"],
    parameters: {},
  };
}

function setup(levels: () => RuntimeLevels) {
  const reader = new TestReader();
  const meter = new MeterProvider({ readers: [reader] }).getMeter("alerts-runtime");
  return { reader, metrics: runtimeMetrics(meter, levels) };
}

describe("the live metrics of the runtime (AL-132)", () => {
  it("gives each counter at 0 before the first report, and the levels at each collection", async () => {
    let levels: RuntimeLevels = { feeds: 3, persons: 2, incidents: 0 };
    const { reader } = setup(() => levels);
    expect(await values(reader)).toEqual({
      [RUNTIME_METRICS.event]: 0,
      [RUNTIME_METRICS.eventBytes]: 0,
      [RUNTIME_METRICS.update]: 0,
      [RUNTIME_METRICS.updateBytes]: 0,
      [RUNTIME_METRICS.feeds]: 3,
      [RUNTIME_METRICS.persons]: 2,
      [RUNTIME_METRICS.incidents]: 0,
    });
    levels = { feeds: 3, persons: 2, incidents: 4 };
    expect((await values(reader))[RUNTIME_METRICS.incidents]).toBe(4);
  });

  it("counts a report with no reference as an event, a report with a reference as an update, and the bytes of each description", async () => {
    const { reader, metrics } = setup(() => ({ feeds: 0, persons: 1, incidents: 0 }));
    // The letter \u00e9 has 2 bytes in UTF-8, and the emoji has 4.
    metrics.reports([report("a", [], "Take cover."), report("b", [], "Caf\u00e9"), report("c", ["a"], "\u{1F32A} now")]);
    metrics.reports([report("d", ["b"])]);
    const read = await values(reader);
    expect(read[RUNTIME_METRICS.event]).toBe(2);
    expect(read[RUNTIME_METRICS.eventBytes]).toBe(11 + 5);
    expect(read[RUNTIME_METRICS.update]).toBe(2);
    expect(read[RUNTIME_METRICS.updateBytes]).toBe(8);
    // The counters keep the sum of each collection before.
    metrics.reports([report("e", [], "x")]);
    expect((await values(reader))[RUNTIME_METRICS.eventBytes]).toBe(17);
  });

  it("gives 0 bytes for a report with no description", () => {
    expect(descriptionBytes({})).toBe(0);
    expect(descriptionBytes({ description: "Caf\u00e9" })).toBe(5);
  });

  it("counts each open incident of the routes one time, with no incident of the system", () => {
    const kind = (code: string) => ({ code, label: code });
    const tornado = { incident: { anchor: report("a", []).id, kind: kind("met.tornado") } };
    const flood = { incident: { anchor: report("b", []).id, kind: kind("met.flood") } };
    const health = { incident: { anchor: report("s", []).id, kind: kind("system.source.down") } };
    // Two persons get the tornado, thus it has two routes.
    expect(openIncidents([tornado, tornado, flood, health])).toBe(2);
    expect(openIncidents([health])).toBe(0);
    expect(openIncidents([])).toBe(0);
  });
});
