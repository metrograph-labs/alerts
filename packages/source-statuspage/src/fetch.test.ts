import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, SourceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createStatusPageFetch, incidentBody, readIncidentList, readSummary, SUMMARY_PATH, SUMMARY_TIMEOUT_MS } from "./fetch.ts";
import { HISTORY_PATH } from "./history.ts";
import { mapObservation } from "./map.ts";
import type { StatusPage } from "./page.ts";
import { registeredPage } from "./register.ts";

/** The real summaries of two pages, with a part of their components (`fixtures/README.md`). */
const CLOUDFLARE = readFileSync(new URL("../fixtures/cloudflare-20261118.json", import.meta.url), "utf8");
const OPENAI = readFileSync(new URL("../fixtures/openai-20261118.json", import.meta.url), "utf8");
/** The real list of the latest incidents of a page of incident.io, with its 2 latest incidents (`fixtures/README.md`). */
const OPENAI_LIST = readFileSync(new URL("../fixtures/openai-incidents-20261125.json", import.meta.url), "utf8");
const LIST = JSON.parse(OPENAI_LIST) as { page: Record<string, unknown>; incidents: Record<string, unknown>[] };
/** The list with its latest incident open again. The real list has no open incident. */
const OPEN_LIST = JSON.stringify({ ...LIST, incidents: [{ ...LIST.incidents[0], status: "investigating", resolved_at: null }, LIST.incidents[1]] });
const SUMMARY = JSON.parse(CLOUDFLARE) as { incidents: Record<string, unknown>[] } & Record<string, unknown>;
const FETCHED = Date.parse("2026-11-18T04:34:02Z");

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const BASE = "https://status.example.test";
const PAGE: StatusPage = { id: "statuspage-example" as SourceId, title: "Example", base: BASE, origin: "example", domain: "example.test", kind: "infra.saas.outage", dependsOn: ["provider:atlassian-statuspage"] };
const ETAG = 'W/"summary-1"';
const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json; charset=utf-8", ...headers }, body });
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { etag: ETAG }, body: "" };

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], page: StatusPage = PAGE) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = FETCHED;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createStatusPageFetch({ page, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const idsOf = (outcome: FetchOutcome) =>
  observationsOf(outcome)
    .map((observation) => (JSON.parse(observation.body) as Record<string, unknown>)["id"])
    .filter((id) => id !== undefined);
const failureOf = (outcome: FetchOutcome) => (outcome.ok ? undefined : outcome.failure);

describe("readSummary", () => {
  it("lists the head and each incident, with the time of the last change of the page", () => {
    const summary = readSummary(CLOUDFLARE)!;
    expect(summary.complete).toBe(true);
    expect(summary.asOf).toBe(Date.parse("2026-11-18T04:27:02.007Z"));
    expect(JSON.parse(summary.head)).toEqual({
      page: { id: "yh6f0r4529hb", name: "Cloudflare Status", url: "https://www.cloudflarestatus.com", time_zone: "Etc/UTC" },
      status: { indicator: "minor", description: "Partially Degraded Service" },
    });
    expect(summary.incidents.map((body) => JSON.parse(body).id)).toEqual(["k3r9i5tbre4i", "0ocqieaifg7h"]);
    expect(readSummary(OPENAI)?.incidents.map((body) => JSON.parse(body).id)).toEqual(["01M7N9VNR6X5SEC90M1YCDB36D"]);
  });

  it("keeps the head when only the time of the page changes, and leaves out the scheduled maintenances", () => {
    const later = JSON.stringify({ ...SUMMARY, page: { ...(SUMMARY["page"] as object), updated_at: "2026-11-18T05:00:00Z" }, scheduled_maintenances: [] });
    expect(readSummary(later)?.head).toBe(readSummary(CLOUDFLARE)?.head);
    expect(readSummary(CLOUDFLARE)?.incidents.join("")).not.toMatch(/Tokyo|Singapore/);
  });

  it("keeps the fields of each incident in one order, and the id, the name and the group of each component, with no status", () => {
    const first = SUMMARY.incidents[0]!;
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    const components = (first["components"] as Record<string, unknown>[]).map((component) => ({ ...component, status: "major_outage", updated_at: "2026-11-18T05:00:00Z" }));
    expect(incidentBody({ ...reordered, components, newField: "x" })).toBe(incidentBody(first));
    expect(JSON.parse(incidentBody(first)).components).toEqual([
      { id: "4n0gb0kh02gf", name: "Network", group_id: "1km35smx8p41" },
      { id: "jm5mggc2wp95", name: "Cloud Network Interconnect (CNI)", group_id: "1km35smx8p41" },
      { id: "w1br383gmlwj", name: "Paris, France - (CDG)", group_id: "zqxhg7y54vy8" },
    ]);
  });

  it("is not complete when an incident is not valid, and keeps that incident in the list", () => {
    const bad = { ...SUMMARY, incidents: [...SUMMARY.incidents, { id: "x1", name: "No time", status: "investigating" }] };
    const summary = readSummary(JSON.stringify(bad))!;
    expect(summary.complete).toBe(false);
    expect(summary.incidents.map((body) => JSON.parse(body).id)).toEqual(["k3r9i5tbre4i", "0ocqieaifg7h", "x1"]);
  });

  it("gives the whole body as the head of an answer that is not a summary, and undefined for a body that does not parse", () => {
    const partial = JSON.stringify({ page: SUMMARY["page"], status: SUMMARY["status"], components: [] });
    expect(readSummary(partial)).toEqual({ head: partial, incidents: [], complete: false });
    expect(readSummary("[]")).toEqual({ head: "[]", incidents: [], complete: false });
    expect(readSummary(CLOUDFLARE.slice(0, 500))).toBeUndefined();
  });
});

describe("readIncidentList", () => {
  it("keeps no resolved incident, and gives the page with no status as the head", () => {
    const list = readIncidentList(OPENAI_LIST)!;
    expect(list.incidents).toEqual([]);
    expect(list.complete).toBe(true);
    expect(JSON.parse(list.head)).toEqual({ page: { id: "01JMDK9XYNY6RXSED6SDWW50WY", name: "OpenAI", url: "https://status.openai.com/" } });
    expect(list.asOf).toBe(Date.parse(String(LIST.page["updated_at"])));
  });

  it("keeps each incident with no time of resolution and a state with no end, with the fields of the summary", () => {
    const list = readIncidentList(OPEN_LIST)!;
    expect(list.incidents).toEqual([incidentBody({ ...LIST.incidents[0], status: "investigating", resolved_at: null })]);
    expect(list.complete).toBe(true);
  });

  it("gives the whole body as the head of an answer that is not a list, and undefined for a body that does not parse", () => {
    const summary = JSON.stringify({ page: LIST.page, status: { indicator: "none" }, components: [] });
    expect(readIncidentList(summary)).toEqual({ head: summary, incidents: [], complete: false });
    expect(readIncidentList(OPENAI_LIST.slice(0, 200))).toBeUndefined();
  });

  it("tells of the change of 2026-11-25: a summary with no list of incidents is not complete", () => {
    const summary = JSON.stringify({ page: LIST.page, status: { indicator: "none", description: "All Systems Operational" }, components: [] });
    expect(readSummary(summary)?.complete).toBe(false);
  });
});

describe("createStatusPageFetch", () => {
  it("reads the list of the latest incidents for the OpenAI page, and the map finds no problem", async () => {
    const page = registeredPage("statuspage-openai")!;
    expect(page.format).toBe("incident-list");
    const { fetch, sent } = fetchWith([json(OPEN_LIST)], page);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([`https://status.openai.com${HISTORY_PATH}`]);
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(idsOf(outcome)).toEqual([LIST.incidents[0]?.["id"]]);
    expect(observationsOf(outcome)).toHaveLength(2);
    const results = observationsOf(outcome).map((observation) => mapObservation(observation, page));
    expect(results.flatMap((result) => result.problems)).toEqual([]);
    expect(results.flatMap((result) => result.reports).map((report) => report.urgency)).toEqual(["immediate"]);
  });


  it("asks for the summary with a timeout of 30 seconds by default", () => {
    expect(SUMMARY_TIMEOUT_MS).toBe(30_000);
    expect(SUMMARY_PATH).toBe("/api/v2/summary.json");
  });

  it("gives one observation for the head and one for each incident, with the last change of the page as the time of the data", async () => {
    const { fetch, sent } = fetchWith([json(CLOUDFLARE, 200, { etag: ETAG })]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: Date.parse("2026-11-18T04:27:02.007Z") });
    expect(idsOf(outcome)).toEqual(["k3r9i5tbre4i", "0ocqieaifg7h"]);
    expect(observationsOf(outcome)).toHaveLength(3);
    expect(observationsOf(outcome).every((observation) => observation.source === PAGE.id && observation.transport.status === 200)).toBe(true);
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}${SUMMARY_PATH}`]);
    expect(sent[0]?.headers["user-agent"]).toBe("alerts-tests");
  });

  it("sends the ETag of the last full answer, and gives the same observations for a 304", async () => {
    const { fetch, sent } = fetchWith([json(CLOUDFLARE, 200, { etag: ETAG }), NOT_MODIFIED]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, ETAG]);
    expect(observationsOf(second).map((observation) => observation.id)).toEqual(observationsOf(first).map((observation) => observation.id));
    expect(second).toMatchObject({ ok: true, complete: true });
    expect(observationsOf(second)[0]?.transport.status).toBe(304);
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED, json(CLOUDFLARE, 200, { etag: ETAG })]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${BASE}${SUMMARY_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("fails a cut body, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([json(CLOUDFLARE.slice(0, 500), 200, { etag: ETAG }), json(CLOUDFLARE, 200, { etag: ETAG })]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${BASE}${SUMMARY_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("reads a page with no ETag on each fetch", async () => {
    const { fetch, sent } = fetchWith([json(OPENAI)]);
    expect(idsOf(await fetch({ watch: WATCH }))).toEqual(["01M7N9VNR6X5SEC90M1YCDB36D"]);
    expect(idsOf(await fetch({ watch: WATCH }))).toEqual(["01M7N9VNR6X5SEC90M1YCDB36D"]);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("gives the failure of an answer that is not a success", async () => {
    const { fetch } = fetchWith([json("busy", 503)]);
    expect(failureOf(await fetch({ watch: WATCH }))?.kind).toBeTypeOf("string");
  });
});
