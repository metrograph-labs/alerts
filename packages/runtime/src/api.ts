import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { packMap, type CopyWatch, type HealthPayload, type HistoryPayload, type Instant, type InterestsPayload, type MapPayload, type SourceId } from "@mark1russell7/alerts";
import { findFilesAsync } from "@mark1russell7/files";
import type { ServiceBuilder } from "@mark1russell7/service";
import { handle, httpTransport } from "@mark1russell7/service/http";
import { folderHandler } from "@mark1russell7/service/http-folder";
import { callContext } from "@mark1russell7/service/otel";
import type { RuntimeLoop } from "./loop.ts";
import type { ModeStatus } from "./observe.ts";
import type { OutageDeployState } from "./outage.ts";

/** The address of each server of the service. Only this computer reaches the API and the probes. */
export const LOOPBACK = "127.0.0.1";

/** These are the options of the API of the service. */
export interface ApiOptions {
  /** This number is the port of the API. */
  readonly port: number;
  /** The loop of the runtime. The route `GET /status` reads it. */
  readonly loop: RuntimeLoop;
  /**
   * This function gives the payload of the route `GET /map`. The payload holds the labels and the positions of the places,
   * thus only the loopback address serves it. Without the function, the API has no map route.
   */
  readonly map?: (() => MapPayload) | undefined;
  /**
   * This function gives the payload of the route `GET /health`: the health of each part of the system. Its coverage holds
   * the ids of the places, thus only the loopback address serves it. Without the function, the API has no health route.
   */
  readonly health?: (() => HealthPayload) | undefined;
  /**
   * This function gives the payload of the route `GET /history` for a value of the query `since`. The levels come from the
   * watches of the people, thus only the loopback address serves it. Without the function, the API has no history route.
   */
  readonly history?: ((since: Instant | null) => HistoryPayload) | undefined;
  /**
   * This function gives the payload of the route `GET /interests`: the rows of the interest graph of each person. It
   * holds the labels of the places, thus only the loopback address serves it. Without the function, the API has no such route.
   */
  readonly interests?: (() => InterestsPayload) | undefined;
  /**
   * The folder of the built local page (`pageFolder`). The path `/` gives its file `PAGE_INDEX`. The page and the route
   * `GET /map` have one origin. Thus the policy of the folder lets the page read the map. Without the folder, the API serves no page.
   */
  readonly page?: string | undefined;
  /** The worker of the deploy of the outage call. The route `GET /status` reads its state. */
  readonly outage?: { state(): OutageDeployState };
  /** The files of the start of the runtime. The route `GET /status` gives them. */
  readonly start?: StartStatus;
  /** The watches of the other copies. The route `GET /status` gives the time of the last read of each copy (AL-186). */
  readonly copies?: { watches(): readonly CopyWatch[] } | undefined;
}

/** The last read of another copy (AL-186). A deploy stops the runtime only when each other copy had a recent read. */
export interface CopyReadLine {
  /** The id of the other copy, from `copy.json`. */
  readonly copy: string;
  /** The time of the last read that passed, or `null` before the first read. */
  readonly readAt: Instant | null;
  /**
   * The first read that told that the copy is not steady, or `null` (AL-204). A copy that started a short time ago is not
   * steady. A copy of an older build tells nothing, thus it has `null`.
   */
  readonly unsteadySince: Instant | null;
  /**
   * The end of the deploy mark of the copy, or `null` (AL-208). A deploy of this host does not stop the runtime before that
   * time. A copy of an older build tells nothing, thus it has `null`.
   */
  readonly deployUntil: Instant | null;
}

/**
 * The files of the start: the private files, or the last good set (`reload.ts`). A runtime on the last good set has the count
 * of the reasons. The reasons are in the output of the runtime, and the status holds no reason.
 */
export interface StartStatus {
  readonly use: "files" | "good";
  readonly reasons: number;
}

/**
 * The answer of `GET /status`. It has the times and the counts of the last pass, and no incident,
 * place or person. Thus a log or a watcher that reads it gets no private value.
 */
export interface Status {
  /** The time of the last pass that ended, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The wake time of the last pass, or `null` when it has none. */
  readonly wakeAt: Instant | null;
  /** The sources that the last pass fetched. */
  readonly fetched: readonly SourceId[];
  /** The count of the sends of the last pass. */
  readonly sent: number;
  /** The count of the conflicts of the last pass. */
  readonly conflicts: number;
  /** The reason that the loop is stuck, or `null`. */
  readonly stuck: string | null;
  /** The state of the deploy of the outage call. An instance with no outage call has no field. */
  readonly outage?: OutageDeployState;
  /** The files of the start. A runtime with no start files, for example a test, has no field. */
  readonly start?: StartStatus;
  /** The mode of each source of the last pass (AL-73): observe or live, with the rate and the share of each source that observes. */
  readonly modes?: readonly ModeStatus[];
  /** The last read of each other copy (AL-186). A runtime with no other copy has no field. */
  readonly copies?: readonly CopyReadLine[];
}

/** The answer of a route to a request with a bad query. The route gives it with the status 400. */
export interface QueryProblem {
  readonly problem: string;
}

// The digits of a time in milliseconds since the epoch: no sign, no fraction and no zero before another digit.
const WHOLE = /^(0|[1-9][0-9]*)$/;

/**
 * This function reads the query `since` of the history route from the URL of a request. No value gives `null`. A value
 * that is not a whole number of milliseconds, or two values, give a problem.
 */
export function sinceOf(url: string | undefined): Instant | null | QueryProblem {
  const values = new URL(url ?? "/", "http://loopback").searchParams.getAll("since");
  const [value] = values;
  if (value === undefined) return null;
  if (values.length > 1 || !WHOLE.test(value) || !Number.isSafeInteger(Number(value))) {
    return { problem: "The query since is one time in milliseconds since the epoch: a whole number with no sign." };
  }
  return Number(value);
}

/** The file of the built local page that the path `/` gives. */
export const PAGE_INDEX = "local.html";

/** This function gives the folder of the built local page in a checkout, from the folder of the package `runtime`. */
export const pageFolder = (root: string): string => join(root, "..", "site", "dist");

/** The state of the built local page of a checkout: current, older than its source files, or not built. */
export type PageState = "current" | "stale" | "missing";

/**
 * The source files of the local page, as globs in the folder `packages`. The page bundles the core and a source package.
 * Thus the globs hold the source folder of each package. A change of another package gives a build that has no effect.
 */
export const PAGE_SOURCES: readonly string[] = ["*/src/**", "site/*.html", "site/vite.config.ts"];

/**
 * This function gives the state of the page from the time of its index file and the times of its source files. The
 * page is stale when a source file is newer than the index file. The times are in milliseconds.
 */
export function pageStateOf(indexTime: number | undefined, sourceTimes: readonly number[]): PageState {
  if (indexTime === undefined) return "missing";
  return sourceTimes.some((time) => time > indexTime) ? "stale" : "current";
}

/**
 * This function reads the state of the built local page of a checkout, from the folder of the package `runtime`. A move
 * of the checkout to a new commit writes the changed source files. Thus the page is stale until the next build.
 */
export async function readPageState(root: string): Promise<PageState> {
  const indexTime = await stat(join(pageFolder(root), PAGE_INDEX)).then(
    (stats) => stats.mtimeMs,
    () => undefined,
  );
  if (indexTime === undefined) return "missing";
  const sources = await findFilesAsync({ root: join(root, ".."), include: PAGE_SOURCES });
  const times = await Promise.all(
    sources.map((path) =>
      stat(path).then(
        (stats) => stats.mtimeMs,
        () => 0,
      ),
    ),
  );
  return pageStateOf(indexTime, times);
}

/** The command that builds the local page, from the root of the checkout. */
export const PAGE_BUILD = "pnpm --filter ./packages/site build";

/** This function gives the warning of a page state, or `undefined` for a current page. The warning holds no path. */
export function pageWarning(state: PageState): string | undefined {
  switch (state) {
    case "missing":
      return `The local page is not built, thus the path / gives 404. Build it: ${PAGE_BUILD}`;
    case "stale":
      return `The local page is older than the source files of this checkout. Build it again: ${PAGE_BUILD}`;
    case "current":
      return undefined;
  }
}

/** This function gives the status of the loop, the outage deploy, the start and the reads of the other copies. */
export function statusOf(loop: RuntimeLoop, outage?: { state(): OutageDeployState }, start?: StartStatus, copies?: { watches(): readonly CopyWatch[] }): Status {
  const last = loop.last();
  return {
    at: last?.at ?? null,
    wakeAt: last?.wakeAt ?? null,
    fetched: last?.fetched ?? [],
    sent: last?.delivery?.sent.length ?? 0,
    conflicts: last?.conflicts.length ?? 0,
    stuck: loop.stuck() ?? null,
    ...(outage === undefined ? {} : { outage: outage.state() }),
    ...(start === undefined ? {} : { start }),
    ...(last?.modes === undefined ? {} : { modes: last.modes }),
    ...(copies === undefined ? {} : { copies: copies.watches().map((watch) => ({ copy: watch.copy, readAt: watch.read?.at ?? null, unsteadySince: watch.unsteadySince ?? null, deployUntil: watch.deployUntil ?? null })) }),
  };
}

const s = (value: number) => ({ value, unit: "s" });

/**
 * This function gives the API to the service of the entry: an HTTP server, its controller and its
 * routes. The API is a component. It does not start the server, and it does not use `run()`.
 */
export const attachApi = (svc: ServiceBuilder, options: ApiOptions): ServiceBuilder => {
  // The transport has no defaults: the idle close, the sweep of idle connections and the Retry-After of each 503.
  // Each handler operates in the scope of its request, with the trace of its traceparent header (AL-82). The baggage drops.
  const http = httpTransport(
    createServer(),
    { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) },
    { listen: { port: options.port, host: LOOPBACK }, callContext },
  );
  // Each request of a route goes through the service. Thus the drain waits for it, and the shutdown can cut it.
  http.mount(handle("api", "GET /status", () => statusOf(options.loop, options.outage, options.start, options.copies)));
  // Each route declares if a client can send it again.
  const api = svc.controller("api").route("GET /status", { idempotent: true });
  const map = options.map;
  if (map !== undefined) {
    // The answer has one table of the distinct shapes (AL-214). The page unpacks it.
    http.mount(handle("api", "GET /map", () => packMap(map())));
    api.route("GET /map", { idempotent: true });
  }
  const health = options.health;
  if (health !== undefined) {
    http.mount(handle("api", "GET /health", () => health()));
    api.route("GET /health", { idempotent: true });
  }
  const history = options.history;
  if (history !== undefined) {
    const work = (req: { readonly url?: string | undefined }): HistoryPayload | QueryProblem => {
      const since = sinceOf(req.url);
      return since !== null && typeof since === "object" ? since : history(since);
    };
    http.mount(handle("api", "GET /history", work, { done: (value) => ("problem" in value ? { status: 400 } : {}) }));
    api.route("GET /history", { idempotent: true });
  }
  const interests = options.interests;
  if (interests !== undefined) {
    http.mount(handle("api", "GET /interests", () => interests()));
    api.route("GET /interests", { idempotent: true });
  }
  // The files of the page come after the routes. A path of no file goes to the next handler, thus it gets 404.
  if (options.page !== undefined) http.mount(folderHandler(options.page, { index: PAGE_INDEX }));
  return svc.server("http", http.knobs, http);
};
