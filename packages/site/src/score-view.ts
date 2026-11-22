/**
 * The words and the panel of the shadow score (AL-31). The shadow score operates next to the table of the levels. It
 * decides a level only through the score rule of a person. The card of each incident tells its score. The panel tells
 * each pair where the table and the score disagree.
 *
 * The data functions are pure. The draw functions make the elements of that data.
 */

import {
  shadowDifferences,
  type AlertArea,
  type AssessedLevel,
  type Estimate,
  type MapIncident,
  type MapView,
  type ScoreFactor,
  type ScoreRuleReason,
  type ShadowScore,
} from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { countOf } from "@mark1russell7/text/english";
import { LEVEL_WORDS, levelChip } from "./draw.ts";
import type { Verdict } from "./health-view.ts";

// A number with two significant digits.
function figure(value: number): string {
  return Number(value.toPrecision(2)).toString();
}

/** This function gives a measured value with its interval, for example `0.035 (0.023 to 0.048)`. */
export function estimateText(estimate: Estimate): string {
  return `${figure(estimate.value)} (${figure(estimate.low)} to ${figure(estimate.high)})`;
}

// The source of the probability of a shadow score.
function probabilitySource(factor: ScoreFactor): string {
  return factor.from.table === "kinds" ? `the verified share of the warnings of "${factor.from.key}"` : `the certainty "${factor.from.key}"`;
}

// The words of one area of each kind.
const AREA_WORDS: Readonly<Record<AlertArea, string>> = { county: "one county", zone: "one zone" };

// The source of the harm under an alert.
function underSource(factor: ScoreFactor): string {
  const { from } = factor;
  return from.table === "under" ? `One ${from.significance} of "${from.key}" in ${AREA_WORDS[from.area]}` : `One alert of "${from.key}"`;
}

/** This function gives the text of a shadow score. The score does not decide the level, and the text tells this first. */
export function shadowText(score: ShadowScore): string {
  if (!score.read) return `The shadow score does not decide the level, and it has no value. The priors do not give these factors: ${score.missing.join(", ")}.`;
  if (score.basis === "alert") {
    const harm = `${underSource(score.deaths)} gives ${estimateText(score.expected.deaths)} deaths and ${estimateText(score.expected.injuries)} injuries.`;
    return `The shadow score does not decide the level. ${harm} The measure counts each event under an active alert. Thus it holds the probability of the event.`;
  }
  const { probability, deaths, injuries, expected } = score;
  const harm = `One event of this kind gives ${estimateText(deaths.estimate)} deaths and ${estimateText(injuries.estimate)} injuries.`;
  const keys =
    deaths.from.key === injuries.from.key
      ? `These counts come from the measures of "${deaths.from.key}".`
      : `The deaths come from the measures of "${deaths.from.key}", and the injuries from "${injuries.from.key}".`;
  const product = `The expected harm is the probability times each count: ${estimateText(expected.deaths)} deaths and ${estimateText(expected.injuries)} injuries.`;
  return `The shadow score does not decide the level. The probability of the event is ${estimateText(probability.estimate)}, from ${probabilitySource(probability)}. ${harm} ${keys} ${product}`;
}

/**
 * This function gives the text of the score rule of a person. The rule raises a level to `life-safety` when the expected
 * deaths reach its risk value. It does not lower a level.
 */
export function scoreRuleText(reason: ScoreRuleReason): string {
  const risk = String(reason.risk);
  if (reason.score === undefined) return `The score rule of the person has the risk value ${risk}. The policy has no priors, so the table decides the level.`;
  if (!reason.score.read) return `The score rule of the person has the risk value ${risk}. The score has no value, so the table decides the level.`;
  const deaths = estimateText(reason.score.expected.deaths);
  if (reason.raised) return `The score rule of the person sets the level life-safety: the expected deaths, ${deaths}, reach the risk value ${risk}.`;
  return reason.score.expected.deaths.value >= reason.risk
    ? `The expected deaths, ${deaths}, reach the risk value ${risk} of the score rule, and the table gives life-safety.`
    : `The expected deaths, ${deaths}, are below the risk value ${risk} of the score rule, so the table decides the level.`;
}

// The expected harm of a score, or the words of a score with no value.
function harmText(score: ShadowScore | undefined): string {
  return score?.read === true ? `${estimateText(score.expected.deaths)} expected deaths and ${estimateText(score.expected.injuries)} expected injuries` : "no value";
}

/** This function gives the short line of a shadow score for the card of an incident. */
export function scoreLine(score: ShadowScore): string {
  return score.read ? `Shadow score: ${harmText(score)}.` : `Shadow score: no value. The priors do not give: ${score.missing.join(", ")}.`;
}

/** One row of the panel: a pair where the table and the score disagree. */
export interface DifferenceRow {
  /** The anchor of the incident with the lower level and the higher expected harm. */
  readonly anchor: string;
  /** The label of the kind of that incident. */
  readonly name: string;
  /** The level that the table gives that incident. */
  readonly level: AssessedLevel;
  /** The sentence of the difference. */
  readonly text: string;
  /** The expected harm of the two incidents: first the incident of the row, then the incident with the higher level. */
  readonly lines: readonly string[];
}

/** The data of the panel: one sentence, and one row for each difference. */
export interface DifferencePanel {
  readonly verdict: Verdict;
  readonly rows: readonly DifferenceRow[];
}

/** The sentence of a view with no incident that reaches a person. */
export const NO_REACH_TEXT = "No live incident reaches a person. Thus no incident has a shadow score.";

/** The sentence of a runtime that gives no score: it has no priors. */
export const NO_SCORE_TEXT = "This runtime gives no shadow score. It has no priors.";

function rowOf(above: MapIncident, below: MapIncident): DifferenceRow {
  return {
    anchor: below.anchor,
    name: below.kind.label,
    level: below.level,
    text: `The table gives it a lower level than ${above.kind.label} (${LEVEL_WORDS[above.level]}). The score expects more deaths and more injuries from it, and the intervals do not overlap.`,
    lines: [`${below.kind.label}: ${harmText(below.shadow)}.`, `${above.kind.label}: ${harmText(above.shadow)}.`],
  };
}

/**
 * This function gives the data of the panel from the view of the map. The rows come from `shadowDifferences` of the core,
 * in its order. An incident with the level `none` has no score, so it is in no row.
 */
export function differencePanel(view: MapView): DifferencePanel {
  const reaching = view.incidents.filter((incident) => incident.level !== "none");
  if (reaching.length === 0) return { verdict: { tone: "quiet", text: NO_REACH_TEXT }, rows: [] };
  const scored = reaching.flatMap((incident) => (incident.shadow === undefined ? [] : [incident.shadow]));
  if (scored.length === 0) return { verdict: { tone: "quiet", text: NO_SCORE_TEXT }, rows: [] };
  const byAnchor = new Map(view.incidents.map((incident) => [incident.anchor, incident]));
  const rows = shadowDifferences(view.incidents).flatMap(({ above, below }) => {
    const high = byAnchor.get(above);
    const low = byAnchor.get(below);
    return high === undefined || low === undefined ? [] : [rowOf(high, low)];
  });
  const unread = scored.filter((score) => !score.read).length;
  const noValue = unread === 0 ? "" : `, and ${countOf(unread, "score")} ${unread === 1 ? "has" : "have"} no value`;
  const counted = `${countOf(scored.length, "incident")} ${scored.length === 1 ? "has" : "have"} a shadow score${noValue}.`;
  if (rows.length === 0) return { verdict: { tone: "good", text: `The table and the shadow score agree. ${counted}` }, rows };
  const pairs = `${countOf(rows.length, "pair")} where the score expects clearly more harm from the incident with the lower level.`;
  return { verdict: { tone: "warn", text: `${pairs} ${counted}` }, rows };
}

/**
 * This function draws the score on the card of an incident: the short line, and the full text in a part that opens. The
 * card selects its incident on a click and on the keys Enter and space. Thus the part keeps these events from the card.
 */
export function drawScore(score: ShadowScore): HTMLElement {
  const part = h("details", { class: "score" }, h("summary", {}, scoreLine(score)), h("p", {}, shadowText(score)));
  for (const type of ["click", "keydown"] as const) part.addEventListener(type, (event) => event.stopPropagation());
  return part;
}

function drawRow(row: DifferenceRow): HTMLElement {
  return h(
    "li",
    { class: "source-row", "data-anchor": row.anchor },
    h("strong", { class: "source-name" }, row.name),
    h("span", { class: "source-state" }, levelChip(row.level)),
    h("span", { class: "source-read" }, row.text),
    h("div", { class: "source-more" }, ...row.lines.map((line) => h("p", {}, line))),
  );
}

/** This function draws the rows of the panel. A panel with no row gives no element. */
export function drawDifferences(panel: DifferencePanel): HTMLElement[] {
  return panel.rows.length === 0 ? [] : [h("ul", { class: "source-list", "aria-label": "The pairs where the table and the shadow score disagree" }, ...panel.rows.map(drawRow))];
}
