/**
 * The map function of the Energy-Charts source. One observation is one minute of the grid frequency of Continental
 * Europe, as the meter of Fraunhofer ISE measures it each second. The fetch gives its body. The map gives no report. It
 * gives two indicator readings: the lowest and the highest value of the minute.
 *
 * The frequency is one value for the whole synchronous area. Thus the area of each reading is the zone of the
 * synchronous area. A large drop tells of the loss of a large generator. A large rise tells of the loss of a large load
 * or a split.
 */

import { Problems, type IndicatorArea, type Instant, type MapResult, type Observation, type Reading, type SourceId } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "energy-charts" as SourceId;

/** The origin of the values: Fraunhofer ISE, which measures the frequency and operates the API. */
export const ENERGY_CHARTS_ORIGIN = "fraunhofer-ise";

/** The license of the frequency, as the field `license` of each answer gives it. */
export const ENERGY_CHARTS_LICENSE = "CC BY 4.0 (creativecommons.org/licenses/by/4.0), attribution: energy-charts.info";

/** The credit that the license asks for. */
export const ENERGY_CHARTS_CREDIT = "energy-charts.info";

/** The region of the meter, as the parameter `region` of the API names it. It is the id of the series of each reading. */
export const FREQUENCY_REGION = "DE-Freiburg";

/**
 * The area of each reading: the synchronous area of Continental Europe, by its EIC code. The frequency is one value
 * for the whole area in a steady state.
 */
export const SYNCHRONOUS_AREA: IndicatorArea = { type: "zone", system: "eic", code: "10YEU-CONT-SYNC0" };

/** The id of the measure of the lowest frequency of each minute. */
export const FREQUENCY_MIN = "frequency-min";

/** The id of the measure of the highest frequency of each minute. */
export const FREQUENCY_MAX = "frequency-max";

/** The unit of each value of the series. */
export const FREQUENCY_UNIT = "Hz";

/** The length of one minute, in milliseconds. */
export const MINUTE_MS = 60_000;

/** The count of the values of one minute: one for each second. */
export const SECONDS = 60;

/** The fields of the body of one minute, in their order. */
export const MINUTE_FIELDS = ["minute", "region", "unit", "license", "frequency"] as const;

/** The body of one minute. The value of each second is at its index, and a second with no value holds `null`. */
export interface MinuteBody {
  readonly minute: string;
  readonly region: string;
  readonly unit: string;
  readonly license: string;
  readonly frequency: readonly (number | null)[];
}

/** This function gives the text of the start of a minute, for example `2026-11-18T03:07:00Z`. */
export function minuteText(time: Instant): string {
  return new Date(time).toISOString().replace(".000Z", "Z");
}

/** This function gives the time of the start of a minute from its text. A text that is not the start of a minute in UTC gives `undefined`. */
export function minuteStart(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && minuteText(time) === value ? time : undefined;
}

/** This function gives the body of one minute: the JSON text of the fields of `MINUTE_FIELDS`, in that order. */
export function minuteBody(minute: Instant, values: readonly (number | null)[]): string {
  const body: MinuteBody = { minute: minuteText(minute), region: FREQUENCY_REGION, unit: FREQUENCY_UNIT, license: ENERGY_CHARTS_LICENSE, frequency: values };
  return JSON.stringify(body);
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
  // The fetch gives the whole answer, or one row, as one observation when the answer is not the series of the frequency.
  if (!isRecord(fields) || typeof fields["minute"] !== "string" || !Array.isArray(fields["frequency"])) {
    return { reports: [], problems: [{ path: "", message: "the observation is not one minute of the frequency series of Energy-Charts: the format or the license changed", fatal: true }] };
  }
  const problems = new Problems();
  const at = minuteStart(fields["minute"]);
  if (at === undefined) problems.add("minute", `the value ${JSON.stringify(fields["minute"])} is not the start of a minute in UTC: the map gives no reading`, "fatal");
  const region = fields["region"];
  if (typeof region !== "string" || region === "") problems.add("region", "the region is not a text: the map gives no reading", "fatal");
  if (fields["unit"] !== FREQUENCY_UNIT) problems.add("unit", `the unit ${JSON.stringify(fields["unit"])} is not ${FREQUENCY_UNIT}: the map gives no reading`, "fatal");
  if (fields["license"] !== ENERGY_CHARTS_LICENSE) problems.add("license", "the license is not the license of the series: the map gives no reading", "fatal");
  const frequency = fields["frequency"] as readonly unknown[];
  if (frequency.length !== SECONDS) problems.add("frequency", `the minute has ${String(frequency.length)} values, not ${String(SECONDS)}: the map gives no reading`, "fatal");
  if (problems.fatal > 0 || at === undefined || typeof region !== "string") return { reports: [], problems: problems.list };

  const values: number[] = [];
  frequency.forEach((value, second) => {
    if (value === null) return;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) values.push(value);
    else problems.add(`frequency[${String(second)}]`, `the value ${JSON.stringify(value)} is not a frequency above 0: the readings do not use it`);
  });
  if (values.length === 0) {
    problems.add("frequency", "the minute has no value: the map gives no reading", "note");
    return { reports: [], problems: problems.list };
  }
  const reading = (measure: string, value: number): Reading => ({ source: SOURCE_ID, measure, series: region, at, value, area: SYNCHRONOUS_AREA, observation: observation.id });
  return { reports: [], problems: problems.list, readings: [reading(FREQUENCY_MIN, Math.min(...values)), reading(FREQUENCY_MAX, Math.max(...values))] };
}
