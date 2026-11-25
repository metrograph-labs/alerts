/**
 * This module holds the plan of a refresh of the store: the order of the requests, and the zones that a
 * new list removes. The functions are pure. They read the records and the clock that they get.
 */
import type { Duration, Instant, MapShape, RegionCode } from "@mark1russell7/alerts";
import { stateCode } from "@mark1russell7/alerts-format-nws";
import type { Condition } from "polite-crawler/api";
import { compareCodes, ZONE_KINDS, zoneOfCode, type ZoneKey, type ZoneKind } from "./zones.ts";

/** The record of one list: the codes of the zones of one kind of a state, at the time of the fetch. */
export interface CachedList {
  readonly state: string;
  readonly kind: ZoneKind;
  readonly fetched: Instant;
  /** The codes of the zones, in the order of the code. */
  readonly ids: readonly string[];
  /** The validators of the answer, for the next conditional request. */
  readonly condition?: Condition;
}

/** The head of the record of one zone: its name and the time of the fetch, with no shapes. The plan reads only heads. */
export interface ZoneHead {
  readonly kind: ZoneKind;
  readonly id: string;
  readonly state: string;
  readonly name: string;
  readonly fetched: Instant;
  /** The validators of the answer, for the next conditional request. */
  readonly condition?: Condition;
}

/** The record of one zone: its name and its shapes, at the time of the fetch. */
export interface CachedZone extends ZoneHead {
  readonly shapes: readonly MapShape[];
}

/** The records of the store, by their keys. */
export interface ShapeState {
  /** The lists, by `listKey`. */
  readonly lists: ReadonlyMap<string, CachedList>;
  /** The heads of the zones, by `zoneKey`. */
  readonly zones: ReadonlyMap<string, ZoneHead>;
}

/** This function gives the key of a list in the records. */
export const listKey = (state: string, kind: ZoneKind): string => `${state}:${kind}`;

/** This function gives the key of a zone in the records. */
export const zoneKey = (key: ZoneKey): string => `${key.kind}:${key.id}`;

/** The regions that the store keeps current: the zones of each state, and the zones of each code. */
export interface Wanted {
  /** The postal codes of the states, for example `KS`. The store keeps each county, forecast zone and fire zone of each state. */
  readonly states: readonly string[];
  /**
   * The region codes that need a shape first, for example the codes of the live incidents. A code can
   * be in a state that is not in `states`.
   */
  readonly codes?: readonly RegionCode[];
}

/** One request of a refresh: a list of a state, or the outline of one zone. */
export type Task = { readonly type: "list"; readonly state: string; readonly kind: ZoneKind } | { readonly type: "zone"; readonly key: ZoneKey };

/** This function gives the id of a task, for example `list:KS:county` or `zone:county:KSC173`. */
export const taskId = (task: Task): string => (task.type === "list" ? `list:${listKey(task.state, task.kind)}` : `zone:${zoneKey(task.key)}`);

/** The inputs of `plan`. */
export interface PlanInput {
  readonly state: ShapeState;
  readonly wanted: Wanted;
  readonly now: Instant;
  /** The age of a record when the store asks for it again. */
  readonly refreshMs: Duration;
  /** This function gives the time before which the store does not do a task again, after a failure. */
  readonly retryAt: (task: Task) => Instant | undefined;
}

/** The plan of a refresh. */
export interface Plan {
  /** The tasks that are due at the time of the plan, in the order of their rank. */
  readonly tasks: readonly Task[];
  /** The time of the next task that waits, or `undefined` when no task waits. */
  readonly next?: Instant;
}

/**
 * This function gives the tasks that are due, in this order:
 *
 * 1. The zones of the wanted codes with no record, in the order of the codes.
 * 2. The lists of the wanted states with no record.
 * 3. The zones of the lists with no record, by state, kind and code.
 * 4. The lists that are older than `refreshMs`.
 * 5. The zones of the states and of the codes that are older than `refreshMs`, from the oldest.
 *
 * A task waits until its time of `retryAt`. A task is in the plan once, at its first rank.
 */
export function plan(input: PlanInput): Plan {
  const { state, now, refreshMs } = input;
  const states = [...new Set(input.wanted.states.flatMap((text) => stateCode(text) ?? []))].sort();
  const codes = (input.wanted.codes ?? []).flatMap((code) => zoneOfCode(code) ?? []);

  // Each candidate is a task and the time when it is due. A task with no record is due at once.
  const candidates: { readonly task: Task; readonly dueAt: Instant }[] = [];
  const zoneTask = (key: ZoneKey): Task => ({ type: "zone", key });
  for (const key of codes) if (!state.zones.has(zoneKey(key))) candidates.push({ task: zoneTask(key), dueAt: -Infinity });
  for (const name of states) for (const kind of ZONE_KINDS) if (!state.lists.has(listKey(name, kind))) candidates.push({ task: { type: "list", state: name, kind }, dueAt: -Infinity });

  const listed: ZoneKey[] = [];
  for (const name of states) {
    for (const kind of ZONE_KINDS) {
      for (const id of state.lists.get(listKey(name, kind))?.ids ?? []) listed.push({ kind, id });
    }
  }
  for (const key of listed) if (!state.zones.has(zoneKey(key))) candidates.push({ task: zoneTask(key), dueAt: -Infinity });

  for (const name of states) {
    for (const kind of ZONE_KINDS) {
      const list = state.lists.get(listKey(name, kind));
      if (list !== undefined) candidates.push({ task: { type: "list", state: name, kind }, dueAt: list.fetched + refreshMs });
    }
  }

  const stale = [...codes, ...listed]
    .flatMap((key) => {
      const zone = state.zones.get(zoneKey(key));
      return zone === undefined ? [] : [{ task: zoneTask(key), dueAt: zone.fetched + refreshMs }];
    })
    .sort((a, b) => a.dueAt - b.dueAt || compareCodes(taskId(a.task), taskId(b.task)));
  candidates.push(...stale);

  const seen = new Set<string>();
  const tasks: Task[] = [];
  let next: Instant | undefined;
  for (const { task, dueAt } of candidates) {
    const id = taskId(task);
    if (seen.has(id)) continue;
    seen.add(id);
    const at = Math.max(dueAt, input.retryAt(task) ?? -Infinity);
    if (at <= now) tasks.push(task);
    else next = next === undefined ? at : Math.min(next, at);
  }
  return next === undefined ? { tasks } : { tasks, next };
}

/**
 * This function gives the zones that a complete list removes: the zones of its state and kind that the
 * list does not have. The zone service of the NWS removes a zone when its outline goes out of use.
 */
export function dropsOf(state: ShapeState, list: Pick<CachedList, "state" | "kind" | "ids">): readonly ZoneKey[] {
  const ids = new Set(list.ids);
  return [...state.zones.values()].filter((zone) => zone.state === list.state && zone.kind === list.kind && !ids.has(zone.id)).map(({ kind, id }) => ({ kind, id }));
}
