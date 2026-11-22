/**
 * The live metrics of the runtime (AL-132). The instruments are on a meter of the OpenTelemetry API. The series of the
 * contract `capacity-app.json` have the names of these instruments. Thus the lab of the capacity models reads the load
 * of a run from the runtime itself. It does not read the load only from the fake of the feeds.
 *
 * - A counter of each class counts the new reports of the fetches. A report with a reference is an `update`: a new
 *   version of an alert. A report with no reference is an `event`: the first version of an alert.
 * - A counter of each class adds the bytes of the description of each report, in UTF-8.
 * - Three gauges give the levels of the instance: the transit feeds, the persons and the open incidents.
 *
 * The instance makes the instruments only when its options give a meter. The entry gives no meter until the export of
 * the metrics (AL-134). A meter of the OpenTelemetry API with no provider changes nothing.
 */
import { categoryOf, type Incident, type Report } from "@mark1russell7/alerts";
import type { Meter } from "@opentelemetry/api";

/** The names of the instruments, as the series of `capacity-app.json` name them. */
export const RUNTIME_METRICS = {
  event: "alerts.reports.event",
  eventBytes: "alerts.reports.event.description",
  update: "alerts.reports.update",
  updateBytes: "alerts.reports.update.description",
  feeds: "alerts.feeds",
  persons: "alerts.persons",
  incidents: "alerts.incidents.open",
} as const;

/** The levels of an instance at one time. */
export interface RuntimeLevels {
  /** The transit feeds of the start. Each one is a polled source. */
  readonly feeds: number;
  /** The persons of the configuration. */
  readonly persons: number;
  /** The open incidents of the last pass that reach a person, with no incident of the system (`openIncidents`). */
  readonly incidents: number;
}

/** The counters of the live metrics. */
export interface RuntimeMetrics {
  /** This method counts the new reports of one fetch, with the bytes of their descriptions. */
  reports(reports: readonly Report[]): void;
}

/**
 * This function makes the instruments of the live metrics on a meter. Each counter starts at 0, thus each series has a
 * reading from the first collection. The gauges read `levels` at each collection.
 */
export function runtimeMetrics(meter: Meter, levels: () => RuntimeLevels): RuntimeMetrics {
  const event = meter.createCounter(RUNTIME_METRICS.event, { unit: "{event}", description: "The new reports with no reference: the first versions of alerts." });
  const update = meter.createCounter(RUNTIME_METRICS.update, { unit: "{event}", description: "The new reports with a reference: the new versions of alerts." });
  const eventBytes = meter.createCounter(RUNTIME_METRICS.eventBytes, { unit: "By", description: "The bytes of the descriptions of the new reports with no reference." });
  const updateBytes = meter.createCounter(RUNTIME_METRICS.updateBytes, { unit: "By", description: "The bytes of the descriptions of the new reports with a reference." });
  for (const counter of [event, update, eventBytes, updateBytes]) counter.add(0);
  const feeds = meter.createObservableGauge(RUNTIME_METRICS.feeds, { unit: "{feed}", description: "The transit feeds of the start." });
  const persons = meter.createObservableGauge(RUNTIME_METRICS.persons, { unit: "{person}", description: "The persons of the configuration." });
  const incidents = meter.createObservableGauge(RUNTIME_METRICS.incidents, { unit: "{incident}", description: "The open incidents of the last pass that reach a person." });
  meter.addBatchObservableCallback(
    (result) => {
      const now = levels();
      result.observe(feeds, now.feeds);
      result.observe(persons, now.persons);
      result.observe(incidents, now.incidents);
    },
    [feeds, persons, incidents],
  );
  return {
    reports(reports) {
      for (const report of reports) {
        const isUpdate = report.references.length > 0;
        (isUpdate ? update : event).add(1);
        (isUpdate ? updateBytes : eventBytes).add(descriptionBytes(report));
      }
    },
  };
}

/** This function gives the bytes of the description of a report in UTF-8. A report with no description gives 0. */
export function descriptionBytes(report: Pick<Report, "description">): number {
  return Buffer.byteLength(report.description ?? "", "utf8");
}

/**
 * This function gives the count of the open incidents at the places of the persons. It counts the incidents of the routes
 * of a pass, with no incident of the category `system`. A route goes to a person only when the incident is at a place of that person.
 * The system incidents tell the state of the system, thus the level of the capacity models does not count them.
 */
export function openIncidents(routes: readonly { readonly incident: Pick<Incident, "anchor" | "kind"> }[]): number {
  const anchors = new Set<string>();
  for (const route of routes) if (categoryOf(route.incident.kind.code) !== "system") anchors.add(route.incident.anchor);
  return anchors.size;
}
