/**
 * The rows of the event files of GDELT 2.0. Each file holds the events that GDELT coded from the news of 15 minutes, one
 * event on each line, with 61 fields that a tab separates. The function `eventOf` gives the fields that the source keeps,
 * with names. The function `keepEvent` tells which events give a report.
 */

/** The fields of an event that the source keeps, in the order of the body of an observation. */
export interface GdeltEvent {
  /** The id of the event: GLOBALEVENTID. */
  readonly id: string;
  /** The day of the event, `YYYYMMDD`: SQLDATE. An article can tell of an event of a day long before. */
  readonly day: string;
  /** The CAMEO code of the event, for example `145`. */
  readonly code: string;
  /** The root CAMEO code, for example `14`. */
  readonly root: string;
  readonly actor1: string;
  readonly actor1Country: string;
  readonly actor2: string;
  readonly actor2Country: string;
  /** The Goldstein scale of the code, from -10 to 10. */
  readonly goldstein: number;
  /** The mentions of the event in the news of the first 15 minutes. */
  readonly mentions: number;
  readonly sources: number;
  readonly articles: number;
  /** The average tone of the articles, from -100 to 100. */
  readonly tone: number;
  /** The kind of the place of the action: 1 country, 2 state of the United States, 3 city of the United States, 4 city, 5 first-level region. */
  readonly geoType: number;
  /** The name of the place of the action, for example `Lagos, Lagos, Nigeria`. */
  readonly place: string;
  /** The FIPS 10-4 code of the country of the action. */
  readonly country: string;
  /** The code of the first-level region of the action. */
  readonly adm1: string;
  readonly lat: number;
  readonly lon: number;
  /** The id of the place in the GNS or GNIS gazetteer. */
  readonly featureId: string;
  /** The time at which GDELT added the event, `YYYYMMDDHHMMSS` in UTC: DATEADDED. */
  readonly added: string;
  /** The page of the first article of the event. */
  readonly url: string;
}

/** The count of the fields of a line of an event file. */
export const EVENT_FIELD_COUNT = 61;

/** The names of the fields of `GdeltEvent`, in the order of the body of an observation. */
export const EVENT_FIELDS: readonly (keyof GdeltEvent)[] = [
  "id",
  "day",
  "code",
  "root",
  "actor1",
  "actor1Country",
  "actor2",
  "actor2Country",
  "goldstein",
  "mentions",
  "sources",
  "articles",
  "tone",
  "geoType",
  "place",
  "country",
  "adm1",
  "lat",
  "lon",
  "featureId",
  "added",
  "url",
];

/** The kinds of place with the point of a city: 3, a city of the United States, and 4, a city of another country. */
export const CITY_GEO_TYPES: readonly number[] = [3, 4];

/** The root CAMEO codes that give a report: 14 (protest), 18 (assault), 19 (fight) and 20 (unconventional mass violence). */
export const REPORTED_ROOTS: readonly string[] = ["14", "18", "19", "20"];

/** The most days from the day of an event to the day that GDELT added it, for a report. An article about an older event gives no report. */
export const MAX_EVENT_AGE_DAYS = 1;

/** This function gives the numeric value of a field, or `NaN` for an empty field. */
function numberOf(value: string | undefined): number {
  return value === undefined || value.trim() === "" ? Number.NaN : Number(value);
}

/** This function gives the event of one line of an event file, or `undefined` when the line does not have 61 fields. */
export function eventOf(line: string): GdeltEvent | undefined {
  const field = line.replace(/\r$/, "").split("\t");
  if (field.length !== EVENT_FIELD_COUNT) return undefined;
  const at = (index: number): string => field[index] ?? "";
  return {
    id: at(0),
    day: at(1),
    code: at(26),
    root: at(28),
    actor1: at(6),
    actor1Country: at(7),
    actor2: at(16),
    actor2Country: at(17),
    goldstein: numberOf(at(30)),
    mentions: numberOf(at(31)),
    sources: numberOf(at(32)),
    articles: numberOf(at(33)),
    tone: numberOf(at(34)),
    geoType: numberOf(at(51)),
    place: at(52),
    country: at(53),
    adm1: at(54),
    lat: numberOf(at(56)),
    lon: numberOf(at(57)),
    featureId: at(58),
    added: at(59),
    url: at(60),
  };
}

/** This function gives the time of a GDELT time `YYYYMMDDHHMMSS` in UTC, or `undefined` for a time that the calendar does not have. */
export function addedTime(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60 ? time : undefined;
}

/** This function gives the start of a GDELT day `YYYYMMDD` in UTC, or `undefined`. */
export function dayStart(value: string): number | undefined {
  return /^\d{8}$/.test(value) ? addedTime(`${value}000000`) : undefined;
}

/** This function tells if a point is a valid position on the Earth, and not the point 0, 0 of a missing place. */
function isPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

/**
 * This function tells if an event gives a report. The event needs a reported root code, the point of a city and a time
 * of addition. Its day is at most `MAX_EVENT_AGE_DAYS` before the day of its addition. The function is pure.
 */
export function keepEvent(event: GdeltEvent): boolean {
  return CITY_GEO_TYPES.includes(event.geoType) && isPoint(event.lat, event.lon) && countEvent(event);
}

/**
 * This function tells if an event counts in the census of the regions (AL-142). The event needs a reported root code and
 * a time of addition. Its day is at most `MAX_EVENT_AGE_DAYS` before the day of its addition. The place can be a city, a
 * region or a country. The function is pure.
 */
export function countEvent(event: GdeltEvent): boolean {
  if (!REPORTED_ROOTS.includes(event.root)) return false;
  const added = addedTime(event.added);
  const day = dayStart(event.day);
  if (added === undefined || day === undefined) return false;
  return added - day < (MAX_EVENT_AGE_DAYS + 1) * 86_400_000;
}

/** The form of a first-level region of the United States in GDELT: `US` and the code of the state of the Postal Service. */
const US_STATE_ADM1 = /^US([A-Z]{2})$/;

/**
 * This function gives the code of the state of an event in the United States, in the system `state` of the places. For
 * example, the region `USTX` gives `TX`. It gives `undefined` for an event with no state or in another country.
 */
export function stateOf(event: GdeltEvent): string | undefined {
  if (event.country !== "US") return undefined;
  return US_STATE_ADM1.exec(event.adm1)?.[1];
}

/** This function gives the body of the observation of an event: the JSON text of the fields of `EVENT_FIELDS`, in that order. */
export function eventBody(event: GdeltEvent): string {
  return JSON.stringify(Object.fromEntries(EVENT_FIELDS.map((name) => [name, event[name]])));
}
