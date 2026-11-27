import { describe, expect, it } from "vitest";
import { assess, reachedAssessment } from "./assess.ts";
import type { InterestGraph, MergeState, ObservationId, PersonId, PersonWatch, PlaceId, RegionCode, Report, ReportId, SourceId } from "./contracts.ts";
import { HISTORY_FORMAT, historyPayload, OWN_ENTRY_TIMES, type EntryTimes, type HistoryInput } from "./history.ts";
import { reportId } from "./ids.ts";
import type { MapPlaceInput, MapShape, ShapeLookup } from "./map.ts";
import { EMPTY_STATE, incidents } from "./merge.ts";
import { historyPayloadSchema } from "./schemas.ts";
import { placeNode } from "./why.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const PLACE = "place:a" as PlaceId;
const zone: RegionCode = { system: "ugc", code: "KSZ083" };
const county: RegionCode = { system: "ugc", code: "KSC173" };
const square = (lon: number, lat: number): MapShape => ({
  type: "polygon",
  rings: [
    [
      [lon, lat],
      [lon + 0.1, lat],
      [lon + 0.1, lat + 0.1],
      [lon, lat + 0.1],
      [lon, lat],
    ],
  ],
});
const SHAPES = new Map<string, readonly MapShape[]>([
  ["ugc KSZ083", [square(-97.5, 37.6)]],
  ["ugc KSC173", [square(-97.4, 37.6)]],
]);
const shape: ShapeLookup = (code) => SHAPES.get(`${code.system} ${code.code}`);
const place: MapPlaceInput = { id: PLACE, label: "Place A", codes: [county, zone], bufferKm: 0 };
const person: PersonWatch = { person: "person:a" as PersonId, places: [PLACE], rules: [] };

interface Draft extends Partial<Omit<Report, "id" | "source">> {
  readonly key: string;
}

function report(draft: Draft): Report {
  const sent = draft.sent ?? T0;
  const source = "nws-api" as SourceId;
  return {
    origin: "nws",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
    categories: ["met"],
    severity: "severe",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    received: sent,
    expires: sent + 600 * MINUTE,
    areas: [{ type: "code", ...zone }],
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

const merge = (reports: readonly Report[], fields: Partial<MergeState> = {}): MergeState => ({ ...EMPTY_STATE, reports, ...fields });
const input = (state: MergeState, fields: Partial<HistoryInput> = {}): HistoryInput => ({ at: T0 + 120 * MINUTE, merge: state, people: [person], places: [place], shape, ...fields });

// The first warning, and an update ten minutes later that adds the county and raises the severity.
const first = report({ key: "w1" });
const update = report({ key: "w2", sent: T0 + 10 * MINUTE, op: "update", references: ["w1"], severity: "extreme", areas: [{ type: "code", ...zone }, { type: "code", ...county }] });
const ids = (...reports: readonly Report[]): ReportId[] => reports.map((one) => one.id).sort();

describe("historyPayload", () => {
  it("reads no private report: the payload is the payload without it (AL-92)", () => {
    const secret = report({ key: "p1", sent: T0 + 30 * MINUTE, addresses: [person.person], areas: [], headline: "A private message" });
    const ended = { report: secret.id, at: T0 + 40 * MINUTE, ended: true };
    const withSecret = historyPayload(input(merge([first, update, secret], { ends: [ended] })));
    expect(withSecret).toEqual(historyPayload(input(merge([first, update]))));
    expect(withSecret.incidents.flatMap((history) => history.reports)).not.toContain(secret.id);
    expect(historyPayload(input(merge([secret]))).incidents).toEqual([]);
  });

  it("gives one change for each time of entry, with the level, the severity and the codes at that time", () => {
    const state = merge([first, update]);
    const payload = historyPayload(input(state));
    expect(payload).toMatchObject({ format: HISTORY_FORMAT, at: T0 + 120 * MINUTE, since: null, next: T0 + 10 * MINUTE });
    expect(payload.incidents).toHaveLength(1);
    const [history] = payload.incidents;
    expect(history?.reports).toEqual(ids(first, update));
    expect(history?.changes.map((change) => [change.at, change.reports, change.severity, change.codes])).toEqual([
      [T0, [first.id], "severe", [zone]],
      [T0 + 10 * MINUTE, [update.id], "extreme", [county, zone]],
    ]);
    // The level of each change is the level of the person for the incident of the known reports at that time.
    const levelAt = (known: readonly Report[], at: number): string => reachedAssessment(assess(incidents(merge(known), at)[0]!, person, [place], undefined, at)).level;
    expect(history?.changes.map((change) => change.level)).toEqual([levelAt([first], T0), levelAt([first, update], T0 + 10 * MINUTE)]);
    expect(history?.changes[0]?.level).not.toBe("none");
    // The shapes of each code come one time, in the payload.
    expect(payload.regions).toEqual([
      { code: county, shapes: SHAPES.get("ugc KSC173") },
      { code: zone, shapes: SHAPES.get("ugc KSZ083") },
    ]);
    expect(historyPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("gives a change for an end mark, and the incident is then not live", () => {
    const ended = { report: update.id, at: T0 + 20 * MINUTE, ended: true };
    const payload = historyPayload(input(merge([first, update], { ends: [ended] })));
    const last = payload.incidents[0]?.changes.at(-1);
    expect(last).toMatchObject({ at: T0 + 20 * MINUTE, reports: [], live: false, level: "none" });
    expect(payload.next).toBe(T0 + 20 * MINUTE);
    // The flip: a mark of a report that this copy does not know yet gives no change.
    const early = { report: report({ key: "other" }).id, at: T0 + 30 * MINUTE, ended: true };
    expect(historyPayload(input(merge([first, update], { ends: [early] }))).incidents[0]?.changes).toHaveLength(2);
  });

  it("joins two parts of an incident before their merge into one change", () => {
    const a = report({ key: "a", correlation: [{ system: "x", id: "1" }] });
    const b = report({ key: "b", sent: T0 + 5 * MINUTE, severity: "moderate", areas: [{ type: "code", ...county }], correlation: [{ system: "x", id: "2" }] });
    const link = report({ key: "c", sent: T0 + 15 * MINUTE, correlation: [{ system: "x", id: "1" }, { system: "x", id: "2" }] });
    const payload = historyPayload(input(merge([a, b, link])));
    expect(payload.incidents).toHaveLength(1);
    expect(payload.incidents[0]?.changes.map((change) => [change.at, change.reports, change.severity, change.codes])).toEqual([
      [T0, [a.id], "severe", [zone]],
      // The parts of a and b give one change: the higher severity, and the codes of both.
      [T0 + 5 * MINUTE, [b.id], "severe", [county, zone]],
      [T0 + 15 * MINUTE, [link.id], "severe", [county, zone]],
    ]);
  });

  it("gives the highest certainty of the parts in each change, thus a watch does not read as a start (AL-221)", () => {
    const watch = report({ key: "a", certainty: "possible", onset: T0, correlation: [{ system: "x", id: "1" }] });
    const warning = report({ key: "b", sent: T0 + 5 * MINUTE, certainty: "observed", correlation: [{ system: "x", id: "2" }] });
    const link = report({ key: "c", sent: T0 + 15 * MINUTE, certainty: "likely", correlation: [{ system: "x", id: "1" }, { system: "x", id: "2" }] });
    const payload = historyPayload(input(merge([watch, warning, link])));
    expect(payload.incidents).toHaveLength(1);
    expect(payload.incidents[0]?.changes.map((change) => [change.at, change.certainty])).toEqual([
      [T0, "possible"],
      [T0 + 5 * MINUTE, "observed"],
      // The link replaces the watch and the warning, thus its certainty is the only one that is live.
      [T0 + 15 * MINUTE, "likely"],
    ]);
    expect(historyPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("gives only the incidents with a change at since or later, each with each of its changes", () => {
    const other = report({ key: "o1", sent: T0 + 40 * MINUTE, kind: { code: "hydro.flood", significance: "warning", label: "Flood Warning" }, areas: [{ type: "code", ...county }] });
    const state = merge([first, update, other]);
    const all = historyPayload(input(state));
    expect(all.incidents).toHaveLength(2);
    const later = historyPayload(input(state, { since: T0 + 30 * MINUTE }));
    expect(later.incidents.map((history) => history.reports)).toEqual([[other.id]]);
    expect(later).toMatchObject({ since: T0 + 30 * MINUTE, next: T0 + 40 * MINUTE });
    // The regions hold only the codes of the payload.
    expect(later.regions.map((region) => region.code)).toEqual([county]);
    // A since at the newest change gives that incident again.
    expect(historyPayload(input(state, { since: T0 + 40 * MINUTE })).incidents).toHaveLength(1);
    expect(historyPayload(input(state, { since: T0 + 40 * MINUTE + 1 })).incidents).toEqual([]);
  });

  it("uses the time of entry on this copy, thus a late import comes after the since of a reader", () => {
    const imported = report({ key: "w3", sent: T0 + 50 * MINUTE, received: T0 + 50 * MINUTE, op: "update", references: ["w2"] });
    const state = merge([first, update, imported]);
    const own = new Map([[imported.id, T0 + 90 * MINUTE]]);
    const entered: EntryTimes = { ...OWN_ENTRY_TIMES, report: (one) => own.get(one.id) ?? one.received };
    const payload = historyPayload(input(state, { since: T0 + 60 * MINUTE, entered }));
    expect(payload.incidents[0]?.changes.at(-1)).toMatchObject({ at: T0 + 90 * MINUTE, reports: [imported.id] });
    // The flip: with the time of receipt, the import is before the since.
    expect(historyPayload(input(state, { since: T0 + 60 * MINUTE })).incidents).toEqual([]);
  });

  it("uses the time of entry of an end mark, thus the incident stays live until this copy knew the mark", () => {
    const ended = { report: update.id, at: T0 + 20 * MINUTE, ended: true };
    const state = merge([first, update], { ends: [ended] });
    const entered: EntryTimes = { ...OWN_ENTRY_TIMES, mark: (mark) => (mark === ended ? T0 + 50 * MINUTE : mark.at) };
    const changes = historyPayload(input(state, { entered })).incidents[0]?.changes ?? [];
    expect(changes.map((change) => [change.at, change.live])).toEqual([
      [T0, true],
      [T0 + 10 * MINUTE, true],
      [T0 + 50 * MINUTE, false],
    ]);
    // The flip: with the own time of the mark, the end is at 20 minutes.
    expect(historyPayload(input(state)).incidents[0]?.changes.at(-1)).toMatchObject({ at: T0 + 20 * MINUTE, live: false });
  });

  it("tells a step of the clock back: next is below since", () => {
    const payload = historyPayload(input(merge([first, update]), { since: T0 + 60 * MINUTE }));
    expect(payload.incidents).toEqual([]);
    expect(payload.next).toBeLessThan(T0 + 60 * MINUTE);
    expect(historyPayload(input(EMPTY_STATE))).toMatchObject({ next: null, incidents: [], regions: [] });
  });

  it("lists a code with no shape as unshaped, and keeps the polygons of the reports", () => {
    const far: RegionCode = { system: "ugc", code: "TXZ205" };
    const polygon = square(-98.5, 29.4);
    const odd = report({ key: "p1", areas: [{ type: "code", ...far }, polygon, { ...polygon }] });
    const change = historyPayload(input(merge([odd]))).incidents[0]?.changes[0];
    expect(change).toMatchObject({ codes: [], unshaped: [far], shapes: [polygon] });
  });

  it("gives each watched place in the areas with the highest level of the assessments with the place", () => {
    const other: MapPlaceInput = { id: "place:c" as PlaceId, label: "Place C", codes: [zone], bufferKm: 0 };
    const far: MapPlaceInput = { id: "place:t" as PlaceId, label: "Place T", codes: [{ system: "ugc", code: "TXZ205" }], bufferKm: 0 };
    const lowered: PersonWatch = { person: "person:b" as PersonId, places: [other.id], rules: [{ max: "notice" }] };
    const changes = historyPayload(input(merge([first]), { people: [person, lowered], places: [other, place, far] })).incidents[0]?.changes ?? [];
    // The order is the order of the input places. The place far away is not in the areas.
    expect(changes[0]?.places).toEqual([
      { id: other.id, level: "notice" },
      { id: PLACE, level: changes[0]?.level },
    ]);
    expect(changes[0]?.level).not.toBe("notice");
    // The flip: a place that no person watches has the level none.
    const unwatched = historyPayload(input(merge([first]), { places: [other, place] })).incidents[0]?.changes[0]?.places;
    expect(unwatched?.[0]).toEqual({ id: other.id, level: "none" });
  });

  it("gives a change at the expiry of a report up to the time of the payload, and the view is then not live", () => {
    const short = report({ key: "s1", expires: T0 + 30 * MINUTE });
    const payload = historyPayload(input(merge([short])));
    expect(payload.incidents[0]?.changes.map((change) => [change.at, change.reports, change.live, change.level])).toEqual([
      [T0, [short.id], true, payload.incidents[0]?.changes[0]?.level],
      [T0 + 30 * MINUTE, [], false, "none"],
    ]);
    expect(payload.next).toBe(T0 + 30 * MINUTE);
    // The flip: an expiry after the time of the payload gives no change yet.
    const early = historyPayload(input(merge([short]), { at: T0 + 20 * MINUTE }));
    expect(early.incidents[0]?.changes).toHaveLength(1);
    expect(early.next).toBe(T0);
  });

  it("counts the time edges up to the newest time of entry, when an import came after the last pass", () => {
    const short = report({ key: "s1", expires: T0 + 30 * MINUTE });
    const later = report({ key: "o1", sent: T0 + 50 * MINUTE, kind: { code: "hydro.flood", significance: "warning", label: "Flood Warning" }, areas: [{ type: "code", ...county }] });
    const payload = historyPayload(input(merge([short, later]), { at: T0 + 20 * MINUTE }));
    expect(payload.next).toBe(T0 + 50 * MINUTE);
    expect(payload.incidents.find((history) => history.anchor === short.id)?.changes.at(-1)).toMatchObject({ at: T0 + 30 * MINUTE, live: false });
    // Thus the next read with this since also has the change of the expiry, though its time is below the since.
    expect(historyPayload(input(merge([short, later]), { at: T0 + 60 * MINUTE, since: payload.next })).incidents.map((history) => history.anchor)).toEqual([later.id]);
  });

  it("gives a change at the end of the window pastWithin of an earthquake", () => {
    const quake = report({ key: "q1", kind: { code: "geo.earthquake", label: "Earthquake" }, categories: ["geo"], severity: "extreme", urgency: "past", onset: T0 });
    const payload = historyPayload(input(merge([quake])));
    expect(payload.incidents[0]?.changes.map((change) => [change.at, change.level])).toEqual([
      [T0, "life-safety"],
      [T0 + 60 * MINUTE + 1, "digest"],
    ]);
    // The flip: a report with the urgency immediate has no window.
    expect(historyPayload(input(merge([{ ...quake, urgency: "immediate" }]))).incidents[0]?.changes).toHaveLength(1);
  });

  it("gives a change at the end of a mute only when the view changes", () => {
    const flood = report({ key: "f1", kind: { code: "hydro.flood", significance: "warning", label: "Flood Warning" }, categories: ["met"] });
    const graph = (kinds: readonly string[]): InterestGraph => ({
      format: "alerts-interest/1",
      person: person.person,
      edges: [{ id: "i1", from: placeNode(PLACE), to: "person", kind: "interest", weight: { value: 1, low: 1, high: 1 }, origin: "base", on: true }],
      mutes: [{ id: "m1", kinds, until: T0 + 40 * MINUTE, date: "2026-11-16" }],
    });
    const muted = historyPayload(input(merge([flood]), { people: [{ ...person, interests: graph(["hydro.flood"]) }] }));
    expect(muted.incidents[0]?.changes.map((change) => [change.at, change.level, change.places])).toEqual([
      [T0, "none", [{ id: PLACE, level: "none" }]],
      [T0 + 40 * MINUTE, "urgent", [{ id: PLACE, level: "urgent" }]],
    ]);
    // The flip: the end of a mute of another kind changes no view, thus it gives no change.
    const other = historyPayload(input(merge([flood]), { people: [{ ...person, interests: graph(["met.tornado"]) }] }));
    expect(other.incidents[0]?.changes.map((change) => [change.at, change.level])).toEqual([[T0, "urgent"]]);
    expect(other.next).toBe(T0 + 40 * MINUTE);
  });

  it("keeps only the live parts in a change, as the map shows only live incidents", () => {
    const a = report({ key: "a", expires: T0 + 10 * MINUTE, correlation: [{ system: "x", id: "1" }] });
    const b = report({ key: "b", sent: T0 + 5 * MINUTE, severity: "moderate", areas: [{ type: "code", ...county }], correlation: [{ system: "x", id: "2" }] });
    const link = report({ key: "c", sent: T0 + 15 * MINUTE, severity: "moderate", areas: [{ type: "code", ...county }], correlation: [{ system: "x", id: "1" }, { system: "x", id: "2" }] });
    const changes = historyPayload(input(merge([a, b, link]))).incidents[0]?.changes ?? [];
    expect(changes.map((change) => [change.at, change.severity, change.codes, change.live])).toEqual([
      [T0, "severe", [zone], true],
      [T0 + 5 * MINUTE, "severe", [county, zone], true],
      // The part of a expired, thus the change has only the part of b.
      [T0 + 10 * MINUTE, "moderate", [county], true],
      [T0 + 15 * MINUTE, "moderate", [county], true],
    ]);
  });

  it("refuses a payload of another format", () => {
    const payload = historyPayload(input(merge([first])));
    expect(historyPayloadSchema.safeParse({ ...payload, format: "alerts-history/0" }).success).toBe(false);
  });
});
