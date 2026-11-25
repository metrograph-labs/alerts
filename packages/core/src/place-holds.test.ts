import { describe, expect, it } from "vitest";
import type { ChannelDescriptor, ChannelId, Delivery, EscalationPolicy, Incident, PersonId, PlaceId, Position, ReportId, WatchedPlace } from "./contracts.ts";
import { route, type EscalationEnd, type EscalationStart, type Recipient, type RouteInput } from "./delivery.ts";
import { messageKey } from "./ids.ts";
import { heldPlaces, holdPlaces, NO_HOLDS, type PlaceHolds } from "./place-holds.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 3, 1, 18);
const anchor = "a".repeat(64) as ReportId;
const merged = "b".repeat(64) as ReportId;
const later = "c".repeat(64) as ReportId;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;
const mover = "place-moving" as PlaceId;
const home = "place-fixed" as PlaceId;

// A made-up square area. Its east edge is the meridian -100.0.
const SQUARE: readonly Position[] = [
  [-100.1, 38.0],
  [-100.0, 38.0],
  [-100.0, 38.1],
  [-100.1, 38.1],
  [-100.1, 38.0],
];
// A made-up square far to the west: the area after a change of the warning.
const WEST: readonly Position[] = [
  [-101.1, 38.0],
  [-101.0, 38.0],
  [-101.0, 38.1],
  [-101.1, 38.1],
  [-101.1, 38.0],
];
// Two fixes at the edge: about 90 m in the area, and about 1.7 km out of it.
const IN: Position = [-100.001, 38.05];
const OUT: Position = [-99.98, 38.05];
const IS_MOVING = (place: PlaceId): boolean => place === mover;

function at(position: Position, id: PlaceId = mover): WatchedPlace {
  return { id, at: position, codes: [], bufferKm: 0.05 };
}

function incident(fields: Partial<Incident> = {}): Incident {
  return {
    anchor,
    reports: [anchor, merged],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [{ type: "polygon", rings: [SQUARE] }],
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

describe("holdPlaces", () => {
  it("holds a moving place that the area covers, and keeps the hold after the fix leaves the area", () => {
    const held = holdPlaces(NO_HOLDS, [incident()], [at(IN)], IS_MOVING);
    expect([...held]).toEqual([[anchor, [at(IN)]]]);
    expect([...holdPlaces(held, [incident()], [at(OUT)], IS_MOVING)]).toEqual([[anchor, [at(IN)]]]);
    // A stale fix: the moving place is not in the places of the pass. The hold stays.
    expect([...holdPlaces(held, [incident()], [], IS_MOVING)]).toEqual([[anchor, [at(IN)]]]);
  });

  it("moves the hold to a later fix in the area", () => {
    const deeper: Position = [-100.05, 38.05];
    const held = holdPlaces(holdPlaces(NO_HOLDS, [incident()], [at(IN)], IS_MOVING), [incident()], [at(deeper)], IS_MOVING);
    expect([...held]).toEqual([[anchor, [at(deeper)]]]);
  });

  it("drops the holds of an incident that ends, or that is not in the incidents", () => {
    const held = holdPlaces(NO_HOLDS, [incident()], [at(IN)], IS_MOVING);
    expect(holdPlaces(held, [incident({ live: false })], [at(IN)], IS_MOVING).size).toBe(0);
    expect(holdPlaces(held, [], [at(IN)], IS_MOVING).size).toBe(0);
  });

  it("gives no hold to a fixed place, and drops the hold of a place that is no longer moving", () => {
    expect(holdPlaces(NO_HOLDS, [incident()], [at(IN, home)], IS_MOVING).size).toBe(0);
    const held = holdPlaces(NO_HOLDS, [incident()], [at(IN)], IS_MOVING);
    expect(holdPlaces(held, [incident()], [at(OUT)], () => false).size).toBe(0);
  });

  it("finds a hold by each report of the incident, thus a merge with a new anchor keeps it", () => {
    const held = holdPlaces(NO_HOLDS, [incident()], [at(IN)], IS_MOVING);
    const moved = incident({ anchor: later, reports: [later, anchor, merged] });
    expect([...holdPlaces(held, [moved], [at(OUT)], IS_MOVING)]).toEqual([[later, [at(IN)]]]);
  });

  it("gives the same holds when no place moves and no hold exists", () => {
    const fixed = [at(IN, home)];
    expect(holdPlaces(NO_HOLDS, [incident()], fixed, IS_MOVING)).toBe(NO_HOLDS);
  });
});

describe("heldPlaces", () => {
  const holds: PlaceHolds = new Map([[anchor, [at(IN)]]]);

  it("gives the places as they are with no hold", () => {
    const places = [at(OUT)];
    expect(heldPlaces(incident(), places, NO_HOLDS)).toBe(places);
    expect(heldPlaces(incident({ anchor: later, reports: [later] }), places, holds)).toBe(places);
  });

  it("gives the hold in place of a fix out of the area, and keeps a fix in the area", () => {
    expect(heldPlaces(incident(), [at(IN, home), at(OUT)], holds)).toEqual([at(IN, home), at(IN)]);
    const deeper = at([-100.05, 38.05]);
    expect(heldPlaces(incident(), [deeper], holds)).toEqual([deeper]);
  });

  it("adds a held place that is not in the places, for example after a stale fix", () => {
    expect(heldPlaces(incident(), [at(IN, home)], holds)).toEqual([at(IN, home), at(IN)]);
  });
});

describe("route with the holds of a moving place (AL-40)", () => {
  const ONE_STEP: EscalationPolicy = { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE };
  const channel: ChannelDescriptor = { id: pushover, title: "pushover", dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 250, maxBody: 1024 };
  const recipient: Recipient = { watch: { person, places: [mover], rules: [] }, policies: [ONE_STEP], addresses: { pushover: { user: "fake-user" } } };

  // The passes of a runtime: each pass reads one fix, routes, and writes the starts, the deliveries, the cancels and the ends.
  function passes(fixes: readonly Position[], options: { readonly sticky: boolean; readonly areas?: (pass: number) => Incident["areas"] }) {
    const starts: EscalationStart[] = [];
    const ends: EscalationEnd[] = [];
    const deliveries: Delivery[] = [];
    const cancelled = new Set<string>();
    let holds: PlaceHolds = NO_HOLDS;
    fixes.forEach((fix, pass) => {
      const now = T0 + pass * 20 * SECOND;
      const incidents = [incident(options.areas === undefined ? {} : { areas: options.areas(pass) })];
      const places = [at(fix)];
      if (options.sticky) holds = holdPlaces(holds, incidents, places, IS_MOVING);
      const input: RouteInput = {
        state: { reports: [], deliveries, acks: [], ends: [], retired: [] },
        incidents,
        recipients: [recipient],
        places,
        ...(options.sticky ? { holds } : {}),
        starts,
        ends,
        cancelled,
        channels: [channel],
        now,
      };
      for (const entry of route(input)) {
        if (entry.fresh) starts.push(entry.start);
        for (const send of entry.plan.sends) deliveries.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: { receipt: `r-${deliveries.length}` } });
        for (const done of entry.plan.cancels) cancelled.add(done.key);
        if (entry.freshEnd && entry.end !== undefined) ends.push(entry.end);
      }
    });
    return { deliveries, ends };
  }

  // Five times in the area and five times out of it, at the edge.
  const FLAPS: readonly Position[] = Array.from({ length: 10 }, (_, pass) => (pass % 2 === 0 ? IN : OUT));

  it("gives 1 send for fixes that cross the edge 5 times", () => {
    const sticky = passes(FLAPS, { sticky: true });
    expect(sticky.deliveries.map((item) => item.step)).toEqual([0]);
    expect(sticky.ends).toEqual([]);
  });

  it("gives 5 sends for the same fixes with no hold: each return is a new episode with new keys", () => {
    const loose = passes(FLAPS, { sticky: false });
    expect(loose.deliveries).toHaveLength(5);
    expect(new Set(loose.deliveries.map((item) => item.key)).size).toBe(5);
    expect(loose.ends).toHaveLength(5);
  });

  it("ends the route when the area of the incident leaves the held fix and the fix of the pass", () => {
    const moved = passes([IN, OUT, OUT], { sticky: true, areas: (pass) => [{ type: "polygon", rings: [pass < 2 ? SQUARE : WEST] }] });
    expect(moved.deliveries).toHaveLength(1);
    expect(moved.ends.map((end) => end.at)).toEqual([T0 + 40 * SECOND]);
  });
});
