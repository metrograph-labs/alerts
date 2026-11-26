import { reportId, type ChainConfig, type Incident, type ObservationId, type Report, type ReportId, type SourceId, type Subject } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { pagesFor, STATUS_PAGES } from "@mark1russell7/alerts-source-statuspage";
import { chainProblems, chainStates, chainWatch, downParts, readChain, type Chain } from "./chain.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { EMPTY_RUNTIME, fold } from "./state.ts";
import { DELAY_LIMITS, systemView, type ViewConfig } from "./view.ts";

// A made-up stack of an alert chain. The push to a person has two paths: the push app, and the texts of a provider over
// the carriers. Each path needs the power of the house. The ids and the domains are examples, not a real design.
const STACK = {
  schema: "stack/1",
  parts: [
    { id: "push", kind: "function", name: "The push to a person", needs: [{ any: ["push-app", "texts"] }, "power"] },
    { id: "push-app", kind: "service", name: "The push app" },
    { id: "texts", kind: "service", name: "The texts", needs: ["text-provider", "carriers"] },
    { id: "text-provider", kind: "provider", name: "The text provider" },
    { id: "carriers", kind: "provider", name: "The carriers" },
    { id: "power", kind: "power", name: "The power of the house" },
  ],
  layers: { "risk/1": { schema: "risk/1", goals: [{ part: "push", survives: 1 }] } },
};
const CONFIG: ChainConfig = {
  stack: STACK,
  subjects: [
    { system: "domain", id: "status.text-provider.example", part: "text-provider" },
    { system: "domain", id: "status.push-app.example", part: "push-app" },
    { system: "component", id: "carriers", part: "carriers" },
  ],
};
const T0 = Date.UTC(2026, 10, 23, 20);
const HOUR = 3_600_000;
const STATUS = "statuspage" as SourceId;

function chainOf(config: ChainConfig = CONFIG): Chain {
  const read = readChain(config);
  if (!read.ok) throw new Error(read.problems.join("\n"));
  return read.chain;
}

function incident(about: readonly Subject[], live = true, status: Incident["status"] = "actual"): Incident {
  const anchor = "a".repeat(64) as ReportId;
  return {
    anchor,
    reports: [anchor],
    status,
    kind: { code: "infra.saas.outage", label: "Service outage" },
    severity: "moderate",
    urgency: "immediate",
    certainty: "observed",
    areas: [],
    about,
    live,
    corroboration: 1,
  };
}

const TEXTS_DOWN = incident([{ system: "domain", id: "status.text-provider.example", label: "The text provider" }]);

describe("the read of the stack of the alert chain (AL-90)", () => {
  it("reads a good stack, and keeps the single points of the design", () => {
    expect(chainProblems(undefined)).toEqual([]);
    expect(chainProblems(CONFIG)).toEqual([]);
    // The power is a single point of the design: one failure of the power stops the push.
    expect([...chainOf().accepted.get("push")!]).toEqual(["power"]);
  });

  it("gives a problem for a stack with a bad form, a stack with no layer of risks and a part that is not in the stack", () => {
    expect(chainProblems({ ...CONFIG, stack: { schema: "stack/1" } })[0]).toMatch(/^chain: The record "stack\/1" has a fault/);
    expect(chainProblems({ ...CONFIG, stack: { ...STACK, layers: {} } })[0]).toBe('chain: the stack has no layer "risk/1" with a good form.');
    expect(chainProblems({ ...CONFIG, subjects: [{ system: "domain", id: "x.example", part: "nothing" }] })).toEqual(['chain: the subject domain:x.example names the part "nothing", which is not in the stack.']);
    const goal = { ...STACK, layers: { "risk/1": { schema: "risk/1", goals: [{ part: "nothing", survives: 1 }] } } };
    expect(chainProblems({ ...CONFIG, stack: goal })).toContain('chain: the goal of the part "nothing" names a part that is not in the stack.');
    const needs = { ...STACK, parts: [...STACK.parts, { id: "lost", kind: "service", needs: ["nowhere"] }] };
    expect(chainProblems({ ...CONFIG, stack: needs }).length).toBeGreaterThan(0);
  });
});

describe("the sources of the subjects of the chain (AL-90)", () => {
  it("reads the status page of a subject of the chain, also when no person names it", () => {
    const page = STATUS_PAGES[0]!;
    const watch = chainWatch({ ...CONFIG, subjects: [{ system: "domain", id: page.domain, part: "text-provider" }] });
    expect(pagesFor([])).toEqual([]);
    expect(pagesFor([watch])).toContain(page);
    expect(watch).toMatchObject({ places: [], rules: [] });
  });
});

describe("the state of each function of the chain (AL-90)", () => {
  it("gives the down parts of the live actual incidents only, in the order of the stack", () => {
    const chain = chainOf();
    const carriers = incident([{ system: "component", id: "carriers" }]);
    expect(downParts(chain, [carriers, TEXTS_DOWN])).toEqual(["text-provider", "carriers"]);
    expect(downParts(chain, [incident(TEXTS_DOWN.about, false)])).toEqual([]);
    expect(downParts(chain, [incident(TEXTS_DOWN.about, true, "exercise")])).toEqual([]);
    expect(downParts(chain, [incident([{ system: "domain", id: "other.example" }])])).toEqual([]);
  });

  it("gives no new point with no part down, thus the single point of the design gives no report", () => {
    const push = { id: "push", name: "The push to a person" };
    expect(chainStates(chainOf(), [])).toEqual([{ function: push, works: true, points: [], down: [] }]);
  });

  it("gives the push app as the new single point when the text provider is down", () => {
    expect(chainStates(chainOf(), [TEXTS_DOWN])).toEqual([
      {
        function: { id: "push", name: "The push to a person" },
        works: true,
        points: [{ id: "push-app", name: "The push app" }],
        down: [{ id: "text-provider", name: "The text provider" }],
      },
    ]);
  });

  it("gives a stopped function when each path is down", () => {
    const app = incident([{ system: "domain", id: "status.push-app.example" }]);
    const [state] = chainStates(chainOf(), [TEXTS_DOWN, app]);
    expect(state).toMatchObject({ works: false, points: [], down: [{ id: "push-app" }, { id: "text-provider" }] });
  });
});

describe("the redundancy reports of the view (AL-90)", () => {
  // A report of a status page about the domain of the text provider, as the status page adapter maps it.
  const report: Report = {
    id: reportId({ source: STATUS, key: "incident-1", sent: T0 }),
    source: STATUS,
    origin: "statuspage",
    key: "incident-1",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "infra.saas.outage", label: "Service outage" },
    categories: ["infra"],
    severity: "moderate",
    urgency: "immediate",
    certainty: "observed",
    response: ["monitor"],
    sent: T0,
    received: T0,
    expires: T0 + HOUR,
    areas: [],
    about: [{ system: "domain", id: "status.text-provider.example", label: "The text provider" }],
    sender: "status.text-provider.example",
    headline: "Texts are late",
    observation: "statuspage:incident-1" as ObservationId,
    parameters: {},
  };
  const fetched: RuntimeEvent = { ...envelope("fetch", "fetch:1", T0), record: { source: STATUS, at: T0, took: 100, fresh: 1, fatal: 0 }, reports: [report], problems: [] };
  const VIEW: ViewConfig = { sources: [], places: [], kinds: [], expectations: [], delay: DELAY_LIMITS };
  const codes = (view: ReturnType<typeof systemView>) => view.step.reports.filter((one) => one.kind.code.startsWith("system.redundancy")).map((one) => [one.op, one.kind.code, one.headline]);

  it("gives an alert of a new single point from an open incident of a status page, and none with no chain", () => {
    const state = fold(EMPTY_RUNTIME, fetched, VIEW);
    expect(codes(systemView(state, { ...VIEW, chain: chainOf() }, T0 + 1))).toEqual([["alert", "system.redundancy.single", "The push to a person has a single point of failure: The push app."]]);
    expect(codes(systemView(state, VIEW, T0 + 1))).toEqual([]);
    expect(codes(systemView(EMPTY_RUNTIME, { ...VIEW, chain: chainOf() }, T0 + 1))).toEqual([]);
  });
});
