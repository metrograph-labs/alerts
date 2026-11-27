import { reportId, type CanaryResult, type FetchRecord, type Observation, type ObservationId, type Report, type SourceId, type SourceProcedures } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { fetchEvents, fetchStep } from "./fetch.ts";

const SOURCE = "stream" as SourceId;
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);

const observation: Observation = {
  id: "observation-1" as ObservationId,
  source: SOURCE,
  fetched: T0,
  contentType: "text/plain",
  body: "a product",
  transport: { latency: 0 },
};

/** One tornado warning for a public zone of Kansas, with the body of its observation as its key. */
function reportOf(body: string, change: Partial<Report> = {}): Report {
  return {
    id: reportId({ source: SOURCE, key: body, sent: T0 }),
    source: SOURCE,
    origin: "nws",
    key: body,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
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
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: {},
    ...change,
  };
}

function recordOf(check: SourceProcedures["check"]): FetchRecord {
  const events = fetchEvents({
    source: SOURCE,
    procedures: { map: () => ({ reports: [], problems: [] }), ...(check === undefined ? {} : { check }) },
    started: T0,
    ended: T0 + 100,
    outcome: { ok: true, observations: [observation], complete: true },
    known: () => false,
  });
  const fetch = events.at(-1);
  if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
  return fetch.record;
}

describe("the canary of a fetch", () => {
  it("keeps the result of a check that decides", () => {
    const pass: CanaryResult = { pass: true, reason: "the keepalive is fresh" };
    const fail: CanaryResult = { pass: false, reason: "the keepalive is old" };
    expect(recordOf(() => pass).canary).toEqual(pass);
    expect(recordOf(() => fail).canary).toEqual(fail);
  });

  it("gives no canary for a source with no check, and for a check with no read", () => {
    // A check that gives `undefined` cannot decide yet: the health then gets no canary event.
    expect(recordOf(undefined)).not.toHaveProperty("canary");
    expect(recordOf(() => undefined)).not.toHaveProperty("canary");
  });

  it("tells a check that throws as a failed canary", () => {
    const record = recordOf(() => {
      throw new Error("no clock");
    });
    expect(record.canary).toEqual({ pass: false, reason: "The canary check threw: no clock" });
  });
});

describe("the admission of a fetch (AL-145)", () => {
  const second: Observation = { ...observation, id: "observation-2" as ObservationId, body: "a second product" };
  const third: Observation = { ...observation, id: "observation-3" as ObservationId, body: "a third product" };

  it("keeps each refused observation and its reports out of the events, and counts it as waiting", () => {
    const asked: string[] = [];
    const step = fetchStep({
      source: SOURCE,
      procedures: { map: (given) => ({ reports: [reportOf(given.observation.body)], problems: [] }) },
      started: T0,
      ended: T0 + 100,
      outcome: { ok: true, observations: [observation, second, third], complete: true },
      known: (id) => id === observation.id,
      admit: (reports) => {
        asked.push(...reports.map((report) => report.id));
        return reports[0]?.id !== reportOf("a second product").id;
      },
    });
    // The step asks only for the new observations, in the order of the fetch.
    expect(asked).toEqual([reportOf("a second product").id, reportOf("a third product").id]);
    expect(step.waiting).toBe(1);
    expect(step.events.map((event) => event.id)).toEqual(["observation-3", `fetch:${SOURCE}:${T0}`]);
    const fetch = step.events.at(-1);
    if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
    expect(fetch.record.fresh).toBe(1);
    expect(fetch.reports.map((report) => report.id)).toEqual([reportOf("a third product").id]);
  });

  it("keeps the cursor of the source when an observation waits, thus a later fetch gives it again", () => {
    const stepWith = (admit: (reports: readonly Report[]) => boolean) =>
      fetchStep({ source: SOURCE, procedures: { map: (given) => ({ reports: [reportOf(given.observation.body)], problems: [] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation, second], complete: true, cursor: { page: "2" } }, known: () => false, admit });
    const cursorOf = (step: ReturnType<typeof fetchStep>) => {
      const fetch = step.events.at(-1);
      if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
      return fetch.cursor;
    };
    expect(cursorOf(stepWith(() => true))).toEqual({ page: "2" });
    expect(cursorOf(stepWith((reports) => reports[0]?.id !== reportOf("a second product").id))).toBeUndefined();
  });

  it("takes each new observation with no admission, and counts no waiting", () => {
    const step = fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: [], problems: [] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation, second], complete: true }, known: () => false });
    expect(step.waiting).toBe(0);
    expect(step.events).toHaveLength(3);
  });
});

describe("the report check of a fetch (AL-157)", () => {
  const stepOf = (reports: readonly unknown[], known = false) =>
    fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: reports as Report[], problems: [] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation], complete: true }, known: () => known });
  const fetchOf = (step: ReturnType<typeof fetchStep>) => {
    const fetch = step.events.at(-1);
    if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
    return fetch;
  };

  it("keeps each report that passes the schema, as the map gave it, also a report with no place", () => {
    const good = reportOf("a product");
    const cancel = reportOf("a cancel", { op: "cancel", references: ["a product"], areas: [] });
    const fetch = fetchOf(stepOf([good, cancel]));
    expect(fetch.reports).toEqual([good, cancel]);
    expect(fetch.reports[0]).toBe(good);
    expect(fetch.record.lossy).toBeUndefined();
    expect(fetch.record.skipped).toBeUndefined();
    expect(fetch.problems).toEqual([]);
  });

  it("counts each message that the map skipped by design, and the skip is no lossy problem (AL-94)", () => {
    const skip = { path: "scope", message: "the scope is not Public", fatal: false, skipped: true } as const;
    const step = fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: [], problems: [skip] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation, { ...observation, id: "observation-2" as ObservationId }], complete: true }, known: () => false });
    const fetch = fetchOf(step);
    expect(fetch.record.skipped).toBe(2);
    expect(fetch.record.lossy).toBeUndefined();
    expect(fetch.record.fatal).toBe(0);
  });

  it("keeps a report that fails the schema out of the log, as a lossy problem with no value", () => {
    const bad = { ...reportOf("a bad severity"), severity: "hidden-value-7" };
    const fetch = fetchOf(stepOf([reportOf("a product"), bad, { id: "x" }]));
    expect(fetch.reports.map((report) => report.key)).toEqual(["a product"]);
    expect(fetch.record.lossy).toBe(fetch.problems.length);
    expect(fetch.problems.every((problem) => problem.lossy === true && !problem.fatal)).toBe(true);
    expect(fetch.problems.map((problem) => problem.path.split(":")[0])).toContain("reports[1]");
    expect(JSON.stringify(fetch.problems)).not.toContain("hidden-value-7");
  });

  it("counts the lossy problem of a known observation, and keeps its reports out", () => {
    const fetch = fetchOf(stepOf([{ ...reportOf("a bad severity"), severity: "hidden-value-7" }], true));
    expect(fetch.record.lossy).toBeGreaterThan(0);
    expect(fetch.reports).toEqual([]);
    expect(fetch.problems).toEqual([]);
  });

  it("gives one lossy problem when the reports of the map are not a list", () => {
    const step = fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: "none" as unknown as Report[], problems: [] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation], complete: true }, known: () => false });
    expect(fetchOf(step).problems).toEqual([{ path: "reports", message: "The reports of the map are not a list.", fatal: false, lossy: true }]);
  });
});

describe("the live limit of an age check (AL-207)", () => {
  const MINUTE = 60_000;
  const late: CanaryResult = { pass: false, reason: "the newest item is 65 minutes old", late: true, age: 65 * MINUTE, limit: 60 * MINUTE };
  const stepOf = (check: NonNullable<SourceProcedures["check"]>, canaryAges?: readonly number[]) =>
    fetchStep({
      source: SOURCE,
      procedures: { map: () => ({ reports: [], problems: [] }), check },
      started: T0,
      ended: T0 + 100,
      outcome: { ok: true, observations: [observation], complete: true },
      known: () => false,
      ...(canaryAges === undefined ? {} : { canaryAges }),
    });
  const canaryOf = (step: ReturnType<typeof fetchStep>): CanaryResult | undefined => {
    const fetch = step.events.at(-1);
    if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
    return fetch.record.canary;
  };

  it("judges an age check with the live limit of the measured ages, and gives the age", () => {
    // 368 ages: the bound is the largest age, 65 minutes.
    const step = stepOf(() => late, [...Array.from({ length: 367 }, () => 20 * MINUTE), 65 * MINUTE]);
    expect(canaryOf(step)).toMatchObject({ pass: true, age: 65 * MINUTE, limit: 65 * MINUTE });
    expect(canaryOf(step)).not.toHaveProperty("late");
    expect(step.age).toBe(65 * MINUTE);
  });

  it("keeps the hand limit without ages and with too few ages", () => {
    expect(canaryOf(stepOf(() => late))).toEqual(late);
    expect(canaryOf(stepOf(() => late, [70 * MINUTE]))).toEqual(late);
    expect(stepOf(() => late).age).toBe(65 * MINUTE);
  });

  it("gives no age for a check with no age, and for a failed fetch", () => {
    const plain: CanaryResult = { pass: false, reason: "the feed has no items" };
    const step = stepOf(() => plain, Array.from({ length: 400 }, () => 20 * MINUTE));
    expect(canaryOf(step)).toEqual(plain);
    expect(step).not.toHaveProperty("age");
    const failed = fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: [], problems: [] }), check: () => late }, started: T0, ended: T0 + 100, outcome: { ok: false, failure: { kind: "timeout", message: "The fetch timed out." } }, known: () => false, canaryAges: [] });
    expect(failed).not.toHaveProperty("age");
  });
});
