import { canonicalJson, random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Acknowledgment, ChannelId, Delivery, EndMark, Incident, MergeState, ObservationId, PersonId, Report, ReportId, SourceId } from "./contracts.ts";
import { reportId } from "./ids.ts";
import { acknowledgedLevel, add, EMPTY_STATE, incidents, join, normalize, sentLevel, type IncidentOptions } from "./merge.ts";
import { pruneTombstones, QUIET_HORIZON, retire, retirements, RETENTION_HORIZON, TOMBSTONE_LIFE, type QuietRule } from "./retention.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_763_157_600_000;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;

interface Draft extends Partial<Omit<Report, "id" | "source">> {
  readonly key: string;
}

function report(draft: Draft): Report {
  const source = "nws-api" as SourceId;
  const sent = draft.sent ?? T0;
  return {
    origin: "nws",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    received: sent,
    expires: sent + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "NWS Topeka KS",
    headline: "Tornado Warning",
    observation: "0".repeat(64) as ObservationId,
    parameters: {},
    ...draft,
    id: reportId({ source, key: draft.key, sent }),
    source,
    sent,
  };
}

const delivery = (incident: Report, at: number): Delivery => ({ key: `m-${incident.id}-${at}`, incident: incident.id, level: "urgent", person, channel: pushover, step: 0, at });
const ack = (incident: Report, at: number): Acknowledgment => ({ incident: incident.id, level: "urgent", person, at, via: "ui" });
const same = (a: unknown, b: unknown): void => expect(canonicalJson(a, { form: "json" })).toBe(canonicalJson(b, { form: "json" }));

// The retirements of a state at a time, from its own incidents.
const retiredAt = (state: MergeState, at: number, options: IncidentOptions = {}): ReportId[] => retirements(state, incidents(state, at, options), at);

describe("retirements", () => {
  const alert = report({ key: "k1" });
  const ended = T0 + HOUR;

  it("retires an ended incident one horizon after its last change, and not before", () => {
    const state = normalize({ reports: [alert] });
    expect(retiredAt(state, ended + RETENTION_HORIZON - 1)).toEqual([]);
    expect(retiredAt(state, ended + RETENTION_HORIZON)).toEqual([alert.id]);
    expect(retirements(state, incidents(state, ended + DAY), ended + DAY, DAY)).toEqual([alert.id]);
  });

  it("retires the whole incident: the alert and its cancel", () => {
    const cancel = report({ key: "k2", op: "cancel", references: ["k1"], sent: T0 + 10 * 60_000, expires: T0 + HOUR });
    const state = normalize({ reports: [alert, cancel] });
    expect(retiredAt(state, ended + RETENTION_HORIZON)).toEqual([alert.id, cancel.id].sort());
  });

  it("keeps an incident with a recent part: a later report, an end mark, a delivery or an acknowledgment", () => {
    const at = ended + RETENTION_HORIZON;
    const recent = at - RETENTION_HORIZON + 1;
    const update = report({ key: "k3", op: "update", references: ["k1"], sent: T0, expires: recent });
    const mark: EndMark = { report: alert.id, at: recent, ended: true };
    for (const parts of [{ reports: [alert, update] }, { reports: [alert], ends: [mark] }, { reports: [alert], deliveries: [delivery(alert, recent)] }, { reports: [alert], acks: [ack(alert, recent)] }]) {
      expect(retiredAt(normalize(parts), at)).toEqual([]);
    }
  });

  it("keeps a live incident at any age, also an open one with no expiry", () => {
    const { expires: _expires, ...open } = report({ key: "k4" });
    expect(retiredAt(normalize({ reports: [open] }), T0 + 365 * DAY)).toEqual([]);
    const later = report({ key: "k5", expires: T0 + 400 * DAY });
    expect(retiredAt(normalize({ reports: [later] }), T0 + 365 * DAY)).toEqual([]);
  });

  it("keeps a cancelled report until its expiry plus the horizon", () => {
    const longAlert = report({ key: "k6", expires: T0 + 10 * DAY });
    const cancel = report({ key: "k7", op: "cancel", references: ["k6"], sent: T0 + HOUR, expires: T0 + 2 * HOUR });
    const state = normalize({ reports: [longAlert, cancel] });
    expect(incidents(state, T0 + 3 * HOUR)[0]!.live).toBe(false);
    expect(retiredAt(state, T0 + 10 * DAY + RETENTION_HORIZON - 1)).toEqual([]);
    expect(retiredAt(state, T0 + 10 * DAY + RETENTION_HORIZON)).toHaveLength(2);
  });
});

describe("the quiet rule (AL-109)", () => {
  const alert = report({ key: "k1" });
  // The warning expires one hour after it was sent. That is its last change.
  const ended = T0 + HOUR;
  const quiet: QuietRule = { horizon: QUIET_HORIZON };
  const quietAt = (state: MergeState, at: number, rule: QuietRule = quiet): ReportId[] => retirements(state, incidents(state, at), at, RETENTION_HORIZON, rule);

  it("retires a quiet incident at the quiet horizon after its last change, and not before", () => {
    const state = normalize({ reports: [alert] });
    expect(QUIET_HORIZON).toBe(6 * HOUR);
    expect(quietAt(state, ended + QUIET_HORIZON - 1)).toEqual([]);
    expect(quietAt(state, ended + QUIET_HORIZON)).toEqual([alert.id]);
  });

  it("keeps an incident with a delivery or an acknowledgment for the full horizon, also an old one", () => {
    for (const parts of [{ reports: [alert], deliveries: [delivery(alert, T0)] }, { reports: [alert], acks: [ack(alert, T0)] }]) {
      const state = normalize(parts);
      expect(quietAt(state, ended + RETENTION_HORIZON - 1)).toEqual([]);
      expect(quietAt(state, ended + RETENTION_HORIZON)).toEqual([alert.id]);
    }
  });

  it("keeps the whole incident for the full horizon when a person knows one report of it", () => {
    const update = report({ key: "k2", op: "update", references: ["k1"], sent: T0 + 10 * 60_000, expires: ended });
    const state = normalize({ reports: [alert, update], deliveries: [delivery(update, T0 + 10 * 60_000)] });
    expect(incidents(state, ended)).toHaveLength(1);
    expect(quietAt(state, ended + QUIET_HORIZON)).toEqual([]);
    expect(quietAt(state, ended + RETENTION_HORIZON)).toEqual([alert.id, update.id].sort());
  });

  it("keeps an incident that the rule keeps for the full horizon", () => {
    const state = normalize({ reports: [alert] });
    const keeps = { horizon: QUIET_HORIZON, keeps: (incident: Incident) => incident.reports.includes(alert.id) };
    expect(quietAt(state, ended + QUIET_HORIZON, keeps)).toEqual([]);
    expect(quietAt(state, ended + RETENTION_HORIZON, keeps)).toEqual([alert.id]);
  });

  it("gives the full horizon with no rule, and the horizon to a quiet horizon that is longer", () => {
    const state = normalize({ reports: [alert] });
    expect(retirements(state, incidents(state, ended + QUIET_HORIZON), ended + QUIET_HORIZON)).toEqual([]);
    expect(retirements(state, incidents(state, ended + DAY - 1), ended + DAY - 1, DAY, { horizon: 30 * DAY })).toEqual([]);
    expect(retirements(state, incidents(state, ended + DAY), ended + DAY, DAY, { horizon: 30 * DAY })).toEqual([alert.id]);
  });

  it("keeps a live incident and an incident with an expiry in the future", () => {
    const { expires: _expires, ...open } = report({ key: "k3" });
    expect(quietAt(normalize({ reports: [open] }), T0 + 30 * DAY)).toEqual([]);
    const later = report({ key: "k4", expires: T0 + 2 * DAY });
    const state = normalize({ reports: [later], ends: [{ report: later.id, at: T0 + HOUR, ended: true }] });
    expect(incidents(state, T0 + DAY)[0]!.live).toBe(false);
    expect(quietAt(state, T0 + DAY)).toEqual([]);
    expect(quietAt(state, T0 + 2 * DAY + QUIET_HORIZON)).toEqual([later.id]);
  });
});

describe("the tombstones", () => {
  const alert = report({ key: "k1" });
  const at = T0 + HOUR + RETENTION_HORIZON;
  const until = at + TOMBSTONE_LIFE;
  const full = normalize({ reports: [alert], deliveries: [delivery(alert, T0)], acks: [ack(alert, T0)], ends: [{ report: alert.id, at: T0, ended: true }] });

  it("removes the report, its deliveries, its acknowledgments and its end marks", () => {
    same(retire(full, [alert.id], until), { ...EMPTY_STATE, retired: [{ report: alert.id, until }] });
  });

  it("keeps a late copy of a retired report out, from each side of a join", () => {
    const retired = retire(full, [alert.id], until);
    same(add(retired, { reports: [alert], deliveries: [delivery(alert, at)] }), retired);
    same(join(full, retired), retired);
    same(join(retired, full), retired);
  });

  it("keeps one tombstone for each report, with the latest end", () => {
    const twice = retire(retire(full, [alert.id], until), [alert.id], until - DAY);
    expect(twice.retired).toEqual([{ report: alert.id, until }]);
  });

  it("keeps the latest end in a join of the tombstones of two copies, in each order", () => {
    const early = retire(full, [alert.id], until - DAY);
    const late = retire(full, [alert.id], until);
    expect(join(early, late).retired).toEqual([{ report: alert.id, until }]);
    expect(join(late, early).retired).toEqual([{ report: alert.id, until }]);
  });

  it("keeps an incident that an end mark ended until its far expiry plus the horizon, and its tombstone lasts longer", () => {
    const far = report({ key: "k8", expires: T0 + 20 * DAY });
    const state = normalize({ reports: [far], ends: [{ report: far.id, at: T0 + HOUR, ended: true }] });
    expect(incidents(state, T0 + 2 * HOUR)[0]!.live).toBe(false);
    const due = T0 + 20 * DAY + RETENTION_HORIZON;
    expect(retiredAt(state, due - 1)).toEqual([]);
    expect(retiredAt(state, due)).toEqual([far.id]);
    // The end of the tombstone is after the expiry plus the horizon, thus a late copy of the report is not live again.
    const end = due + TOMBSTONE_LIFE;
    expect(end).toBeGreaterThan(far.expires! + RETENTION_HORIZON);
    const back = add(pruneTombstones(retire(state, [far.id], end), end), { reports: [far] });
    expect(incidents(back, end).map((incident) => incident.live)).toEqual([false]);
  });

  it("retires a report again at the next pass when it comes back after its tombstone dropped", () => {
    const pruned = pruneTombstones(retire(full, [alert.id], until), until);
    const back = add(pruned, { reports: [alert] });
    expect(incidents(back, until)[0]!.live).toBe(false);
    expect(retiredAt(back, until)).toEqual([alert.id]);
  });

  it("drops a tombstone at its end, and then a copy of the report can come back", () => {
    const retired = retire(full, [alert.id], until);
    expect(pruneTombstones(retired, until - 1)).toBe(retired);
    const pruned = pruneTombstones(retired, until);
    same(pruned, EMPTY_STATE);
    expect(add(pruned, { reports: [alert] }).reports).toEqual([alert]);
  });
});

// A random state over a span of days, so that some incidents are inside the horizon and some are not.
function randomState(r: Random): MergeState {
  const reports: Report[] = [];
  for (let i = r.int(1, 10); i > 0; i -= 1) {
    const event = r.below(5);
    const sent = T0 + r.below(20) * 12 * HOUR;
    const draft: Draft = {
      key: `k${event}.${r.below(3)}`,
      sent,
      received: sent + r.below(3) * 60_000,
      references: r.chance(0.4) ? [`k${event}.${r.below(3)}`] : [],
      correlation: r.chance(0.4) ? [{ system: "vtec", id: `KTOP.TO.W.${event}` }] : [],
      op: r.pick(["alert", "update", "cancel"] as const),
      kind: r.pick([
        { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
        { code: "met.flood", significance: "watch", label: "Flood Watch" },
      ]),
    };
    const made = report(draft);
    if (r.chance(0.15)) {
      const { expires: _expires, ...open } = made;
      reports.push(open);
    } else reports.push({ ...made, expires: sent + r.int(1, 72) * HOUR });
  }
  const pick = (): Report => r.pick(reports);
  const time = (): number => T0 + r.below(25) * 12 * HOUR;
  const deliveries = Array.from({ length: r.int(0, 4) }, () => delivery(pick(), time()));
  const acks = Array.from({ length: r.int(0, 2) }, () => ack(pick(), time()));
  const ends = Array.from({ length: r.int(0, 3) }, (): EndMark => ({ report: pick().id, at: time(), ended: r.chance(0.7) }));
  return normalize({ reports, deliveries, acks, ends });
}

// A link rule of one block for each kind, so that the gate also holds for the links of rule 3.
const LINK: IncidentOptions = { link: { blocks: (entry) => [entry.kind.code], matches: (a, b) => a.sent - b.sent < DAY && b.sent - a.sent < DAY } };

describe("the gate of the retention", () => {
  it.each(SEEDS)("changes no kept incident and no level of a person, with each link option (seed %i)", (seed) => {
    const r = random(seed);
    let retiredCount = 0;
    let keptCount = 0;
    for (let round = 0; round < 60; round += 1) {
      const state = randomState(r);
      const at = T0 + r.int(5, 40) * 12 * HOUR;
      const horizon = r.pick([DAY, 3 * DAY, RETENTION_HORIZON]);
      // A quiet rule only adds retirements, and only of incidents that no person knows and that the rule does not keep.
      const rule: QuietRule = { horizon: r.pick([HOUR, QUIET_HORIZON, 2 * DAY]), keeps: (incident) => incident.reports.length > 1 };
      for (const options of [{}, LINK]) {
        const found = incidents(state, at, options);
        const long = new Set(retirements(state, found, at, horizon));
        const gone = new Set(retirements(state, found, at, horizon, rule));
        for (const id of long) expect(gone.has(id)).toBe(true);
        const told = new Set([...state.deliveries.map((one) => one.incident), ...state.acks.map((one) => one.incident)]);
        for (const incident of found.filter((entry) => entry.reports.some((id) => gone.has(id) && !long.has(id)))) {
          expect(incident.reports.some((id) => told.has(id))).toBe(false);
          expect(rule.keeps?.(incident)).toBe(false);
        }
        const after = retire(state, [...gone], at + TOMBSTONE_LIFE);
        const kept: Incident[] = found.filter((incident) => !incident.reports.some((id) => gone.has(id)));
        retiredCount += found.length - kept.length;
        keptCount += kept.length;
        // A retirement takes whole incidents: no incident loses only a part of its reports.
        expect(found.filter((incident) => incident.reports.some((id) => gone.has(id))).every((incident) => incident.reports.every((id) => gone.has(id)))).toBe(true);
        same(incidents(after, at, options), kept);
        for (const incident of kept) {
          expect(sentLevel(after, incident, person)).toBe(sentLevel(state, incident, person));
          expect(acknowledgedLevel(after, incident, person)).toBe(acknowledgedLevel(state, incident, person));
        }
        // Each retired incident was not live, and nothing of it changed in the horizon.
        for (const incident of found.filter((entry) => entry.reports.some((id) => gone.has(id)))) expect(incident.live).toBe(false);
      }
    }
    // The random states retire some incidents and keep others, so the gate is not empty.
    expect(retiredCount).toBeGreaterThan(20);
    expect(keptCount).toBeGreaterThan(20);
  });

  it.each(SEEDS)("keeps the laws of the join with tombstones (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 40; round += 1) {
      const at = T0 + r.int(5, 40) * 12 * HOUR;
      const [a, b, c] = [randomState(r), randomState(r), randomState(r)].map((state) => {
        const gone = retiredAt(state, at);
        return retire(state, r.sample(gone, r.int(0, gone.length)), at + r.below(3) * DAY);
      }) as [MergeState, MergeState, MergeState];
      same(join(a, a), a);
      same(join(a, b), join(b, a));
      same(join(join(a, b), c), join(a, join(b, c)));
      same(join(a, EMPTY_STATE), a);
    }
  });
});
