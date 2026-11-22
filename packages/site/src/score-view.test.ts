import { PRIORS_FORMAT, shadowScore, type MapIncident, type MapView, type ScorePriors } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { ANCHORS, EMPTY_FIXTURE, MAP_FIXTURE } from "./map-view.fixture.ts";
import { differencePanel, estimateText, NO_REACH_TEXT, NO_SCORE_TEXT, scoreLine, scoreRuleText, shadowText } from "./score-view.ts";

// Made-up priors. They are not the public measures.
const PRIORS: ScorePriors = {
  format: PRIORS_FORMAT,
  kinds: {
    "met.tornado": { deaths: { value: 0.04, low: 0.03, high: 0.06 }, injuries: { value: 0.5, low: 0.4, high: 0.6 } },
    "met.flood": { deaths: { value: 2, low: 1.5, high: 2.5 }, injuries: { value: 3, low: 2.5, high: 3.5 } },
  },
  certainty: { observed: { value: 1, low: 1, high: 1 } },
};

const scoreOf = (incident: MapIncident, priors: ScorePriors = PRIORS) => shadowScore({ kind: incident.kind, certainty: "observed" }, priors);

// The view of the fixture, with the score of each incident that reaches a person.
function scored(priors: ScorePriors = PRIORS): MapView {
  const { view } = MAP_FIXTURE;
  return { ...view, incidents: view.incidents.map((incident) => (incident.level === "none" ? incident : { ...incident, shadow: scoreOf(incident, priors) })) };
}

const byAnchor = (view: MapView, anchor: string): MapIncident => {
  const incident = view.incidents.find((shown) => shown.anchor === anchor);
  if (incident === undefined) throw new Error(`no incident ${anchor}`);
  return incident;
};

describe("the words of the score rule of a person", () => {
  const tornado = shadowScore({ kind: { code: "met.tornado", label: "Tornado" }, certainty: "observed" }, PRIORS);

  it("tells the raise, the floor of the table, a score below the risk and a rule with no read", () => {
    expect(scoreRuleText({ kind: "score", risk: 0.03, raised: true, score: tornado })).toBe(
      "The score rule of the person sets the level life-safety: the expected deaths, 0.04 (0.03 to 0.06), reach the risk value 0.03.",
    );
    expect(scoreRuleText({ kind: "score", risk: 0.03, raised: false, score: tornado })).toBe(
      "The expected deaths, 0.04 (0.03 to 0.06), reach the risk value 0.03 of the score rule, and the table gives life-safety.",
    );
    expect(scoreRuleText({ kind: "score", risk: 0.1, raised: false, score: tornado })).toBe(
      "The expected deaths, 0.04 (0.03 to 0.06), are below the risk value 0.1 of the score rule, so the table decides the level.",
    );
    expect(scoreRuleText({ kind: "score", risk: 0.003, raised: false })).toBe(
      "The score rule of the person has the risk value 0.003. The policy has no priors, so the table decides the level.",
    );
    expect(scoreRuleText({ kind: "score", risk: 0.003, raised: false, score: { read: false, missing: ["deaths"] } })).toBe(
      "The score rule of the person has the risk value 0.003. The score has no value, so the table decides the level.",
    );
  });
});

describe("the words of the shadow score", () => {
  it("gives an estimate with two significant digits and its interval", () => {
    expect(estimateText({ value: 0.034_71, low: 0.023_4, high: 0.047_5 })).toBe("0.035 (0.023 to 0.048)");
    expect(estimateText({ value: 2, low: 1.5, high: 2.5 })).toBe("2 (1.5 to 2.5)");
  });

  it("gives the short line of a card, with the expected harm or the missing factors", () => {
    const tornado = byAnchor(MAP_FIXTURE.view, ANCHORS.tornado);
    expect(scoreLine(scoreOf(tornado))).toBe("Shadow score: 0.04 (0.03 to 0.06) expected deaths and 0.5 (0.4 to 0.6) expected injuries.");
    const none = scoreOf(tornado, { ...PRIORS, kinds: {} });
    expect(none.read).toBe(false);
    expect(scoreLine(none)).toBe("Shadow score: no value. The priors do not give: deaths, injuries.");
  });

  it("tells first that the score does not decide the level", () => {
    const tornado = byAnchor(MAP_FIXTURE.view, ANCHORS.tornado);
    expect(shadowText(scoreOf(tornado))).toMatch(/^The shadow score does not decide the level\. /);
    expect(shadowText(scoreOf(tornado, { ...PRIORS, kinds: {} }))).toMatch(/^The shadow score does not decide the level, and it has no value\. /);
  });

  it("tells the harm under an alert, with its significance and its kind of area", () => {
    const under: ScorePriors = {
      ...PRIORS,
      kinds: { "met.tornado": { under: { warning: { deaths: { value: 0.003, low: 0.002, high: 0.005 }, injuries: { value: 0.03, low: 0.02, high: 0.05 }, area: "county" } } } },
    };
    const score = shadowScore({ kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" }, certainty: "likely" }, under);
    expect(shadowText(score)).toBe(
      'The shadow score does not decide the level. One warning of "met.tornado" in one county gives 0.003 (0.002 to 0.005) deaths and 0.03 (0.02 to 0.05) injuries. The measure counts each event under an active alert. Thus it holds the probability of the event.',
    );
    expect(scoreLine(score)).toBe("Shadow score: 0.003 (0.002 to 0.005) expected deaths and 0.03 (0.02 to 0.05) expected injuries.");
  });
});

describe("the panel of the shadow score", () => {
  it("tells a view with no incident that reaches a person, and a runtime with no priors", () => {
    expect(differencePanel(EMPTY_FIXTURE.view)).toEqual({ verdict: { tone: "quiet", text: NO_REACH_TEXT }, rows: [] });
    // The fixture has incidents that reach a person, and none of them has a score.
    expect(differencePanel(MAP_FIXTURE.view)).toEqual({ verdict: { tone: "quiet", text: NO_SCORE_TEXT }, rows: [] });
  });

  it("names each pair where the table gives the higher level to the incident with clearly less expected harm", () => {
    const view = scored();
    const panel = differencePanel(view);
    expect(panel.verdict.tone).toBe("warn");
    const flood = byAnchor(view, ANCHORS.flood);
    const tornado = byAnchor(view, ANCHORS.tornado);
    // The tornado warning is life-safety, and the flash flood warning is urgent. The made-up priors give the flood more harm.
    expect(panel.rows).toContainEqual({
      anchor: ANCHORS.flood,
      name: flood.kind.label,
      level: flood.level,
      text: `The table gives it a lower level than ${tornado.kind.label} (Life-safety). The score expects more deaths and more injuries from it, and the intervals do not overlap.`,
      lines: [`${flood.kind.label}: 2 (1.5 to 2.5) expected deaths and 3 (2.5 to 3.5) expected injuries.`, `${tornado.kind.label}: 0.04 (0.03 to 0.06) expected deaths and 0.5 (0.4 to 0.6) expected injuries.`],
    });
    // Each row has the incident with the lower level, and each named incident reaches a person.
    for (const row of panel.rows) expect(byAnchor(view, row.anchor).level).not.toBe("none");
  });

  it("tells that the table and the score agree, and counts the scores with no value", () => {
    // With the harm of the flood below the harm of the tornado, no pair disagrees.
    const agree: ScorePriors = { ...PRIORS, kinds: { ...PRIORS.kinds, "met.flood": { deaths: { value: 0.01, low: 0.005, high: 0.02 }, injuries: { value: 0.1, low: 0.05, high: 0.2 } } } };
    const view = scored(agree);
    const reaching = view.incidents.filter((incident) => incident.level !== "none");
    const unread = reaching.filter((incident) => incident.shadow?.read === false).length;
    const panel = differencePanel(view);
    expect(panel.rows).toEqual([]);
    expect(panel.verdict.tone).toBe("good");
    expect(panel.verdict.text).toMatch(/^The table and the shadow score agree\. /);
    expect(panel.verdict.text).toContain(`${String(reaching.length)} incidents have a shadow score`);
    expect(unread).toBeGreaterThan(0);
    expect(panel.verdict.text).toContain(`, and ${String(unread)} score${unread === 1 ? " has" : "s have"} no value.`);
  });

  it("does not change when the order of the incidents changes", () => {
    const view = scored();
    const reversed = { ...view, incidents: [...view.incidents].reverse() };
    expect(differencePanel(reversed)).toEqual(differencePanel(view));
  });
});
