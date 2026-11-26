/**
 * This module makes the events of one fetch. It is pure: the runtime gives the outcome, the times and
 * the ids that the log has. The runtime applies the map of a source to each observation of the fetch.
 * The fatal and lossy problems of the last passed fetch give the health. The log keeps only the new observations and
 * their reports, thus a read that repeats does not make the file larger. The readings of the new observations go to the
 * store of the readings, not to the log.
 *
 * A bound of the state (AL-145) can keep a new observation out of the log: `admit` refuses its reports. Then the step
 * writes neither the observation nor its reports, and the observation stays new. The fetch event then keeps no cursor, thus
 * the cursor of the source stays. A later fetch gives the observation again, also from a source that reads from a cursor, and
 * it goes in when the state has space.
 */
import {
  checkWith,
  readingProblems,
  readingSchema,
  reportSchema,
  type CanaryResult,
  type FetchOutcome,
  type FetchRecord,
  type Instant,
  type MapProblem,
  type MapResult,
  type Observation,
  type ObservationId,
  type Reading,
  type Report,
  type SourceDescriptor,
  type SourceId,
  type SourceProcedures,
} from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { envelope, frameTag, type FetchEvent, type ObservationEvent } from "./events.ts";

/** The input of `fetchStep` and `fetchEvents`. */
export interface FetchInput {
  readonly source: SourceId;
  /**
   * The descriptor of the source. The check of each reading reads the declarations of its measures. Without the
   * descriptor, the step keeps no reading, and each reading is a lossy problem.
   */
  readonly descriptor?: SourceDescriptor;
  /** The map and the canary check of the source. */
  readonly procedures: Pick<SourceProcedures, "map" | "check">;
  /** The start and the end of the fetch. */
  readonly started: Instant;
  readonly ended: Instant;
  readonly outcome: FetchOutcome;
  /** This function tells if the log has an observation. */
  readonly known: (id: ObservationId) => boolean;
  /** The count of the steps of the wall clock in the log. The id of the fetch has its frame tag. The default is 0. */
  readonly frame?: number;
  /**
   * This function tells if the state takes the reports of a new observation (AL-145). The step asks once for each new
   * observation, in the order of the fetch. The default takes each observation.
   */
  readonly admit?: (reports: readonly Report[]) => boolean;
}

/** The events and the readings of one fetch. The log keeps the events, and the store of the readings keeps the readings. */
export interface FetchStep {
  readonly events: (ObservationEvent | FetchEvent)[];
  /** The readings of the new observations that pass their checks, in the order of the map. */
  readonly readings: readonly Reading[];
  /** The count of the new observations that `admit` refused. They wait outside the log. */
  readonly waiting: number;
}

/** This function gives the events of one fetch: one event for each new observation, then the fetch event. */
export function fetchEvents(input: FetchInput): (ObservationEvent | FetchEvent)[] {
  return fetchStep(input).events;
}

/**
 * This function gives the events and the readings of one fetch. Each reading of a new observation gets two checks: the
 * schema of a reading, and the declaration of its measure with `readingProblems`. It must also name its own observation.
 * A reading that fails a check is a lossy problem of its observation, and the store does not get it. Each report gets
 * the schema of a report. A report that fails it is a lossy problem, and the log does not get it (AL-157).
 */
export function fetchStep(input: FetchInput): FetchStep {
  const { source, started, ended, outcome } = input;
  const took = Math.max(0, ended - started);
  const id = `fetch:${source}:${started}${frameTag(input.frame ?? 0)}`;
  if (!outcome.ok) {
    const record: FetchRecord = { source, at: started, took, failure: outcome.failure, fresh: 0, fatal: 0 };
    return { events: [{ ...envelope("fetch", id, ended), record, reports: [], problems: [] }], readings: [], waiting: 0 };
  }
  // A fetch can give an observation twice. Each id counts once.
  const unique = [...new Map(outcome.observations.map((observation) => [observation.id, observation])).values()];
  const isFresh = new Set(unique.filter((observation) => !input.known(observation.id)).map((observation) => observation.id));
  const fresh: Observation[] = [];
  let waiting = 0;
  let fatal = 0;
  let lossy = 0;
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  const readings: Reading[] = [];
  for (const observation of unique) {
    const result = mapSafely(input.procedures, observation);
    const valid = checkReports(result.reports);
    const checked = checkReadings(result.readings, observation.id, source, input.descriptor);
    const found = [...result.problems, ...valid.problems, ...checked.problems];
    fatal += found.filter((problem) => problem.fatal).length;
    lossy += found.filter((problem) => problem.lossy === true).length;
    if (!isFresh.has(observation.id)) continue;
    if (input.admit !== undefined && !input.admit(valid.reports)) {
      waiting += 1;
      continue;
    }
    fresh.push(observation);
    reports.push(...valid.reports);
    problems.push(...found);
    readings.push(...checked.readings);
  }
  const canary = checkSafely(input.procedures, outcome.observations);
  const record: FetchRecord = {
    source,
    at: started,
    took,
    fresh: fresh.length,
    fatal,
    ...(lossy > 0 ? { lossy } : {}),
    ...(canary === undefined ? {} : { canary }),
  };
  const observed = fresh.map((observation): ObservationEvent => ({ ...envelope("observation", observation.id, ended), observation }));
  const events = [...observed, { ...envelope("fetch", id, ended), record, ...(outcome.cursor === undefined || waiting > 0 ? {} : { cursor: outcome.cursor }), reports, problems }];
  return { events, readings, waiting };
}

// A lossy problem at a path: the map lost a value of the message.
const lossyAt =
  (path: string) =>
  (message: string): MapProblem => ({ path, message, fatal: false, lossy: true });

// The reports of one map result that pass the schema of a report, and a lossy problem for each other report. A report
// goes to the log and to the other copies, and the exchange refuses a report that fails the schema. Thus the log keeps
// only a report that each copy accepts. The function keeps the value of a good report as the map gave it.
function checkReports(given: unknown): { reports: Report[]; problems: MapProblem[] } {
  if (!Array.isArray(given)) return { reports: [], problems: [lossyAt("reports")("The reports of the map are not a list.")] };
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  for (const [index, value] of (given as readonly unknown[]).entries()) {
    const checked = checkWith(reportSchema, value);
    if (checked.tag === "err") problems.push(...checked.error.map(lossyAt(`reports[${String(index)}]`)));
    else reports.push(value as Report);
  }
  return { reports, problems };
}

// The readings of one map result that pass their checks, and a lossy problem for each other reading. The value comes from
// an adapter, thus the function checks the list too. A reading must name its observation, because the key of the store holds it.
function checkReadings(given: unknown, observation: ObservationId, source: SourceId, descriptor: SourceDescriptor | undefined): { readings: Reading[]; problems: MapProblem[] } {
  if (given === undefined) return { readings: [], problems: [] };
  if (!Array.isArray(given)) return { readings: [], problems: [lossyAt("readings")("The readings of the map are not a list.")] };
  const readings: Reading[] = [];
  const problems: MapProblem[] = [];
  for (const [index, value] of (given as readonly unknown[]).entries()) {
    const at = lossyAt(`readings[${String(index)}]`);
    const checked = checkWith(readingSchema, value);
    if (checked.tag === "err") {
      problems.push(...checked.error.map(at));
      continue;
    }
    const reading = checked.value;
    const found = descriptor === undefined ? [`The runtime has no declaration of the measures of ${source}.`] : readingProblems(reading, descriptor);
    if (reading.observation !== observation) found.push("The reading names an observation other than the observation of its message.");
    if (found.length > 0) problems.push(...found.map(at));
    else readings.push(reading);
  }
  return { readings, problems };
}

// A map that throws is a fault of the adapter. It is a fatal problem of its observation, thus the health
// goes to `changed`, and the loop continues for the other observations and the other sources.
function mapSafely(procedures: FetchInput["procedures"], observation: Observation): MapResult {
  try {
    return procedures.map({ observation });
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `The map threw: ${errorMessage(error)}`, fatal: true }] };
  }
}

// A canary check that throws is a failed canary.
function checkSafely(procedures: FetchInput["procedures"], observations: readonly Observation[]): CanaryResult | undefined {
  if (procedures.check === undefined) return undefined;
  try {
    return procedures.check({ observations });
  } catch (error) {
    return { pass: false, reason: `The canary check threw: ${errorMessage(error)}` };
  }
}
