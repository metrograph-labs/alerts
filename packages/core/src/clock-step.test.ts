import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import {
  CLOCK_STEP_ABOVE,
  shiftDelivery,
  shiftEndMark,
  shiftEscalationEnd,
  shiftEscalationStart,
  shiftHealth,
  shiftMerge,
  shiftReport,
} from "./clock-step.ts";
import type { Acknowledgment, ChannelId, Delivery, EndMark, ObservationId, PersonId, Report, ReportId, SourceId } from "./contracts.ts";
import type { HealthTrack } from "./health.ts";
import { normalize } from "./merge.ts";
import { SYSTEM_SOURCE } from "./contracts.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const T0 = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;
const PERSON = "person:a" as PersonId;
const PUSHOVER = "pushover" as ChannelId;

function report(id: string, fields: Partial<Report> = {}): Report {
  return {
    id: id as ReportId,
    source: "nws-api" as SourceId,
    origin: "nws",
    key: id,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: T0 + 5_000,
    areas: [],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: "obs" as ObservationId,
    parameters: {},
    ...fields,
  };
}

function delivery(key: string, at: number): Delivery {
  return { key, incident: "a" as ReportId, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at };
}

function track(fields: Partial<HealthTrack> = {}): HealthTrack {
  return { source: "nws-api" as SourceId, state: "healthy", since: T0, time: T0 + 60_000, failures: 0, staleFrom: T0 + 30_000, ...fields };
}

describe("the shift of the own instants", () => {
  it("keeps the drift limit at 2 s", () => {
    expect(CLOCK_STEP_ABOVE).toBe(2000);
  });

  it("moves only the receipt time of a report of a source, because its other times come from the source", () => {
    const sourced = report("a", { effective: T0, onset: T0 + HOUR, expires: T0 + 2 * HOUR, ends: T0 + 3 * HOUR });
    expect(shiftReport(sourced, -HOUR)).toEqual({ ...sourced, received: T0 + 5_000 - HOUR });
  });

  it("moves each time of a system report, and adds no time that the report does not have", () => {
    const own = report("system#1", { source: SYSTEM_SOURCE, onset: T0 + HOUR });
    expect(shiftReport(own, HOUR)).toEqual({ ...own, sent: T0 + HOUR, received: T0 + 5_000 + HOUR, onset: T0 + 2 * HOUR });
    const full = report("system#2", { source: SYSTEM_SOURCE, effective: T0, onset: T0, expires: T0 + HOUR, ends: T0 + 2 * HOUR });
    expect(shiftReport(full, -1)).toMatchObject({ sent: T0 - 1, received: T0 + 4_999, effective: T0 - 1, onset: T0 - 1, expires: T0 + HOUR - 1, ends: T0 + 2 * HOUR - 1 });
  });

  it("moves the time of a delivery and of an end mark, but not the time of the data of the list", () => {
    expect(shiftDelivery(delivery("k", T0), HOUR).at).toBe(T0 + HOUR);
    const mark: EndMark = { report: "a" as ReportId, at: T0, ended: true, asOf: T0 - 60_000 };
    expect(shiftEndMark(mark, -HOUR)).toEqual({ ...mark, at: T0 - HOUR });
  });

  it("moves each time of a health track, also the times of the last passed and the last failed fetch", () => {
    const moved = shiftHealth(
      track({ quietFrom: T0 + 10_000, passed: { at: T0 + 20_000, took: 400, fatal: 0 }, lastFailure: { at: T0 + 40_000, failure: { kind: "timeout", message: "late" } } }),
      -HOUR,
    );
    expect(moved).toMatchObject({ since: T0 - HOUR, time: T0 + 60_000 - HOUR, staleFrom: T0 + 30_000 - HOUR, quietFrom: T0 + 10_000 - HOUR, passed: { at: T0 + 20_000 - HOUR, took: 400 }, lastFailure: { at: T0 + 40_000 - HOUR } });
    expect(shiftHealth(track(), HOUR)).not.toHaveProperty("quietFrom");
  });

  it("moves the starts and the ends of the escalations", () => {
    expect(shiftEscalationStart({ incident: "a" as ReportId, level: "urgent", person: PERSON, at: T0 }, HOUR).at).toBe(T0 + HOUR);
    expect(shiftEscalationEnd({ incident: "a" as ReportId, person: PERSON, at: T0 }, -HOUR).at).toBe(T0 - HOUR);
  });

  it("moves no acknowledgment, because its time comes from the channel", () => {
    const ack: Acknowledgment = { incident: "a" as ReportId, level: "urgent", person: PERSON, at: T0 + 120_000, via: PUSHOVER };
    const state = normalize({ reports: [report("a")], deliveries: [delivery("k", T0)], acks: [ack], ends: [] });
    expect(shiftMerge(state, -HOUR).acks).toEqual([ack]);
  });

  it.each(SEEDS)("gives the normal form, the shift by 0 is the same state, and a step and its reverse give the state again (seed %i)", (seed) => {
    const r = random(seed);
    const instant = () => T0 + r.int(-10 * HOUR, 10 * HOUR);
    const reports = Array.from({ length: r.int(1, 8) }, (_, index) =>
      report(`r${index}`, { source: r.chance(0.3) ? SYSTEM_SOURCE : ("nws-api" as SourceId), sent: instant(), received: instant(), ...(r.chance(0.5) ? { onset: instant() } : {}) }),
    );
    const deliveries = Array.from({ length: r.int(0, 6) }, (_, index) => delivery(`d${index}`, instant()));
    const ends = reports.filter(() => r.chance(0.4)).map((entry): EndMark => ({ report: entry.id, at: instant(), ended: r.chance(0.8), ...(r.chance(0.5) ? { asOf: instant() } : {}) }));
    // The tombstones are of other reports, so they remove no part of the state.
    const retired = Array.from({ length: r.int(0, 3) }, (_, index) => ({ report: `gone${index}` as ReportId, until: instant() }));
    const state = normalize({ reports, deliveries, acks: [], ends, retired });
    const size = r.pick([-1, 1]) * r.int(CLOCK_STEP_ABOVE + 1, 12 * HOUR);
    const moved = shiftMerge(state, size);
    expect(moved).toEqual(normalize(moved));
    expect(shiftMerge(state, 0)).toEqual(state);
    expect(shiftMerge(moved, -size)).toEqual(state);
    expect(moved.reports.map((entry) => entry.received - size)).toEqual(state.reports.map((entry) => entry.received));
  });
});
