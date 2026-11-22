import { canonicalJson, random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it, vi } from "vitest";
import type { Acknowledgment, ChannelId, Delivery, EndMark, Incident, MergeState, ObservationId, PersonId, Report, Severity, SourceId, Status } from "./contracts.ts";
import { reportId } from "./ids.ts";
import { areasWithoutBlocks } from "./shapes.ts";
import { EMPTY_STATE, acknowledgedLevel, add, endedReports, incidents, join, knowsReport, normalize, sentLevel, type IncidentOptions, type LinkRule, type MergeParts } from "./merge.ts";

// The count of canonical JSON texts. The mock gives the real text, thus each test reads the same values.
const texts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@mark1russell7/rigor-generators", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mark1russell7/rigor-generators")>();
  return {
    ...real,
    canonicalJson: (...args: Parameters<typeof real.canonicalJson>) => {
      texts.count += 1;
      return real.canonicalJson(...args);
    },
  };
});

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const HOUR = 3_600_000;
const T0 = 1_763_157_600_000;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;

interface Draft extends Partial<Omit<Report, "id" | "source">> {
  readonly source?: string;
  readonly key: string;
}

function report(draft: Draft): Report {
  const source = (draft.source ?? "nws-api") as SourceId;
  const sent = draft.sent ?? T0;
  const { source: _source, ...rest } = draft;
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
    ...rest,
    id: reportId({ source, key: draft.key, sent }),
    source,
    sent,
  };
}

const same = (a: unknown, b: unknown): void => expect(canonicalJson(a, { form: "json" })).toBe(canonicalJson(b, { form: "json" }));

// A random state over a small pool, so that two states share parts and have conflicts.
function randomState(r: Random): MergeState {
  const reports: Report[] = [];
  const deliveries: Delivery[] = [];
  const acks: Acknowledgment[] = [];
  const ends: EndMark[] = [];
  for (let i = r.int(0, 8); i > 0; i -= 1) {
    const event = r.below(4);
    const key = `k${event}.${r.below(3)}`;
    const blocked = r.chance(0.5);
    reports.push(
      report({
        key,
        source: r.pick(["nws-api", "ipaws"]),
        origin: r.pick(["nws", "usgs"]),
        sent: T0 + r.below(3) * 60_000,
        references: r.chance(0.4) ? [`k${event}.${r.below(3)}`] : [],
        correlation: r.chance(0.5) ? [{ system: "vtec", id: `KTOP.TO.W.${event}` }] : [],
        // Two sizes of area, so that the rule of the copies replaces some reports and keeps others. Some areas have
        // a block key, so that the laws also hold when the merge puts the report id before the key.
        areas: (r.chance(0.5) ? ["KSZ083"] : ["KSZ083", "KSZ084"]).map((code) => ({ type: "code" as const, system: "ugc", code, ...(blocked ? { block: "info[0].area[0]" } : {}) })),
        // An unknown value takes a value of its event, so the laws also hold for the fill.
        severity: r.pick(["unknown", "moderate", "severe", "extreme"] as const),
        urgency: r.pick(["unknown", "expected", "immediate"] as const),
        op: r.pick(["alert", "update", "cancel"] as const),
        status: r.chance(0.9) ? "actual" : "test",
        // Two contents for one id: the merge keeps the smaller canonical JSON.
        headline: r.pick(["Tornado Warning", "Tornado Warning (copy)"]),
      }),
    );
  }
  for (let i = r.int(0, 3); i > 0; i -= 1) {
    const incident = reports.length > 0 ? r.pick(reports).id : report({ key: "k0.0" }).id;
    deliveries.push({ key: `m${r.below(4)}`, incident, level: r.pick(["notice", "urgent", "life-safety"] as const), person, channel: pushover, step: r.below(2), at: T0, ...(r.chance(0.5) ? { receipt: { id: `r${r.below(3)}` } } : {}) });
  }
  for (let i = r.int(0, 2); i > 0; i -= 1) {
    const incident = reports.length > 0 ? r.pick(reports).id : report({ key: "k0.0" }).id;
    acks.push({ incident, level: r.pick(["urgent", "life-safety"] as const), person, at: T0 + r.below(3), via: "ui" });
  }
  // Marks at a small set of times, so that two marks of one report often have the same time.
  for (let i = r.int(0, 3); i > 0; i -= 1) {
    const ended = reports.length > 0 ? r.pick(reports).id : report({ key: "k0.0" }).id;
    ends.push({ report: ended, at: T0 + r.below(3) * HOUR, ended: r.chance(0.7) });
  }
  return normalize({ reports, deliveries, acks, ends });
}

describe("the join", () => {
  it.each(SEEDS)("is idempotent, commutative and associative (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 50; round += 1) {
      const [a, b, c] = [randomState(r), randomState(r), randomState(r)];
      same(join(a, a), a);
      same(join(a, b), join(b, a));
      same(join(join(a, b), c), join(a, join(b, c)));
      same(join(a, EMPTY_STATE), a);
    }
  });

  it.each(SEEDS)("gives the same incidents for each order of arrival (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 30; round += 1) {
      const all = join(join(randomState(r), randomState(r)), randomState(r));
      const parts = [
        ...all.reports.map((x) => ({ reports: [x] })),
        ...all.deliveries.map((x) => ({ deliveries: [x] })),
        ...all.acks.map((x) => ({ acks: [x] })),
        ...all.ends.map((x) => ({ ends: [x] })),
      ];
      // Each part arrives one or more times, in a random order.
      const arrivals = r.shuffle([...parts, ...r.sample(parts, r.int(0, parts.length))]);
      const built = arrivals.reduce(add, EMPTY_STATE);
      same(built, all);
      const at = T0 + r.below(3) * HOUR;
      same(incidents(built, at), incidents(all, at));
    }
  });

  it("keeps one report for an id with two contents: the smaller canonical JSON", () => {
    const a = report({ key: "k", headline: "B" });
    const b = report({ key: "k", headline: "A" });
    expect(normalize({ reports: [a, b] }).reports).toEqual([b]);
    expect(normalize({ reports: [b, a] }).reports).toEqual([b]);
  });

  it("keeps the smallest of three contents of one id in each order, through normalize and through add", () => {
    const contents = ["C", "A", "B"].map((headline) => report({ key: "k", headline }));
    const smallest = contents[1]!;
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((at) => contents[at]!));
    for (const order of orders) {
      expect(normalize({ reports: order }).reports).toEqual([smallest]);
      expect(order.reduce((state, item) => add(state, { reports: [item] }), EMPTY_STATE).reports).toEqual([smallest]);
    }
    // The same object two times is one content.
    expect(normalize({ reports: [smallest, smallest] }).reports).toEqual([smallest]);
    expect(add(normalize({ reports: [smallest] }), { reports: [smallest] }).reports).toEqual([smallest]);
  });

  it("keeps each delivery and each acknowledgment one time", () => {
    const delivery: Delivery = { key: "m", incident: report({ key: "k" }).id, level: "urgent", person, channel: pushover, step: 0, at: T0 };
    const state = add(add(EMPTY_STATE, { deliveries: [delivery] }), { deliveries: [{ ...delivery }] });
    expect(state.deliveries).toHaveLength(1);
  });

  it("keeps each end mark one time", () => {
    const mark: EndMark = { report: report({ key: "k" }).id, at: T0, ended: true };
    expect(add(add(EMPTY_STATE, { ends: [mark] }), { ends: [{ ...mark }] }).ends).toEqual([mark]);
  });
});

// Random parts over the pool of the random states. Some parts retire a report of the state or of the parts.
function randomParts(r: Random, from: MergeState): MergeParts {
  const other = randomState(r);
  const ids = [...from.reports, ...other.reports].map((x) => x.id);
  return {
    reports: r.sample(other.reports, r.int(0, other.reports.length)),
    deliveries: other.deliveries,
    acks: other.acks,
    ends: other.ends,
    ...(ids.length > 0 && r.chance(0.3) ? { retired: [{ report: r.pick(ids), until: T0 + r.below(3) * HOUR }] } : {}),
  };
}

// The normalize of the parts of a state and of new parts: the value that `add` gives.
const fullAdd = (state: MergeState, parts: MergeParts): MergeState =>
  normalize({
    reports: [...state.reports, ...(parts.reports ?? [])],
    deliveries: [...state.deliveries, ...(parts.deliveries ?? [])],
    acks: [...state.acks, ...(parts.acks ?? [])],
    ends: [...state.ends, ...(parts.ends ?? [])],
    retired: [...state.retired, ...(parts.retired ?? [])],
  });

describe("the add of parts", () => {
  it.each(SEEDS)("gives the normalize of all the parts, for a state in the one form and for a copy of it (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 60; round += 1) {
      let state = randomState(r);
      for (let step = 0; step < 5; step += 1) {
        const parts = randomParts(r, state);
        const full = fullAdd(state, parts);
        same(add(state, parts), full);
        // A copy is not in the one form for the merge, so it gets the full normalize.
        same(add({ ...state }, parts), full);
        state = add(state, parts);
      }
    }
  });

  it("gives the same state when no part is new", () => {
    const a = report({ key: "a" });
    const mark: EndMark = { report: a.id, at: T0, ended: true };
    const state = normalize({ reports: [a, report({ key: "b" })], ends: [mark], retired: [{ report: report({ key: "c" }).id, until: T0 + HOUR }] });
    expect(add(state, {})).toBe(state);
    // Equal copies of the parts, and a tombstone with an earlier end, change nothing.
    expect(add(state, { reports: [report({ key: "a" })], ends: [{ ...mark }], retired: [{ report: report({ key: "c" }).id, until: T0 }] })).toBe(state);
  });

  it("keeps each report object of a large state, and puts a new report in the order of the ids", () => {
    const state = normalize({ reports: Array.from({ length: 2000 }, (_, i) => report({ key: `k${i}` })) });
    const extra = report({ key: "new" });
    const next = add(state, { reports: [extra] });
    same(next, fullAdd(state, { reports: [extra] }));
    expect(next.reports).toHaveLength(2001);
    expect(next.reports.filter((x) => x !== extra).every((x, i) => x === state.reports[i])).toBe(true);
    expect(next.deliveries).toBe(state.deliveries);
  });

  it("removes the parts of a report that a new tombstone retires", () => {
    const a = report({ key: "a" });
    const state = normalize({ reports: [a, report({ key: "b" })], deliveries: [{ key: "m1", incident: a.id, level: "urgent", person, channel: pushover, step: 0, at: T0 }] });
    const next = add(state, { retired: [{ report: a.id, until: T0 + HOUR }] });
    expect(next.reports.map((x) => x.id)).toEqual([report({ key: "b" }).id]);
    expect(next.deliveries).toEqual([]);
    // A report with a tombstone does not come back.
    expect(add(next, { reports: [a] })).toBe(next);
  });

  it("knows each report and each tombstone of a state, in the one form and in a copy (AL-132)", () => {
    const kept = Array.from({ length: 300 }, (_, i) => report({ key: `k${i}` }));
    const gone = report({ key: "gone" });
    const state = normalize({ reports: kept, retired: [{ report: gone.id, until: T0 + HOUR }] });
    const fresh = report({ key: "fresh" });
    for (const each of [state, { ...state }]) {
      expect(kept.every((x) => knowsReport(each, x.id))).toBe(true);
      expect(knowsReport(each, gone.id)).toBe(true);
      expect(knowsReport(each, fresh.id)).toBe(false);
    }
    expect(knowsReport(EMPTY_STATE, fresh.id)).toBe(false);
    // An id that the state does not know is a report that an add puts into the state.
    expect(add(state, { reports: [fresh] }).reports).toHaveLength(kept.length + 1);
  });
});

describe("the cache of the incidents", () => {
  const link: LinkRule = { blocks: (x) => [x.headline], matches: (a, b) => a.source !== b.source };
  const choices: readonly IncidentOptions[] = [{}, { link }];

  it.each(SEEDS)("gives the incidents of a fresh copy of the state, at each time in each order (seed %i)", (seed) => {
    const r = random(seed);
    let state = EMPTY_STATE;
    for (let round = 0; round < 40; round += 1) {
      state = add(state, randomParts(r, state));
      for (const at of r.shuffle([T0 - HOUR, T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR])) {
        for (const options of choices) same(incidents(state, at, options), incidents(structuredClone(state), at, options));
      }
    }
  });

  it("makes an incident live again for a past time, after a later time ended it", () => {
    const state = normalize({ reports: [report({ key: "a" })] });
    expect(incidents(state, T0)[0]!.live).toBe(true);
    expect(incidents(state, T0 + 2 * HOUR)[0]!.live).toBe(false);
    expect(incidents(state, T0)[0]!.live).toBe(true);
  });
});

describe("the end marks of a snapshot source", () => {
  const row = report({ key: "row", source: "iem", correlation: [{ system: "vtec", id: "KTOP.TO.W.1" }] });
  const mark = (at: number, ended: boolean): EndMark => ({ report: row.id, at, ended });
  const liveAt = (ends: readonly EndMark[], at: number): boolean | undefined => incidents(normalize({ reports: [row], ends }), at)[0]?.live;

  it("ends a report from the time of its mark, and not before", () => {
    const ends = [mark(T0 + 600_000, true)];
    expect(liveAt(ends, T0 + 599_999)).toBe(true);
    expect(liveAt(ends, T0 + 600_000)).toBe(false);
    expect([...endedReports(normalize({ ends }), T0 + 600_000)]).toEqual([row.id]);
  });

  it("makes a report live again with a later mark that is not an end", () => {
    const ends = [mark(T0 + 600_000, true), mark(T0 + 1_200_000, false)];
    expect(liveAt(ends, T0 + 900_000)).toBe(false);
    expect(liveAt(ends, T0 + 1_200_000)).toBe(true);
    expect(liveAt([...ends, mark(T0 + 1_800_000, true)], T0 + 1_800_000)).toBe(false);
  });

  it("keeps a report live when an end and a return have one time, in each order", () => {
    expect(liveAt([mark(T0, true), mark(T0, false)], T0 + 1)).toBe(true);
    expect(liveAt([mark(T0, false), mark(T0, true)], T0 + 1)).toBe(true);
  });

  it("keeps the incident live while a different head is live, with the level of the live heads", () => {
    const api = report({ key: "api", correlation: row.correlation, severity: "severe" });
    const [one] = incidents(normalize({ reports: [row, api], ends: [mark(T0, true)] }), T0 + 1);
    expect(one).toMatchObject({ live: true, severity: "severe", corroboration: 1 });
    const [ended] = incidents(normalize({ reports: [row, api], ends: [mark(T0, true), { report: api.id, at: T0, ended: true }] }), T0 + 1);
    expect(ended?.live).toBe(false);
  });

  it("changes no group: a mark reads only the field live", () => {
    const api = report({ key: "api", correlation: row.correlation });
    const groups = (ends: readonly EndMark[]) => incidents(normalize({ reports: [row, api], ends }), T0 + 1).map((incident) => incident.reports);
    expect(groups([mark(T0, true)])).toEqual(groups([]));
  });
});

describe("the incidents", () => {
  it("links an update and a cancel to their alert by the references (rule 1)", () => {
    const alert = report({ key: "a1" });
    const update = report({ key: "a2", references: ["a1"], op: "update", severity: "severe", sent: T0 + 60_000 });
    const [one] = incidents(normalize({ reports: [alert, update] }), T0);
    expect(one?.reports).toHaveLength(2);
    // The update is the head of the line, so its severity counts, not the severity of the alert.
    expect(one?.severity).toBe("severe");
    expect(one?.live).toBe(true);

    const cancel = report({ key: "a3", references: ["a2"], op: "cancel", sent: T0 + 120_000 });
    const [after] = incidents(normalize({ reports: [alert, update, cancel] }), T0);
    expect(after?.reports).toHaveLength(3);
    expect(after?.live).toBe(false);
  });

  it("links the copy of another source by a shared correlation key (rule 2), and counts the origins", () => {
    // The NWS API and IPAWS give one warning different CAP identifiers. Only the VTEC key links them.
    const vtec = [{ system: "vtec", id: "KTOP.TO.W.0038.2026" }];
    const api = report({ key: "urn:oid:2.49.0.1.840.0.example.001.1", correlation: vtec });
    const ipaws = report({ source: "ipaws", key: "urn:oid:2.49.0.1.840.0.example.001.1.IPAWS", correlation: vtec, sent: T0 + 30_000 });
    const [one, ...rest] = incidents(normalize({ reports: [api, ipaws] }), T0);
    expect(rest).toEqual([]);
    expect(one?.reports).toHaveLength(2);
    // Both copies come from the NWS: one witness, two times.
    expect(one?.corroboration).toBe(1);

    const quake = report({ source: "usgs", origin: "usgs", key: "us7000example", correlation: vtec });
    expect(incidents(normalize({ reports: [api, ipaws, quake] }), T0)[0]?.corroboration).toBe(2);
  });

  it("does not link a reference of one source to a key of another source", () => {
    const a = report({ key: "k1" });
    const b = report({ source: "ipaws", key: "k2", references: ["k1"] });
    expect(incidents(normalize({ reports: [a, b] }), T0)).toHaveLength(2);
  });

  it("keeps the reports of two statuses apart", () => {
    const correlation = [{ system: "vtec", id: "KTOP.TO.W.0001.2026" }];
    const statuses: Status[] = ["actual", "test"];
    const list = incidents(normalize({ reports: statuses.map((status) => report({ key: status, status, correlation })) }), T0);
    expect(list.map((incident) => incident.status).sort()).toEqual(statuses);
  });

  it("is not live after each head expires, and it is open while one head has no end", () => {
    const short = report({ key: "s", expires: T0 + HOUR });
    const long = report({ key: "l", expires: T0 + 2 * HOUR, correlation: [{ system: "vtec", id: "x" }] });
    const state = normalize({ reports: [short, long] });
    const holding = (list: readonly Incident[], r: Report): Incident | undefined => list.find((i) => i.reports.includes(r.id));
    // The end time is not part of the live time: at the end, the report is expired.
    const atOneHour = incidents(state, T0 + HOUR);
    expect(holding(atOneHour, short)?.live).toBe(false);
    expect(holding(atOneHour, long)?.live).toBe(true);
    expect(incidents(state, T0 + 2 * HOUR).every((i) => !i.live)).toBe(true);

    expect(incidents(normalize({ reports: [long] }), T0)[0]?.expires).toBe(T0 + 2 * HOUR);
    const { expires: _end, ...open } = report({ source: "ipaws", key: "o", correlation: [{ system: "vtec", id: "x" }] });
    const [linked] = incidents(normalize({ reports: [long, open] }), T0 + 3 * HOUR);
    expect(linked?.expires).toBeUndefined();
    expect(linked?.live).toBe(true);
  });

  it("gives each report a head when the references make a cycle, and does not throw", () => {
    const a = report({ key: "a", references: ["b"] });
    const b = report({ key: "b", references: ["a"] });
    const [one] = incidents(normalize({ reports: [a, b] }), T0);
    expect(one?.reports).toHaveLength(2);
    expect(one?.live).toBe(true);
  });

  it("links by the link rule only inside a block, and the links are transitive (rule 3)", () => {
    let tests = 0;
    const rule: LinkRule = {
      blocks: (r) => [r.kind.code],
      matches: (a, b) => {
        tests += 1;
        return Math.abs(a.sent - b.sent) <= 10 * 60_000;
      },
    };
    const reports = [
      report({ key: "t1", sent: T0 }),
      report({ key: "t2", sent: T0 + 8 * 60_000 }),
      report({ key: "t3", sent: T0 + 16 * 60_000 }),
      report({ key: "q1", sent: T0, kind: { code: "geo.earthquake", label: "Earthquake" } }),
    ];
    const list = incidents(normalize({ reports }), T0, { link: rule });
    expect(list.map((incident) => incident.reports.length).sort()).toEqual([1, 3]);
    // Three pairs share the tornado block. The earthquake shares no block, so the rule does not test it.
    expect(tests).toBe(3);
  });

  it("gives the incidents in the order of their anchors, and the anchor is the smallest report id", () => {
    const list = incidents(randomState(random(11)), T0);
    expect(list.map((i) => i.anchor)).toEqual([...list.map((i) => i.anchor)].sort());
    for (const incident of list) expect(incident.anchor).toBe([...incident.reports].sort()[0]);
  });
});

describe("the copies of one event", () => {
  const vtec = [{ system: "vtec", id: "KTOP.TO.W.0012.2025" }];
  const codes = (...list: string[]): Report["areas"] => list.map((code) => ({ type: "code", system: "ugc", code }));
  const later = T0 + 600_000;
  const at = T0 + 700_000;
  // The alert of the NWS API, and a copy of it from IPAWS: one origin, one VTEC event, one sent time.
  const alert = report({ key: "api-1", correlation: vtec, areas: codes("KSC177", "KSC045") });
  const copy = report({ key: "ipaws-1", source: "ipaws", correlation: vtec, areas: codes("KSC177", "KSC045") });
  const liveOf = (...reports: Report[]): boolean | undefined => incidents(normalize({ reports }), at)[0]?.live;

  it("ends the copy of another source when a later report of the origin names each of its codes", () => {
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045") });
    expect(liveOf(alert, copy)).toBe(true);
    expect(liveOf(alert, copy, cancel)).toBe(false);
    // A later update replaces the copy too: the incident takes its severity.
    const update = report({ key: "api-2", op: "update", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "severe" });
    expect(incidents(normalize({ reports: [alert, copy, update] }), at)[0]?.severity).toBe("severe");
  });

  it("keeps the copy live when the later reports name only a part of its codes", () => {
    // The NWS cancels the warning for one county. The update for the other county is missing.
    const partial = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC045") });
    const [incident] = incidents(normalize({ reports: [alert, copy, partial] }), at);
    expect(incident?.live).toBe(true);
    // The cancelled county leaves the incident: the copy gives only the county that no later report names.
    expect(incident?.areas).toEqual(codes("KSC177"));
  });

  it("keeps the rest of a report live after a lone cancel of a part", () => {
    // The cancel of one county references the message of two counties. The update for the other county is lost.
    const partial = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC045") });
    const [incident] = incidents(normalize({ reports: [alert, partial] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toEqual(codes("KSC177"));
    // The same cancel with no shared correlation key: the reference alone states the county.
    const bare = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: [], areas: codes("KSC045") });
    expect(incidents(normalize({ reports: [alert, bare] }), at)[0]?.areas).toEqual(codes("KSC177"));
    // Two cancels of a part that together name each county end the report.
    const rest = report({ key: "api-3", op: "cancel", sent: later, references: ["api-1"], correlation: [], areas: codes("KSC177") });
    expect(liveOf(alert, bare, rest)).toBe(false);
  });

  it("takes the areas of the segments of the NWS: a cancel of a part and an update of the rest", () => {
    const partial = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC045") });
    const rest = report({ key: "api-3", op: "update", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177"), severity: "severe" });
    const [incident] = incidents(normalize({ reports: [alert, copy, partial, rest] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toEqual(codes("KSC177"));
    expect(incident?.severity).toBe("severe");
  });

  it("ends the whole report on an update, or on a cancel that is not of a part, as CAP tells", () => {
    // An update states the new area, so the county that it does not name ends.
    const update = report({ key: "api-2", op: "update", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177") });
    expect(incidents(normalize({ reports: [alert, update] }), at)[0]?.areas).toEqual(codes("KSC177"));
    // A cancel that names another code, or no code, is not a cancel of a part.
    const other = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC045", "KSC139") });
    expect(liveOf(alert, other)).toBe(false);
    const shape = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: [], areas: [{ type: "polygon", rings: [[[-95.8, 39.0], [-95.6, 39.0], [-95.6, 39.1], [-95.8, 39.0]]] }] });
    expect(liveOf(alert, shape)).toBe(false);
  });

  it("removes the shapes of a block with a code that has a later statement", () => {
    const polygon = { type: "polygon", rings: [[[-95.8, 39.0], [-95.6, 39.0], [-95.6, 39.1], [-95.8, 39.0]]] } as const;
    const code = (name: string, block?: string): Report["areas"][number] => ({ type: "code", system: "ugc", code: name, ...(block === undefined ? {} : { block }) });
    const row = report({ key: "iem-KSC177", source: "iem", op: "cancel", sent: later, correlation: vtec, areas: codes("KSC177") });
    // The block of the cancelled county goes, with its polygon. The county with no block stays.
    const one = report({ key: "api-1", correlation: vtec, areas: [{ ...polygon, block: "feature" }, code("KSC177", "feature"), code("KSC045")] });
    expect(incidents(normalize({ reports: [one, row] }), at)[0]?.areas).toEqual(codes("KSC045"));
    // A block of two counties keeps the other county, with no polygon. The block then decides by that county.
    const two = report({ key: "api-1", correlation: vtec, areas: [{ ...polygon, block: "feature" }, code("KSC177", "feature"), code("KSC045", "feature")] });
    expect(incidents(normalize({ reports: [two, row] }), at)[0]?.areas).toEqual([code("KSC045", `${two.id}/feature`)]);
  });

  it("gives a county to the incident again when a later alert names it again", () => {
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045") });
    const again = report({ key: "api-3", sent: later + 60_000, correlation: vtec, areas: codes("KSC177") });
    const [incident] = incidents(normalize({ reports: [alert, cancel, again] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toEqual(codes("KSC177"));
  });

  it.each(SEEDS)("keeps exactly the codes that no cancel of a part names, when no other cancel ends the report (seed %i)", (seed) => {
    const r = random(seed);
    const pool = ["KSC177", "KSC045", "KSC139", "KSC197"];
    for (let round = 0; round < 50; round += 1) {
      const own = r.sample(pool, r.int(1, pool.length));
      const base = report({ key: "api-1", correlation: vtec, areas: codes(...own) });
      const cancels = Array.from({ length: r.int(1, 3) }, (_, i) =>
        report({
          key: `api-${i + 2}`,
          op: "cancel",
          // A tie with the alert gives no statement by the event, so the reference alone decides.
          sent: r.chance(0.3) ? T0 : later + i * 60_000,
          references: ["api-1"],
          correlation: r.chance(0.5) ? vtec : [],
          // Most cancels name a part of the codes of the alert. Some name another code too.
          areas: codes(...(r.chance(0.8) ? r.sample(own, r.int(1, own.length)) : [...r.sample(own, 1), "KSC999"])),
        }),
      );
      const [incident] = incidents(normalize({ reports: [base, ...cancels] }), at);
      const namedBy = (held: Report): string[] => held.areas.flatMap((area) => (area.type === "code" ? [area.code] : []));
      const parts = cancels.filter((held) => namedBy(held).length < own.length && namedBy(held).every((code) => own.includes(code)));
      const left = own.filter((code) => !parts.some((held) => namedBy(held).includes(code)));
      const live = parts.length === cancels.length && left.length > 0;
      expect(incident?.live, `seed ${seed} round ${round}`).toBe(live);
      if (live) expect(namedBy({ ...base, areas: incident!.areas }).sort(), `seed ${seed} round ${round}`).toEqual([...left].sort());
    }
  });

  it("does not end a copy of another origin, of the same sent time, of another event or with no code", () => {
    const cancel = (fields: Partial<Draft>): Report => report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), ...fields });
    expect(liveOf(alert, { ...copy, origin: "fema" }, cancel({}))).toBe(true);
    expect(liveOf(alert, copy, cancel({ sent: T0 }))).toBe(true);
    const other = report({ key: "ipaws-1", source: "ipaws", correlation: [{ system: "vtec", id: "KTOP.TO.W.0013.2025" }, ...vtec], areas: codes("KSC177", "KSC045") });
    // The copy shares the event of the cancel, so the cancel ends it. A copy that shares no key is not in the incident.
    expect(liveOf(alert, other, cancel({}))).toBe(false);
    const shapeOnly = report({ key: "ipaws-1", source: "ipaws", correlation: vtec, areas: [{ type: "polygon", rings: [[[-95.8, 39.0], [-95.6, 39.0], [-95.6, 39.1], [-95.8, 39.0]]] }] });
    expect(liveOf(alert, shapeOnly, cancel({}))).toBe(true);
  });

  it("puts the report id before each block key, so the blocks of two copies stay apart", () => {
    const polygon = { type: "polygon", rings: [[[-95.8, 39.0], [-95.6, 39.0], [-95.6, 39.1], [-95.8, 39.0]]] } as const;
    const api = report({ key: "api-1", correlation: vtec, areas: [{ ...polygon, block: "feature" }, { type: "code", system: "ugc", code: "KSC177", block: "feature" }, ...codes("KSC045")] });
    const ipaws = report({ key: "ipaws-1", source: "ipaws", correlation: vtec, areas: [{ type: "code", system: "ugc", code: "KSC177", block: "feature" }] });
    const [incident] = incidents(normalize({ reports: [api, ipaws] }), at);
    const blocks = (incident?.areas ?? []).map((area) => (area.type === "place" ? "place" : (area.block ?? "none")));
    expect(blocks.sort()).toEqual([`${api.id}/feature`, `${api.id}/feature`, `${ipaws.id}/feature`, "none"].sort());
    // The map and the views draw each area one time.
    expect(areasWithoutBlocks(incident?.areas ?? [])).toHaveLength(3);
  });

  it("ends a report when the later reports together name each of its codes", () => {
    // IEM gives one row for each county. Each row is a report of its own.
    const row = (code: string, op: Report["op"], sent = later): Report => report({ key: `iem-${code}-${sent}`, source: "iem", op, sent, correlation: vtec, areas: codes(code) });
    expect(liveOf(alert, row("KSC177", "cancel"), row("KSC045", "cancel"))).toBe(false);
    // The authority ends one county and keeps the other: the incident keeps only the other county.
    const [incident] = incidents(normalize({ reports: [alert, row("KSC177", "cancel"), row("KSC045", "update")] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toEqual(codes("KSC045"));
    // The rows of the first message end when the NWS API cancels the two counties.
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045") });
    expect(liveOf(alert, row("KSC177", "alert", T0), row("KSC045", "alert", T0), cancel)).toBe(false);
  });

  it("fills an unknown value from the latest earlier report of the event that is not a cancel", () => {
    // IEM gives no severity, urgency or certainty.
    const blank = { severity: "unknown", urgency: "unknown", certainty: "unknown" } as const;
    const row = (code: string, sent: number): Report => report({ key: `iem-${code}-${sent}`, source: "iem", sent, correlation: vtec, areas: codes(code), ...blank });
    const api = report({ key: "api-1", correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "moderate", urgency: "expected", certainty: "likely" });
    const values = (...reports: Report[]): unknown => {
      const [incident] = incidents(normalize({ reports }), at);
      return { live: incident?.live, severity: incident?.severity, urgency: incident?.urgency, certainty: incident?.certainty };
    };
    // The rows of a later product replace the message of the NWS API, and keep its values.
    expect(values(api, row("KSC177", later), row("KSC045", later))).toEqual({ live: true, severity: "moderate", urgency: "expected", certainty: "likely" });
    // With no known value, the value stays unknown.
    expect(values(row("KSC177", later))).toEqual({ live: true, ...blank });
    // A cancel gives the values of an end, so a row after the cancel takes the values of the alert.
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "minor", urgency: "past", certainty: "observed" });
    expect(values(api, cancel, row("KSC177", later + 60_000))).toEqual({ live: true, severity: "moderate", urgency: "expected", certainty: "likely" });
    // A known value of a later report does not fill an earlier report. This later report has expired, so it is not live.
    const late = report({ key: "api-9", sent: at, expires: at, correlation: vtec, areas: codes("KSC139"), severity: "extreme", urgency: "immediate", certainty: "observed" });
    expect(values(row("KSC177", later), late)).toEqual({ live: true, ...blank });
  });

  it.each(SEEDS)("is live exactly when the latest report of some code is not a cancel (seed %i)", (seed) => {
    const r = random(seed);
    const pool = ["KSC177", "KSC045", "KSC139", "KSC197"];
    for (let round = 0; round < 50; round += 1) {
      const reports = Array.from({ length: r.int(2, 6) }, (_, i) =>
        report({
          key: `k${i}`,
          source: r.pick(["nws-api", "ipaws", "iem"]),
          sent: T0 + r.below(4) * 60_000,
          op: r.pick(["alert", "update", "cancel"] as const),
          correlation: vtec,
          // Half of the reports name one code, as the rows of IEM do.
          areas: codes(...r.sample(pool, r.chance(0.5) ? 1 : r.int(1, pool.length))),
          severity: r.pick(["unknown", "minor", "moderate", "severe", "extreme"] as const),
          urgency: r.pick(["unknown", "future", "expected", "immediate"] as const),
        }),
      );
      const [incident] = incidents(normalize({ reports }), at);
      // The latest statements of each code: the reports with the latest sent time that name the code.
      let live = false;
      for (const code of pool) {
        const naming = reports.filter((held) => held.areas.some((area) => area.type === "code" && area.code === code));
        const last = Math.max(...naming.map((held) => held.sent));
        if (!naming.some((held) => held.sent === last && held.op !== "cancel")) continue;
        // No later report names this code, so the incident keeps it.
        live = true;
        expect(incident?.areas, `seed ${seed} round ${round}`).toContainEqual({ type: "code", system: "ugc", code });
      }
      expect(incident?.live, `seed ${seed} round ${round}`).toBe(live);
      // The oracle: the rule in its direct form. A report stays a head when a code of it has no later report.
      const named = (held: Report, code: string): boolean => held.areas.some((area) => area.type === "code" && area.code === code);
      const heads = reports.filter((held) => pool.some((code) => named(held, code) && !reports.some((other) => other.sent > held.sent && named(other, code))));
      const liveHeads = heads.filter((held) => held.op !== "cancel");
      const basis = liveHeads.length > 0 ? liveHeads : heads;
      // Each head gives only its codes that no later report names.
      const fresh = (held: Report, code: string): boolean => !reports.some((other) => other.sent > held.sent && named(other, code));
      const expected = [...new Set(basis.flatMap((held) => held.areas.flatMap((area) => (area.type === "code" && fresh(held, area.code) ? [area.code] : []))))].sort();
      expect(incident?.areas.map((area) => (area.type === "code" ? area.code : "")).sort(), `seed ${seed} round ${round}`).toEqual(expected);
      // The oracle of the values: an unknown value takes the highest value of the latest earlier known reports that are not cancels.
      const fill = <F extends "severity" | "urgency">(held: Report, field: F, order: readonly Report[F][]): number => {
        if (held[field] !== "unknown") return order.indexOf(held[field]);
        const known = reports.filter((other) => other.op !== "cancel" && other[field] !== "unknown" && other.sent <= held.sent);
        const last = Math.max(...known.map((other) => other.sent));
        return Math.max(0, ...known.filter((other) => other.sent === last).map((other) => order.indexOf(other[field])));
      };
      const severities = ["unknown", "minor", "moderate", "severe", "extreme"] as const;
      const urgencies = ["unknown", "past", "future", "expected", "immediate"] as const;
      expect(incident?.severity, `seed ${seed} round ${round}`).toBe(severities[Math.max(...basis.map((held) => fill(held, "severity", severities)))]);
      expect(incident?.urgency, `seed ${seed} round ${round}`).toBe(urgencies[Math.max(...basis.map((held) => fill(held, "urgency", urgencies)))]);
    }
  });
});

describe("the levels of a person", () => {
  const alert = report({ key: "a1" });
  const copy = report({ source: "ipaws", key: "a1.IPAWS", correlation: [{ system: "vtec", id: "KTOP.TO.W.0002.2026" }] });
  const linked = report({ key: "a2", correlation: [{ system: "vtec", id: "KTOP.TO.W.0002.2026" }], references: ["a1"] });
  const send = (incident: Report, level: Delivery["level"]): Delivery => ({
    key: `${incident.key}.${level}`,
    incident: incident.id,
    level,
    person,
    channel: pushover,
    step: 0,
    at: T0,
  });

  it("gives the highest level of the deliveries to the person", () => {
    const state = normalize({ reports: [alert], deliveries: [send(alert, "notice"), send(alert, "urgent")] });
    const [incident] = incidents(state, T0);
    expect(sentLevel(state, incident!, person)).toBe("urgent");
    expect(sentLevel(state, incident!, "person-2" as PersonId)).toBeUndefined();
  });

  it("keeps the sent level and the acknowledgment when two incidents merge", () => {
    const before = normalize({
      reports: [alert, copy],
      deliveries: [send(copy, "urgent")],
      acks: [{ incident: copy.id, level: "urgent", person, at: T0, via: "ui" }],
    });
    expect(incidents(before, T0)).toHaveLength(2);
    const after = add(before, { reports: [linked] });
    const [merged, ...rest] = incidents(after, T0);
    expect(rest).toEqual([]);
    expect(sentLevel(after, merged!, person)).toBe("urgent");
    expect(acknowledgedLevel(after, merged!, person)).toBe("urgent");
  });
});

describe("the lines of an incident (AL-14)", () => {
  // The bands of the shaking of one made-up earthquake at 0, 0: one report for each band, with one circle.
  const band = (key: string, severity: Severity, radiusKm: number): Report =>
    report({
      key,
      kind: { code: "geo.earthquake", label: "Earthquake" },
      severity,
      correlation: [{ system: "quake", id: "q1" }],
      areas: [{ type: "circle", center: [0, 0], radiusKm, block: "band" }],
    });
  const bands = [band("b1", "extreme", 40), band("b2", "severe", 76), band("b3", "moderate", 137), band("b4", "minor", 522)];

  it("gives one line for each live head, with its values and its areas", () => {
    const [one, ...rest] = incidents(normalize({ reports: bands }), T0 + 1);
    expect(rest).toEqual([]);
    expect(one?.severity).toBe("extreme");
    const lines = one?.lines ?? [];
    expect(lines.map((line) => [line.severity, line.areas])).toEqual(
      [...bands].sort((a, b) => (a.id < b.id ? -1 : 1)).map((head) => [head.severity, [{ ...head.areas[0], block: `${head.id}/band` }]]),
    );
    expect(new Set(lines.map((line) => line.report))).toEqual(new Set(bands.map((head) => head.id)));
    // The areas of the incident are the areas of its lines.
    expect(new Set(one?.areas.map((area) => JSON.stringify(area)))).toEqual(new Set(lines.flatMap((line) => line.areas.map((area) => JSON.stringify(area)))));
  });

  it("gives no lines when the values of the heads are equal, or for one head", () => {
    const equal = [band("b1", "severe", 40), band("b2", "severe", 76)];
    expect(incidents(normalize({ reports: equal }), T0 + 1)[0]?.lines).toBeUndefined();
    expect(incidents(normalize({ reports: [bands[0] as Report] }), T0 + 1)[0]?.lines).toBeUndefined();
  });

  it("drops a line when its report ends", () => {
    const [one] = incidents(normalize({ reports: bands }), (bands[0] as Report).expires as number);
    expect(one?.live).toBe(false);
    const cancel = report({ key: "c1", op: "cancel", sent: T0 + 1, references: ["b4"], correlation: [{ system: "quake", id: "q1" }], areas: [] });
    const [left] = incidents(normalize({ reports: [...bands, cancel] }), T0 + 2);
    expect(left?.lines?.map((line) => line.report).sort()).toEqual(bands.slice(0, 3).map((head) => head.id).sort());
  });

  it.each(SEEDS)("gives the same lines in each order of the reports (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 50; round += 1) {
      const pool = bands.map((_, index) => band(`b${String(index + 1)}`, r.pick(["extreme", "severe", "moderate", "minor"] as const), r.int(1, 600)));
      const shuffled = r.shuffle([...pool]);
      same(incidents(normalize({ reports: pool }), T0 + 1), incidents(normalize({ reports: shuffled }), T0 + 1));
    }
  });
});

describe("the audience of the reports (AL-92)", () => {
  const other = "person-2" as PersonId;
  const found = (reports: readonly Report[], options: IncidentOptions = {}): readonly Incident[] => incidents(normalize({ reports }), T0, options);
  const audiences = (list: readonly Incident[]): (readonly PersonId[] | undefined)[] => list.map((one) => one.addresses);
  const later = T0 + 60_000;

  it("joins no private report to a public report with the same key, reference or correlation", () => {
    const vtec = [{ system: "vtec", id: "KTOP.TO.W.0001" }];
    const shown = report({ key: "k1", correlation: vtec });
    const cases: readonly Report[] = [
      report({ key: "k1", sent: later, addresses: [person] }),
      report({ key: "k2", sent: later, references: ["k1"], addresses: [person] }),
      report({ key: "k3", sent: later, correlation: vtec, addresses: [person] }),
    ];
    for (const secret of cases) {
      const list = found([shown, secret]);
      expect(list).toHaveLength(2);
      expect(audiences(list).sort()).toEqual([[person], undefined]);
    }
  });

  it("gives a public incident no field addresses, thus the strict schema of an older build reads it", () => {
    const [incident] = found([report({ key: "k1" })]);
    expect(incident).toBeDefined();
    expect(Object.hasOwn(incident!, "addresses")).toBe(false);
  });

  it("joins no private report to a public report through the link rule", () => {
    const link: LinkRule = { blocks: (x) => [x.kind.code], matches: () => true };
    expect(found([report({ key: "k1" }), report({ key: "k2", source: "nwws" })], { link })).toHaveLength(1);
    expect(found([report({ key: "k1" }), report({ key: "k2", source: "nwws", addresses: [person] })], { link })).toHaveLength(2);
    expect(found([report({ key: "k1", addresses: [person] }), report({ key: "k2", source: "nwws", addresses: [person] })], { link })).toHaveLength(1);
  });

  it("joins two private reports only with the same addresses, in any order, and sorts the addresses of the incident", () => {
    expect(found([report({ key: "k1", addresses: [person] }), report({ key: "k1", sent: later, addresses: [other] })])).toHaveLength(2);
    const list = found([report({ key: "k1", addresses: [other, person] }), report({ key: "k1", sent: later, addresses: [person, other, person] })]);
    expect(audiences(list)).toEqual([[person, other]]);
  });
});

describe("the order of two contents of one id (AL-114)", () => {
  // Two contents of one id: the same report with another headline. The join keeps the content with the smaller canonical JSON.
  const pair = (): [Report, Report] => {
    const a = report({ key: "k1", headline: "Tornado Warning A" });
    return [a, { ...a, headline: "Tornado Warning B" }];
  };

  it("a second join of the same two contents builds no canonical JSON", () => {
    const [a, b] = pair();
    const first = join(normalize({ reports: [a] }), normalize({ reports: [b] }));
    const before = texts.count;
    const second = join(normalize({ reports: [a] }), normalize({ reports: [b] }));
    const reverse = join(normalize({ reports: [b] }), normalize({ reports: [a] }));
    const again = normalize({ reports: [b, a] });
    expect(texts.count - before).toBe(0);
    for (const state of [second, reverse, again]) expect(state.reports).toEqual(first.reports);
  });

  it("the kept content is the content with the smaller canonical JSON, in each order of the parts", () => {
    const [a, b] = pair();
    const smaller = canonicalJson(a, { form: "json" }) < canonicalJson(b, { form: "json" }) ? a : b;
    expect(normalize({ reports: [a, b] }).reports).toEqual([smaller]);
    expect(normalize({ reports: [b, a] }).reports).toEqual([smaller]);
    expect(add(normalize({ reports: [a] }), { reports: [b] }).reports).toEqual([smaller]);
    expect(add(normalize({ reports: [b] }), { reports: [a] }).reports).toEqual([smaller]);
  });

  it("two equal contents in two objects keep the content that the state has", () => {
    const [a] = pair();
    const copy = { ...a };
    expect(add(normalize({ reports: [a] }), { reports: [copy] }).reports[0]).toBe(a);
    expect(add(normalize({ reports: [copy] }), { reports: [a] }).reports[0]).toBe(copy);
  });
});
