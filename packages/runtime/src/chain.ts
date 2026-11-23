/**
 * The stack of the alert chain and the state of each of its functions (AL-90).
 *
 * The private configuration holds a stack document with a layer of risks, and the subjects of the sources that tell the
 * state of its parts. A live incident about such a subject tells that its part is down. The function `chainStates` asks
 * the layer of risks for the state of each function with these parts down. It gives the new single points of failure:
 * the points with the down parts, less the points with no part down. Thus a single point that the design accepts gives no
 * report, and a single point that an outage makes gives one.
 */
import type { ChainConfig, ChainPart, Incident, PersonId, PersonWatch, RedundancyState } from "@mark1russell7/alerts";
import { goalStates, RISK_SCHEMA, type RiskLayer } from "@mark1russell7/stack-risk";
import { parseRisk } from "@mark1russell7/stack-risk/schema";
import { checkStack, type Stack } from "@mark1russell7/system-stack";
import { parseStack } from "@mark1russell7/system-stack/schema";

/** The stack of the alert chain after its read. */
export interface Chain {
  readonly stack: Stack;
  readonly layer: RiskLayer;
  /** The parts of each subject, by the key of the subject (`subjectKey`). */
  readonly parts: ReadonlyMap<string, readonly string[]>;
  /** The single points of each function with no part down. */
  readonly accepted: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The result of the read of the stack of the alert chain: the chain, or the problems of the configuration. */
export type ChainRead = { readonly ok: true; readonly chain: Chain } | { readonly ok: false; readonly problems: readonly string[] };

/** This function gives the key of a subject in the map of the parts. */
function subjectKey(system: string, id: string): string {
  return `${system}\u0000${id}`;
}

/**
 * This function reads the stack of the alert chain from the configuration. It gives a problem for each of these faults:
 *
 * - a stack document or a layer of risks with a fault of its form
 * - an error of the stack check
 * - a subject or a goal of a part that is not in the stack
 * - a function whose state the search cannot read in its limit
 */
export function readChain(config: ChainConfig): ChainRead {
  const read = parseStack(config.stack);
  if (!read.ok) return { ok: false, problems: read.errors.map((error) => `chain: ${error}`) };
  const stack = read.stack;
  const risk = parseRisk(stack.layers?.[RISK_SCHEMA]);
  if (!risk.ok) return { ok: false, problems: [`chain: the stack has no layer "${RISK_SCHEMA}" with a good form.`, ...risk.errors.map((error) => `chain: ${error}`)] };
  const layer = risk.layer;
  const ids = new Set(stack.parts.map((part) => part.id));
  const problems = [
    ...checkStack(stack)
      .filter((fault) => fault.level === "error")
      .map((fault) => `chain: ${fault.message}`),
    ...config.subjects.filter((subject) => !ids.has(subject.part)).map((subject) => `chain: the subject ${subject.system}:${subject.id} names the part "${subject.part}", which is not in the stack.`),
    ...layer.goals.filter((goal) => !ids.has(goal.part)).map((goal) => `chain: the goal of the part "${goal.part}" names a part that is not in the stack.`),
  ];
  if (problems.length > 0) return { ok: false, problems };
  const accepted = new Map<string, ReadonlySet<string>>();
  for (const state of goalStates(layer, stack)) {
    if (!state.read) problems.push(`chain: the search cannot read the state of the function "${state.part}" in its limit.`);
    else accepted.set(state.part, new Set(state.points));
  }
  if (problems.length > 0) return { ok: false, problems };
  const parts = new Map<string, string[]>();
  for (const subject of config.subjects) {
    const key = subjectKey(subject.system, subject.id);
    const list = parts.get(key) ?? [];
    if (!list.includes(subject.part)) list.push(subject.part);
    parts.set(key, list);
  }
  return { ok: true, chain: { stack, layer, parts, accepted } };
}

/** This function gives the problems of the stack of the alert chain in the configuration. With no stack, it gives no problem. */
export function chainProblems(config: ChainConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const read = readChain(config);
  return read.ok ? [] : read.problems;
}

/** The person id of the watch of the chain (`chainWatch`). No person of a configuration has it, and it gets no delivery. */
export const CHAIN_READER = "alerts-chain" as PersonId;

/**
 * This function gives the watch of the stack of the alert chain. The instance reads each status page and each feed that
 * a person or this watch can get. Thus each subject of the chain has a source, also when no person names it. The watch
 * selects sources only. It has no place and no rule, and it gets no delivery.
 */
export function chainWatch(config: ChainConfig): PersonWatch {
  return { person: CHAIN_READER, places: [], rules: [], subjects: config.subjects.map(({ system, id }) => ({ system, id })) };
}

/**
 * This function gives the parts of the chain that are down: the parts of each subject of each live incident with the
 * status `actual`. The parts are in the order of the stack.
 */
export function downParts(chain: Chain, incidents: readonly Incident[]): string[] {
  const down = new Set<string>();
  for (const incident of incidents) {
    if (!incident.live || incident.status !== "actual") continue;
    for (const subject of incident.about) for (const part of chain.parts.get(subjectKey(subject.system, subject.id)) ?? []) down.add(part);
  }
  return chain.stack.parts.filter((part) => down.has(part.id)).map((part) => part.id);
}

/**
 * This function gives the state of each function of the chain with the down parts of the incidents. A function is a goal
 * of the layer of risks. A function whose state the search cannot read in its limit gives no state, thus its open lines
 * stay open. The function is pure.
 */
export function chainStates(chain: Chain, incidents: readonly Incident[]): RedundancyState[] {
  const named = new Map(chain.stack.parts.map((part) => [part.id, part.name ?? part.id]));
  const ref = (id: string): ChainPart => ({ id, name: named.get(id) ?? id });
  const down = downParts(chain, incidents);
  return goalStates(chain.layer, chain.stack, { down }).flatMap((state): RedundancyState[] => {
    if (!state.read) return [];
    const accepted = chain.accepted.get(state.part) ?? new Set<string>();
    const points = state.points.filter((point) => !accepted.has(point));
    return [{ function: ref(state.part), works: state.works, points: [...new Set(points)].map(ref), down: down.map(ref) }];
  });
}
