import {
  extractPushoverCancelled,
  extractPushoverLimits,
  extractPushoverReceipt,
  extractPushoverSent,
  PUSHOVER_KEY,
  type PushoverResponse,
} from "@procedures/notify/pushover";
import { describe, expect, it } from "vitest";
import { createFakeChannels, FAKE_PUSHOVER_LIMIT, type FakeChannels } from "./fake-channels.ts";
import type { FakeReply } from "./fake-server.ts";

const NOW = Date.UTC(2026, 10, 30, 23, 0);

/** This function gives the answer of the fake to one request of the Pushover API, as the extractors read it. */
const ask = (channels: FakeChannels, method: string, path: string, form: Readonly<Record<string, string>> = {}, now = NOW): PushoverResponse => {
  const target = new URL(`https://api.pushover.net/1${path}`);
  const reply: FakeReply = channels.handler({
    method,
    host: target.host,
    path: target.pathname,
    query: target.searchParams,
    search: target.search,
    headers: {},
    body: new URLSearchParams(form).toString(),
    now,
  });
  const headers = reply.headers ?? {};
  return { status: reply.status, text: reply.body as string, headers: { get: (name) => headers[name] ?? null } };
};

describe("createFakeChannels", () => {
  it("accepts a message with the limits of the app, and gives a receipt only to an emergency message", () => {
    const channels = createFakeChannels();
    const sent = extractPushoverSent(ask(channels, "POST", "/messages.json", { token: "t", user: "u", message: "m", priority: "1" }));
    expect(sent).toMatchObject({ ok: true, limits: { limit: FAKE_PUSHOVER_LIMIT, remaining: FAKE_PUSHOVER_LIMIT - 1 } });
    expect(sent.ok && sent.receipt).toBe(undefined);
    // The reset of the monthly limit is the start of the next month in UTC.
    expect(sent.ok && sent.limits?.resetAt).toBe(Date.UTC(2026, 11, 1));
    const emergency = extractPushoverSent(ask(channels, "POST", "/messages.json", { token: "t", user: "u", message: "m", priority: "2", retry: "60", expire: "600", tags: "a,b" }));
    expect(emergency.ok).toBe(true);
    const receipt = emergency.ok ? (emergency.receipt ?? "") : "";
    expect(receipt).toMatch(PUSHOVER_KEY);
    expect(channels.counts()).toEqual({ messages: 2, emergencies: 1, receipts: 0, cancels: 0 });
  });

  it("keeps a receipt not acknowledged until it expires, and cancels it by its id or by a tag", () => {
    const channels = createFakeChannels();
    const send = (tags: string): string => {
      const sent = extractPushoverSent(ask(channels, "POST", "/messages.json", { token: "t", user: "u", message: "m", priority: "2", expire: "600", tags }));
      return sent.ok ? (sent.receipt ?? "") : "";
    };
    const first = send("incident-1");
    const read = extractPushoverReceipt(ask(channels, "GET", `/receipts/${first}.json?token=t`));
    expect(read).toMatchObject({ ok: true, acknowledged: false, expired: false, expiresAt: NOW + 600_000, lastDeliveredAt: NOW });
    expect(extractPushoverReceipt(ask(channels, "GET", `/receipts/${first}.json?token=t`, {}, NOW + 600_000))).toMatchObject({ ok: true, expired: true });
    expect(extractPushoverCancelled(ask(channels, "POST", `/receipts/${first}/cancel.json`, { token: "t" }))).toMatchObject({ ok: true });
    expect(extractPushoverReceipt(ask(channels, "GET", `/receipts/${first}.json?token=t`))).toMatchObject({ ok: false });
    const tagged = send("incident-2,person-1");
    const other = send("incident-3");
    expect(extractPushoverCancelled(ask(channels, "POST", "/receipts/cancel_by_tag/incident-2.json", { token: "t" }))).toMatchObject({ ok: true, cancelled: 1 });
    expect(extractPushoverReceipt(ask(channels, "GET", `/receipts/${tagged}.json?token=t`))).toMatchObject({ ok: false });
    expect(extractPushoverReceipt(ask(channels, "GET", `/receipts/${other}.json?token=t`))).toMatchObject({ ok: true });
    expect(extractPushoverLimits(ask(channels, "GET", "/apps/limits.json?token=t"))).toMatchObject({ ok: true, limits: { limit: FAKE_PUSHOVER_LIMIT, remaining: FAKE_PUSHOVER_LIMIT - 3 } });
  });

  it("gives 503 for a request that the fake does not know", () => {
    const channels = createFakeChannels();
    expect(ask(channels, "GET", "/messages.json").status).toBe(503);
    expect(ask(channels, "DELETE", "/receipts/x.json").status).toBe(503);
    expect(
      channels.handler({ method: "POST", host: "api.example.org", path: "/1/messages.json", query: new URLSearchParams(), search: "", headers: {}, body: "", now: NOW }).status,
    ).toBe(503);
  });
});
