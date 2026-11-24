/**
 * This module holds the store of the shapes of the NWS zones. The store gives the lookup of the map and
 * the basemap of a state from its records. Its refresh gets the records from the zone service of the
 * NWS API, one request at a time, between the fetches of the alerts.
 */
import type { Duration, FetchFailure, Instant, MapRegion, MapShape, RegionCode, ShapeLookup, SourceId } from "@mark1russell7/alerts";
import { createRequester, problemDetail } from "@mark1russell7/alerts-fetch";
import { stateCode, stateOfUgc } from "@mark1russell7/alerts-format-nws";
import { NWS_BASE_URL } from "@mark1russell7/alerts-source-nws-api";
import type { Answer, Condition, Conditions, Pace, Transport } from "polite-crawler/api";
import type { ShapeCache } from "./cache.ts";
import { dropsOf, listKey, plan, taskId, zoneKey, type CachedList, type CachedZone, type Plan, type ShapeState, type Task, type Wanted } from "./plan.ts";
import { BASEMAP_KINDS, codeOfZone, compareCodes, listPath, readList, readZone, zoneOfCode, zonePath, type ZoneKey, type ZoneKind } from "./zones.ts";

/**
 * The age of a record when the store asks for it again: 7 days. Each request is conditional, thus a
 * zone with no change costs an answer 304 with no body.
 *
 * TODO(AL-18): The end of this fixed period is the export `freshUntil` of `polite-crawler/api`
 * (mark1russell7/crawler, the PR of the crawler role). Then the age of each record comes from the
 * headers `Cache-Control` and `Expires` of its answer, as RFC 9111 tells.
 */
export const REFRESH_MS: Duration = 7 * 24 * 60 * 60 * 1000;

/** The wait before the store asks again for a zone or a list with a refused or incorrect answer: 1 hour. */
export const RETRY_MS: Duration = 60 * 60 * 1000;

/** The wait of the store after a failure of the host, when the host asks for no longer wait: 5 minutes. */
export const HOST_RETRY_MS: Duration = 5 * 60 * 1000;

/** The options of `createShapeStore`. */
export interface ShapeStoreOptions {
  /** The pace of polite-crawler. Give the pace of the alert sources, thus the two share the rests of the host. */
  readonly pace: Pace;
  /** The transport that sends each request. */
  readonly transport: Transport;
  /** The `User-Agent` header. The NWS API refuses a request with no `User-Agent`. */
  readonly userAgent: string;
  readonly cache: ShapeCache;
  /** The base URL of the NWS API. The default is `NWS_BASE_URL`. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
  /** The age of a record when the store asks for it again. The default is `REFRESH_MS`. */
  readonly refreshMs?: Duration;
  /** The wait after a refused or incorrect answer. The default is `RETRY_MS`. */
  readonly retryMs?: Duration;
  /** The shortest wait after a failure of the host. The default is `HOST_RETRY_MS`. */
  readonly hostRetryMs?: Duration;
}

/** The input of a refresh. */
export interface RefreshInput {
  readonly wanted: Wanted;
  /**
   * The refresh starts no request that can end after this time. The caller gives the time of its next
   * fetch from the host of the store (the sources with `NWS_PROVIDER`). The store shares the pace of that host, and a
   * request waits only for the rest of its own host. Thus a refresh delays a fetch of the alerts by one request or less.
   */
  readonly until: Instant;
  readonly signal?: AbortSignal;
}

/** The failure of one task of a refresh. */
export interface TaskFailure {
  /** The id of the task, for example `zone:county:KSC173`. */
  readonly task: string;
  readonly failure: FetchFailure;
}

/** The result of a refresh. */
export interface Refreshed {
  /** The count of the requests of the refresh. */
  readonly requests: number;
  readonly failures: readonly TaskFailure[];
  /** The problems of the answers: a row with a problem, or an outline that is not correct. */
  readonly problems: readonly string[];
  /**
   * The cause of the stop. The value `done` tells that no task is due. The value `until` tells that the
   * time ended before a due task. The value `host` tells that the host failed. Then the store waits before its next request.
   */
  readonly stop: "done" | "until" | "host";
  /** The time when the next task is due, or `undefined` when no task waits. */
  readonly next?: Instant;
}

/** The store of the shapes. */
export interface ShapeStore {
  /** This function gives the shapes of a region code. It reads only the records. */
  readonly lookup: ShapeLookup;
  /**
   * This function gives the region of a code, with the name and the shapes of its zone, or `undefined` when the store has no record.
   * The code of the region is the UGC code of the zone. Thus a SAME code gives the UGC code of its county. A fire zone code
   * (`ugc-fire`) gives the fire zone, with its `ugc-fire` code.
   */
  region(code: RegionCode): MapRegion | undefined;
  /** This function gives the regions of the basemap of a state: each county, then each forecast zone, in the order of the code. */
  basemap(state: string): readonly MapRegion[];
  /**
   * This function gives the fire zones of a state, with their `ugc-fire` codes, in the order of the code (AL-33). It gives them only
   * when the store has the outline of each zone of the list. Else it gives none: a place then has no fire zone code of the
   * state, and the match uses its forecast zone code. Thus a place does not lose an alert while the store loads the outlines.
   */
  fireZones(state: string): readonly MapRegion[];
  /** This function gives the time when the next task of these regions is due, or `undefined` when no task waits. */
  nextDue(wanted: Wanted): Instant | undefined;
  /**
   * This function does the due tasks, one request at a time, from the first rank of `plan`. Only the
   * abort of the signal throws. A second refresh during a refresh throws too.
   */
  refresh(input: RefreshInput): Promise<Refreshed>;
}

/** The name of the requests of the store in the messages of polite-crawler. */
const ZONES_SOURCE = "nws-zones" as SourceId;

/** The failures of the host. After one of them, the store waits before its next request. */
const HOST_FAILURES: ReadonlySet<FetchFailure["kind"]> = new Set(["timeout", "network", "rate-limited", "server"]);

/** The outcome of one task. */
type Done = { readonly ok: true; readonly problems: readonly string[] } | { readonly ok: false; readonly failure?: FetchFailure; readonly problems: readonly string[] };

/** This function checks that a duration is a positive number of milliseconds. */
function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`The option ${name} is ${String(value)}, not a positive number of milliseconds.`);
  return value;
}

/**
 * This function makes the store. It reads the lists and the heads of the zones of the cache once. It reads the shapes
 * of a zone at its first use. The store writes each new record to the cache before it uses the record.
 */
export function createShapeStore(options: ShapeStoreOptions): ShapeStore {
  const { pace, cache } = options;
  const refreshMs = positive("refreshMs", options.refreshMs ?? REFRESH_MS);
  const retryMs = positive("retryMs", options.retryMs ?? RETRY_MS);
  const hostRetryMs = positive("hostRetryMs", options.hostRetryMs ?? HOST_RETRY_MS);
  const requester = createRequester({
    // The name of the requests in each message of polite-crawler. The zone service is not a source of alerts.
    source: ZONES_SOURCE,
    pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? NWS_BASE_URL,
    headers: { accept: "application/geo+json", "user-agent": options.userAgent },
    detail: problemDetail,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  // The longest time of one request: the rest of the host, then the time limit.
  const budget = (options.minIntervalMs ?? 1000) + requester.timeoutMs;

  const records = cache.load();
  const lists = new Map(records.lists.map((list) => [listKey(list.state, list.kind), list]));
  const zones = new Map(records.zones.map((zone) => [zoneKey(zone), zone]));
  const state: ShapeState = { lists, zones };
  // The shapes of the zones in use. The store reads the shapes of a zone from the cache at its first use, and then it keeps
  // them. Thus a lookup gives the same array until the record changes. The keeper of the instance uses that identity.
  // The store does not drop the shapes of a zone that is not in use: the view of the map reads each of them at each request
  // (AL-176). A copy with no request of the map reads only the zones of its places.
  const outlines = new Map<string, readonly MapShape[]>();
  const shapesOf = (key: ZoneKey): readonly MapShape[] | undefined => {
    const id = zoneKey(key);
    const known = outlines.get(id);
    if (known !== undefined) return known;
    if (!zones.has(id)) return undefined;
    const read = cache.outline(key);
    if (read === undefined) {
      // A head with shapes that do not parse is not a record. Thus the plan asks for the zone again.
      zones.delete(id);
      return undefined;
    }
    outlines.set(id, read);
    return read;
  };
  // The waits after failures, in memory only. A restart asks again at once.
  const taskRetry = new Map<string, Instant>();
  let hostRetry: Instant | undefined;
  let running = false;

  const planAt = (wanted: Wanted, now: Instant): Plan =>
    plan({
      state,
      wanted,
      now,
      refreshMs,
      retryAt: (task) => {
        const own = taskRetry.get(taskId(task));
        return own === undefined ? hostRetry : hostRetry === undefined ? own : Math.max(own, hostRetry);
      },
    });

  /**
   * This function sends one request with the validators of its record. It gives the answer and the
   * validators of a new body.
   */
  const get = async (path: string, what: string, known: Condition | undefined, signal: AbortSignal | undefined) => {
    let fresh: Condition | undefined;
    // A store of one URL: it gives the validators only for a record, thus a 304 always has a record.
    const conditions: Conditions = { get: () => known, set: (_url, condition) => void (fresh = condition) };
    const requested = await requester.get({ path, what, conditions }, signal);
    return { requested, condition: fresh ?? known };
  };

  const notModified = (answer: Answer): boolean => answer.classified.outcome === "not-modified";

  // The regions of the zones of one kind of a state that have a record, in the order of the list.
  const regionsOf = (state: string, kind: ZoneKind): MapRegion[] =>
    (lists.get(listKey(state, kind))?.ids ?? []).flatMap((id): MapRegion[] => {
      const zone = zones.get(zoneKey({ kind, id }));
      const shapes = zone === undefined ? undefined : shapesOf(zone);
      return zone === undefined || shapes === undefined ? [] : [{ code: codeOfZone(zone), name: zone.name, shapes }];
    });

  const runList = async (task: Extract<Task, { type: "list" }>, signal: AbortSignal | undefined): Promise<Done> => {
    const old = lists.get(listKey(task.state, task.kind));
    const { requested, condition } = await get(listPath(task.state, task.kind), `the ${task.kind} zones of ${task.state}`, old?.condition, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure, problems: [] };
    const fetched = pace.now();
    if (notModified(requested.answer) && old !== undefined) {
      const list: CachedList = { ...old, fetched };
      cache.putList(list, []);
      lists.set(listKey(list.state, list.kind), list);
      return { ok: true, problems: [] };
    }
    const read = readList(requested.answer.reply.body, task.state, task.kind);
    if (!read.ok) return { ok: false, problems: [read.problem] };
    // An incomplete list removes no zone, and it keeps the codes of the old list.
    const ids = read.complete ? read.ids : [...new Set([...(old?.ids ?? []), ...read.ids])].sort(compareCodes);
    const list: CachedList = { state: task.state, kind: task.kind, fetched, ids, ...(condition === undefined ? {} : { condition }) };
    const drops = read.complete ? dropsOf(state, list) : [];
    cache.putList(list, drops);
    lists.set(listKey(list.state, list.kind), list);
    for (const drop of drops) {
      zones.delete(zoneKey(drop));
      outlines.delete(zoneKey(drop));
    }
    return { ok: true, problems: read.problems };
  };

  const runZone = async (task: Extract<Task, { type: "zone" }>, signal: AbortSignal | undefined): Promise<Done> => {
    const { key } = task;
    const old = zones.get(zoneKey(key));
    const { requested, condition } = await get(zonePath(key), `the outline of ${key.id}`, old?.condition, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure, problems: [] };
    const fetched = pace.now();
    let zone: CachedZone;
    if (notModified(requested.answer) && old !== undefined) {
      // The 304 reads the shapes of a zone that is not in use, and it does not keep them. A record with shapes that do not
      // parse is not a record: the next request of the zone has no validators.
      const shapes = outlines.get(zoneKey(old)) ?? cache.outline(old);
      if (shapes === undefined) {
        zones.delete(zoneKey(old));
        return { ok: false, problems: [`The cache has no shapes of ${key.id}.`] };
      }
      zone = { ...old, fetched, shapes };
    } else {
      const read = readZone(requested.answer.reply.body, key);
      if (!read.ok) return { ok: false, problems: [read.problem] };
      // `zoneOfCode` and `readList` give only codes of a state.
      const zoneState = stateOfUgc(key.id) ?? "";
      zone = { kind: key.kind, id: key.id, state: zoneState, name: read.name, fetched, shapes: read.shapes, ...(condition === undefined ? {} : { condition }) };
    }
    cache.putZone(zone);
    const { shapes, ...head } = zone;
    zones.set(zoneKey(zone), head);
    // A zone in use gets its new shapes. The shapes of a zone that is not in use stay in the cache.
    if (outlines.has(zoneKey(zone))) outlines.set(zoneKey(zone), shapes);
    return { ok: true, problems: [] };
  };

  return {
    lookup(code) {
      const key = zoneOfCode(code);
      return key === undefined ? undefined : shapesOf(key);
    },
    region(code) {
      const key = zoneOfCode(code);
      const zone = key === undefined ? undefined : zones.get(zoneKey(key));
      const shapes = zone === undefined ? undefined : shapesOf(zone);
      return zone === undefined || shapes === undefined ? undefined : { code: codeOfZone(zone), name: zone.name, shapes };
    },
    basemap(name) {
      const code = stateCode(name);
      return code === undefined ? [] : BASEMAP_KINDS.flatMap((kind) => regionsOf(code, kind));
    },
    fireZones(name) {
      const code = stateCode(name);
      if (code === undefined) return [];
      const ids = lists.get(listKey(code, "fire"))?.ids ?? [];
      const regions = regionsOf(code, "fire");
      return ids.length > 0 && regions.length === ids.length ? regions : [];
    },
    nextDue(wanted) {
      const now = pace.now();
      const current = planAt(wanted, now);
      return current.tasks.length > 0 ? now : current.next;
    },
    async refresh({ wanted, until, signal }) {
      if (running) throw new Error("The store of the shapes has a refresh in progress.");
      running = true;
      const failures: TaskFailure[] = [];
      const problems: string[] = [];
      let requests = 0;
      const result = (stop: Refreshed["stop"], next: Instant | undefined): Refreshed => ({ requests, failures, problems, stop, ...(next === undefined ? {} : { next }) });
      try {
        for (;;) {
          signal?.throwIfAborted();
          const now = pace.now();
          const current = planAt(wanted, now);
          const task = current.tasks[0];
          if (task === undefined) return result("done", current.next);
          if (now + budget > until) return result("until", now);
          const done = task.type === "list" ? await runList(task, signal) : await runZone(task, signal);
          requests += 1;
          problems.push(...done.problems);
          const id = taskId(task);
          if (done.ok) {
            taskRetry.delete(id);
            continue;
          }
          const failed = pace.now();
          if (done.failure !== undefined) failures.push({ task: id, failure: done.failure });
          if (done.failure !== undefined && HOST_FAILURES.has(done.failure.kind)) {
            const retryAfter = "retryAfter" in done.failure ? (done.failure.retryAfter ?? 0) : 0;
            hostRetry = failed + Math.max(hostRetryMs, retryAfter);
            return result("host", planAt(wanted, failed).next);
          }
          taskRetry.set(id, failed + retryMs);
        }
      } finally {
        running = false;
      }
    },
  };
}
