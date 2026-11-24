/**
 * The map function of the EIA-930 source. One observation is one hour of one balancing authority of the United States:
 * its demand and its day-ahead demand forecast, from the Hourly Electric Grid Monitor of the U.S. Energy Information
 * Administration. The fetch gives its body. The map gives no report. It gives one indicator reading: the demand, with
 * the forecast as its expected value.
 *
 * The measure has the baseline `expected`, thus each reading needs its forecast. An hour with no forecast gives no reading
 * and a note (AL-158). When the forecast comes, the body changes, and the new observation gives the reading.
 *
 * A demand far below its forecast tells of a large loss of load, for example a blackout. A demand far above its forecast
 * tells of a stress of the grid, for example a heat wave.
 */

import { Problems, type IndicatorArea, type Instant, type MapResult, type Observation, type Reading, type SourceId } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { z } from "zod";

/** The id of this source. */
export const SOURCE_ID = "eia-930" as SourceId;

/** The origin of the values: the U.S. Energy Information Administration, which collects Form EIA-930 and operates the API. */
export const EIA_ORIGIN = "eia";

/**
 * The credit that the reuse policy of EIA asks for. The policy also asks for the date of the data. The date of each
 * value is the hour of its observation.
 */
export const EIA_CREDIT = "Source: U.S. Energy Information Administration";

/** The system of the zone of each reading: the respondent code of a balancing authority in Form EIA-930. */
export const ZONE_SYSTEM = "eia-ba";

/** The id of the measure of the demand of each hour. */
export const DEMAND = "demand";

/** The unit of each value: the energy of one hour. The API names it `megawatthours`. */
export const DEMAND_UNIT = "MWh";

/** The unit of each value, as the field `value-units` of the API gives it. */
export const API_UNIT = "megawatthours";

/** The length of one hour, in milliseconds. */
export const HOUR_MS = 3_600_000;

/**
 * The respondents of Form EIA-930 that are sums of balancing authorities: the regions of EIA and the lower 48 states. The
 * source gives no reading of them. A fault in one balancing authority is then one signal, not two or three.
 */
export const AGGREGATE_RESPONDENTS: readonly string[] = ["CAL", "CAR", "CENT", "FLA", "MIDA", "MIDW", "NE", "NW", "NY", "SE", "SW", "TEN", "TEX", "US48"];

/** The fields of the body of one hour, in their order. */
export const HOUR_FIELDS = ["hour", "respondent", "unit", "demand", "forecast"] as const;

/**
 * The body of one hour of one balancing authority. The hour is the period of the API: the end of the hour in UTC. A value
 * that the answer does not give holds `null`.
 */
export interface HourBody {
  readonly hour: string;
  readonly respondent: string;
  readonly unit: string;
  readonly demand: number | null;
  readonly forecast: number | null;
}

const PERIOD = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/**
 * This function gives the period text of the hour that ends at `time`, for example `2026-11-18T18`. The time is the
 * end of a whole hour in UTC.
 */
export function periodText(time: Instant): string {
  return new Date(time).toISOString().slice(0, 13);
}

/**
 * This function gives the end of the hour of a period text of the API. A text that is not a whole hour in UTC gives
 * `undefined`. The period `2026-11-18T18` is the hour from 17:00 to 18:00 UTC.
 */
export function periodEnd(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !PERIOD.test(value)) return undefined;
  const time = Date.parse(`${value}:00:00Z`);
  return Number.isFinite(time) && periodText(time) === value ? time : undefined;
}

/** This function gives the body of one hour: the JSON text of the fields of `HOUR_FIELDS`, in that order. */
export function hourBody(hour: string, respondent: string, demand: number | null, forecast: number | null): string {
  const body: HourBody = { hour, respondent, unit: API_UNIT, demand, forecast };
  return JSON.stringify(body);
}

/** This function gives the area of the readings of a balancing authority. */
export function zoneOf(respondent: string): IndicatorArea {
  return { type: "zone", system: ZONE_SYSTEM, code: respondent };
}

const hourSchema = z.object({
  hour: z.string(),
  respondent: z.string().min(1),
  unit: z.string(),
  demand: z.number().nullable(),
  forecast: z.number().nullable(),
});

/**
 * This function tells if a demand is a placeholder: a demand that equals its forecast. On 2026-11-18 at 18:47 UTC, the
 * newest hour had this equality for 19 of 65 balancing authorities, and each earlier hour for 0 to 4. A real demand that
 * equals its forecast to the megawatt-hour is rare, so the map gives no reading of it.
 */
export function isPlaceholder(demand: number, forecast: number | null): boolean {
  return forecast !== null && demand === forecast;
}

/** This function maps one observation. It does not throw. A body that it does not understand gives a fatal problem. */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let fields: unknown;
  try {
    fields = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The fetch gives the whole answer, or one row, as one observation when the answer is not the series of EIA-930.
  const parsed = hourSchema.safeParse(fields);
  if (!parsed.success) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one hour of the demand series of EIA-930: the format changed", fatal: true }] };
  }
  const { hour, respondent, unit, demand, forecast } = parsed.data;
  const problems = new Problems();
  const at = periodEnd(hour);
  if (at === undefined) problems.add("hour", `the value ${JSON.stringify(hour)} is not a whole hour in UTC: the map gives no reading`, "fatal");
  if (unit !== API_UNIT) problems.add("unit", `the unit ${JSON.stringify(unit)} is not ${API_UNIT}: the map gives no reading`, "fatal");
  if (problems.fatal > 0 || at === undefined) return { reports: [], problems: problems.list };

  // A balancing authority that did not send the hour has the value 0 until it sends it. A demand of 0 is not a demand.
  if (demand === null || demand <= 0) {
    problems.add("demand", `the hour has no demand above 0 (${JSON.stringify(demand)}): the map gives no reading`, "note");
    return { reports: [], problems: problems.list };
  }
  // A demand that equals its forecast is a placeholder of an hour that is not sent yet (`isPlaceholder`).
  if (isPlaceholder(demand, forecast)) {
    problems.add("demand", "the demand equals the forecast, so it is a placeholder: the map gives no reading", "note");
    return { reports: [], problems: problems.list };
  }
  // The baseline of the measure is the forecast. Without it, the runtime refuses the reading as lossy (AL-158).
  if (forecast === null || forecast <= 0) {
    problems.add("forecast", `the hour has no forecast above 0 (${JSON.stringify(forecast)}): the map gives no reading`, "note");
    return { reports: [], problems: problems.list };
  }
  const reading: Reading = { source: SOURCE_ID, measure: DEMAND, series: respondent, at, value: demand, area: zoneOf(respondent), observation: observation.id, expected: forecast };
  return { reports: [], problems: problems.list, readings: [reading] };
}
