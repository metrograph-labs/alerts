/**
 * AL-132: the readings of the live metrics in the lab of the capacity models. The lab run gives a meter of the
 * OpenTelemetry SDK to the runtime, and collects it after its start and after each pass. Each collection gives one line
 * `lab-readings` with the readings in the format `SeriesReading` of the capacity models: a series, a UTC time and a value.
 *
 * The capacity lab has no reader of the OpenTelemetry metrics of a run yet. This adapter is the bridge until it has one.
 * Then the run gives its metrics to that reader, and this file goes away (AL-135).
 */
import { DataPointType, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";

/** The event of the line of the readings. */
export const LAB_READINGS = "lab-readings";

/** One reading of a series, as the capacity models read it. */
export interface LabReading {
  readonly series: string;
  /** The UTC time of the collection, in the ISO 8601 form. */
  readonly at: string;
  readonly value: number;
}

/** A metric reader that collects only when the lab asks. It has no timer and no export. */
export class LabMetricReader extends MetricReader {
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * This function gives the readings of one collection at the time `at`. The value of a series is the sum of its data
 * points over all attributes. The function reads only the sums and the gauges: a histogram has no single value.
 */
export function labReadings(metrics: ResourceMetrics, at: number): readonly LabReading[] {
  const time = new Date(at).toISOString();
  const readings: LabReading[] = [];
  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.dataPointType !== DataPointType.SUM && metric.dataPointType !== DataPointType.GAUGE) continue;
      if (metric.dataPoints.length === 0) continue;
      const value = metric.dataPoints.reduce((sum, point) => sum + point.value, 0);
      readings.push({ series: metric.descriptor.name, at: time, value });
    }
  }
  return readings.sort((a, b) => (a.series < b.series ? -1 : a.series > b.series ? 1 : 0));
}

/** The result of one collection: the readings and the count of the errors of the callbacks. */
export interface LabCollection {
  readonly readings: readonly LabReading[];
  readonly errors: number;
}

/** This function collects the reader and gives the readings at the time `at`. A failed callback adds to `errors`. */
export async function collectReadings(reader: MetricReader, at: number): Promise<LabCollection> {
  const result = await reader.collect();
  return { readings: labReadings(result.resourceMetrics, at), errors: result.errors.length };
}
