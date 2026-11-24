import type { CanaryResult, FetchRecord, Observation, ObservationId, Report, SourceId, SourceProcedures } from "@mark1russell7/alerts";
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
  const reportOf = (body: string) => ({ id: `report:${body}` }) as unknown as Report;

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
        return reports[0]?.id !== "report:a second product";
      },
    });
    // The step asks only for the new observations, in the order of the fetch.
    expect(asked).toEqual(["report:a second product", "report:a third product"]);
    expect(step.waiting).toBe(1);
    expect(step.events.map((event) => event.id)).toEqual(["observation-3", `fetch:${SOURCE}:${T0}`]);
    const fetch = step.events.at(-1);
    if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
    expect(fetch.record.fresh).toBe(1);
    expect(fetch.reports.map((report) => report.id)).toEqual(["report:a third product"]);
  });

  it("takes each new observation with no admission, and counts no waiting", () => {
    const step = fetchStep({ source: SOURCE, procedures: { map: () => ({ reports: [], problems: [] }) }, started: T0, ended: T0 + 100, outcome: { ok: true, observations: [observation, second], complete: true }, known: () => false });
    expect(step.waiting).toBe(0);
    expect(step.events).toHaveLength(3);
  });
});
