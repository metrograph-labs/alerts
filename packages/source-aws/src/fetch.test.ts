import { readFileSync } from "node:fs";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createAwsFetch, eventBodies } from "./fetch.ts";

/** The real feed (`fixtures/README.md`). */
const RSS = readFileSync(new URL("../fixtures/all-20261118.rss", import.meta.url), "utf8");
const FEED = readFeed(RSS);
const ENTRIES: readonly FeedEntry[] = FEED.ok ? FEED.entries : [];
const MODIFIED = "Wed, 18 Nov 2026 05:48:35 GMT";

const clock = { now: () => Date.parse("2026-11-18T06:00:00Z"), sleep: async () => {} };

type Reply = { status: number; headers?: Record<string, string>; body?: string };

/** This function makes a fetch whose transport gives the replies in order, and records the headers of each request. */
function fetchWith(replies: Reply[]) {
  const sent: Record<string, string>[] = [];
  const fetch = createAwsFetch({
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport: async (request) => {
      sent.push({ ...request.headers });
      const reply = replies.shift()!;
      return { status: reply.status, statusText: "", headers: reply.headers ?? {}, body: reply.body ?? "" };
    },
    userAgent: "alerts-tests",
    minIntervalMs: 0,
  });
  return { fetch: () => fetch({ watch: { places: [] } }), sent };
}

const FULL: Reply = { status: 200, headers: { "content-type": "application/rss+xml", etag: '"v1"', "last-modified": MODIFIED }, body: RSS };

describe("eventBodies", () => {
  it("puts the 38 items of the real feed into 2 events, each with its newest update in full", () => {
    expect(FEED).toMatchObject({ ok: true, format: "rss", title: "Amazon Web Services Service Status", problems: [] });
    expect(ENTRIES).toHaveLength(38);
    const events = eventBodies(ENTRIES);
    expect(events.complete).toBe(true);
    const bodies = events.bodies.map((body) => JSON.parse(body) as { key: string; service: string; link: string; latest: Record<string, string>; earlier: Record<string, string>[] });
    expect(bodies.map((body) => [body.key, body.service, body.earlier.length + 1])).toEqual([
      ["multipleservices-me-central-1_1772369485", "multipleservices-me-central-1", 24],
      ["multipleservices-me-south-1_1772430987", "multipleservices-me-south-1", 14],
    ]);
    expect(bodies[0]).toMatchObject({ link: "https://status.aws.amazon.com/", latest: { time: "2026-09-15T10:27:10.000Z", title: "Service disruption: Increased Error Rates" } });
    expect(bodies[0]!.latest["description"]).toMatch(/^We are providing an update/);
    expect(bodies[0]!.earlier.at(-1)).toEqual({ time: "2026-03-01T12:51:25.000Z", title: "Service impact: Increased Error Rates" });
    expect(Object.keys(bodies[0]!.earlier[0]!)).toEqual(["time", "title"]);
  });

  it("gives the same bodies for the items in any order, and one item for two equal guids", () => {
    const shuffled = [...ENTRIES].reverse();
    expect(eventBodies([...shuffled, ENTRIES[0]!]).bodies).toEqual(eventBodies(ENTRIES).bodies);
  });

  it("gives an item with no key of a service its own body, and complete false", () => {
    const events = eventBodies([...ENTRIES.slice(0, 2), { id: "urn:other", title: "T" }]);
    expect(events.complete).toBe(false);
    expect(events.bodies).toHaveLength(3);
    expect(events.bodies[2]).toBe('{"id":"urn:other","title":"T"}');
  });

  it("takes the time of an item from its guid when its pubDate is not a time", () => {
    const body = JSON.parse(eventBodies([{ id: "https://status.aws.amazon.com/#ec2-eu-west-1_1800000000", title: "Service impact: X", updated: "soon" }]).bodies[0]!) as { latest: { time: string } };
    expect(body.latest.time).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("reads a pubDate as an RFC 822 time only, so an ISO 8601 pubDate gives the time of the guid", () => {
    const timeOf = (updated: string): string => (JSON.parse(eventBodies([{ id: "https://status.aws.amazon.com/#ec2-eu-west-1_1800000000", title: "Service impact: X", updated }]).bodies[0]!) as { latest: { time: string } }).latest.time;
    expect(timeOf("Wed, 18 Nov 2026 02:30:00 PST")).toBe("2026-11-18T10:30:00.000Z");
    expect(timeOf("2026-11-18T10:30:00Z")).toBe(new Date(1_800_000_000_000).toISOString());
  });
});

describe("createAwsFetch", () => {
  it("gives one observation for each event, the time of the data and a conditional GET after a full answer", async () => {
    const { fetch, sent } = fetchWith([FULL, { status: 304, headers: { etag: '"v1"' } }]);
    const first = await fetch();
    expect(first).toMatchObject({ ok: true, complete: true, asOf: Date.parse(MODIFIED) });
    const observations = first.ok ? first.observations : [];
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ source: "aws-health", contentType: "application/json", transport: { url: "https://status.aws.amazon.com/rss/all.rss", status: 200 } });
    expect(sent[0]).toMatchObject({ "user-agent": "alerts-tests", accept: "application/rss+xml, application/xml;q=0.9" });
    const again = await fetch();
    expect(sent[1]?.["if-none-match"]).toBe('"v1"');
    expect(again).toMatchObject({ ok: true, complete: true, asOf: Date.parse(MODIFIED) });
    expect(again.ok ? again.observations.map((observation) => [observation.id, observation.transport.status]) : []).toEqual(observations.map((observation) => [observation.id, 304]));
  });

  it("gives a network failure for a cut answer and a server failure for an answer that is not a feed, and sends no condition next", async () => {
    const { fetch, sent } = fetchWith([{ ...FULL, body: RSS.slice(0, 5000) }, { ...FULL, body: "<html><body>Maintenance</body></html>" }, FULL]);
    expect(await fetch()).toEqual({ ok: false, failure: { kind: "network", message: "truncated or malformed body: https://status.aws.amazon.com/rss/all.rss" } });
    expect(await fetch()).toEqual({
      ok: false,
      failure: { kind: "server", message: "the answer is not the RSS feed of the AWS Health Dashboard (the root element is html, not rss or an Atom feed): https://status.aws.amazon.com/rss/all.rss" },
    });
    expect(await fetch()).toMatchObject({ ok: true });
    expect(sent.map((headers) => headers["if-none-match"])).toEqual([undefined, undefined, undefined]);
  });

  it("gives a network failure for a 304 with no earlier full answer", async () => {
    const { fetch } = fetchWith([{ status: 304 }]);
    expect(await fetch()).toEqual({ ok: false, failure: { kind: "network", message: "a 304 answer with no earlier full answer: https://status.aws.amazon.com/rss/all.rss" } });
  });

  it("gives complete false for a feed with an empty item, and no observation for a feed with no item", async () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>';
    const { fetch } = fetchWith([{ status: 200, body: empty.replace("</channel>", "<item></item></channel>") }, { status: 200, body: empty }]);
    expect(await fetch()).toMatchObject({ ok: true, complete: false, observations: [] });
    expect(await fetch()).toEqual({ ok: true, complete: true, observations: [] });
  });
});
