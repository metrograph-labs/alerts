import { addressProblems, channelDescriptorSchema, type Level, type Message, type PersonId, type ReportId } from "@mark1russell7/alerts";
import { parseWebhookSecret, verifyWebhook, webhookSecretText, type WebhookFetch, type WebhookSecret } from "@procedures/notify/webhook";
import { describe, expect, it } from "vitest";
import { createWebhookChannel, parseWebhookSecrets, sendWebhookEvent, WEBHOOK_CHANNEL, WEBHOOK_EVENT, webhookAlertOf, webhookDescriptor } from "./index.ts";

// Fake secrets: fixed bytes. No real secret is in this repository.
const secretOf = (fill: number): WebhookSecret => {
  const parsed = parseWebhookSecret(webhookSecretText(new Uint8Array(32).fill(fill)));
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.secret;
};
const SECRET = secretOf(7);
const NEXT = secretOf(9);
const AT = Date.UTC(2026, 10, 22, 19, 0);
const URL_OF = "https://hooks.example.test/alerts";
const ADDRESS = { url: URL_OF };
const AGENT = "alerts-runtime-test";

const message = (level: Level, extra: Partial<Message> = {}): Message => ({
  key: "k".repeat(64),
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

/** One request that the fake receiver got. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: string | undefined;
}

/** A fake receiver: it records each request and gives the next answer, with its headers. */
const receiver = (...answers: Array<{ status: number; headers?: Record<string, string> } | Error>) => {
  const calls: Call[] = [];
  const fetch: WebhookFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ?? "", redirect: init.redirect });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The fake receiver has no more answers.");
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => "", headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null } };
  };
  return { fetch, calls };
};

/** The headers of a request, in the form of an incoming request. */
const incoming = (call: Call) => ({ headers: { get: (name: string) => call.headers[name] ?? null }, body: call.body });

describe("webhookDescriptor", () => {
  it("passes the schema of a descriptor", () => {
    expect(channelDescriptorSchema.safeParse(webhookDescriptor()).success).toBe(true);
    expect(webhookDescriptor().id).toBe(WEBHOOK_CHANNEL);
  });

  it("takes an https URL and an http URL of the loopback host, and refuses a plain URL to another host", () => {
    const descriptor = webhookDescriptor();
    for (const url of [URL_OF, "https://hooks.example.test:8443/in?topic=weather", "http://127.0.0.1:4000/hooks/alerts", "http://localhost/hook", "http://[::1]:9000/"]) {
      expect(addressProblems({ url }, descriptor), url).toEqual([]);
    }
    for (const url of ["http://hooks.example.test/alerts", "http://127.0.0.1.example.test/x", "ftp://hooks.example.test/", "https://", "https://hooks example.test/"]) {
      expect(addressProblems({ url }, descriptor), url).toHaveLength(1);
    }
    expect(addressProblems({}, descriptor)).toHaveLength(1);
  });
});

describe("createWebhookChannel", () => {
  it("sends one signed POST with the event of the message, the delivery key as the id and the User-Agent", async () => {
    const { fetch, calls } = receiver({ status: 204 });
    const channel = createWebhookChannel({ secrets: [SECRET], fetch, userAgent: AGENT, now: () => AT });
    const outcome = await channel.send({ message: message("urgent", { why: "Why: your home", url: "https://example.test/alert" }), address: ADDRESS, copy: "copy-a-1" });
    expect(outcome).toEqual({ ok: true, receipt: { status: "204" }, accepted: AT });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ url: URL_OF, method: "POST", redirect: "manual" });
    expect(call.headers).toMatchObject({ "content-type": "application/json", "user-agent": AGENT, "webhook-id": "k".repeat(64), "webhook-timestamp": String(AT / 1000) });
    expect(await verifyWebhook(incoming(call), [SECRET], AT)).toEqual({ ok: true, id: "k".repeat(64), timestampMs: AT });
    expect(JSON.parse(call.body)).toEqual({
      type: WEBHOOK_EVENT,
      timestamp: new Date(AT).toISOString(),
      data: { key: "k".repeat(64), person: "person-1", level: "urgent", title: "Tornado warning", body: "Take shelter now.", incident: "report-1", quiet: false, url: "https://example.test/alert", why: "Why: your home", copy: "copy-a-1" },
    });
  });

  it("signs with each secret, thus a receiver with the new secret takes the request", async () => {
    const { fetch, calls } = receiver({ status: 200 });
    await createWebhookChannel({ secrets: [SECRET, NEXT], fetch, now: () => AT }).send({ message: message("notice"), address: ADDRESS });
    expect(calls[0]!.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect((await verifyWebhook(incoming(calls[0]!), [NEXT], AT)).ok).toBe(true);
    expect(calls[0]!.headers).not.toHaveProperty("user-agent");
  });

  it("gives the kind of each failure of the receiver", async () => {
    const cases: Array<[{ status: number; headers?: Record<string, string> } | Error, string]> = [
      [{ status: 401 }, "auth"],
      [{ status: 403 }, "auth"],
      [{ status: 400 }, "refused"],
      [{ status: 410 }, "refused"],
      [{ status: 302 }, "refused"],
      [{ status: 429, headers: { "retry-after": "30" } }, "rate-limited"],
      [{ status: 500 }, "server"],
      [new TypeError("fetch failed"), "network"],
    ];
    for (const [answer, kind] of cases) {
      const { fetch } = receiver(answer);
      const outcome = await createWebhookChannel({ secrets: [SECRET], fetch, now: () => AT }).send({ message: message("notice"), address: ADDRESS });
      expect(outcome.ok ? "ok" : outcome.kind, JSON.stringify(answer instanceof Error ? answer.message : answer)).toBe(kind);
    }
    const { fetch } = receiver({ status: 429, headers: { "retry-after": "30" } });
    const outcome = await createWebhookChannel({ secrets: [SECRET], fetch, now: () => AT }).send({ message: message("notice"), address: ADDRESS });
    expect(outcome).toMatchObject({ ok: false, retryAfter: 30_000 });
  });

  it("sends nothing with no secret, to a plain URL of another host, after the message expired or with a bad copy id", async () => {
    const { fetch, calls } = receiver();
    const channel = createWebhookChannel({ secrets: [SECRET], fetch, now: () => AT });
    expect(await createWebhookChannel({ secrets: [], fetch, now: () => AT }).send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "auth" });
    expect(await channel.send({ message: message("notice"), address: { url: "http://hooks.example.test/alerts" } })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("notice"), address: {} })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("notice", { expires: AT }), address: ADDRESS })).toMatchObject({ ok: false, kind: "expired" });
    expect(await channel.send({ message: message("notice"), address: ADDRESS, copy: "a b" })).toMatchObject({ ok: false, kind: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("gives accepted as the status, and has nothing to cancel", async () => {
    const channel = createWebhookChannel({ secrets: [SECRET], fetch: receiver().fetch, now: () => AT });
    expect(await channel.status({ receipt: { status: "200" } })).toMatchObject({ state: "accepted", at: AT });
    await expect(channel.cancel({ receipt: { status: "200" } })).resolves.toBeUndefined();
    await expect(channel.cancel({ copy: "copy-a-1" })).resolves.toBeUndefined();
  });
});

describe("sendWebhookEvent", () => {
  it("sends one signed event of each type with its id and data", async () => {
    const { fetch, calls } = receiver({ status: 204 });
    const event = { url: URL_OF, type: "runtime.restarts", id: "a".repeat(32), data: { copy: "copy-a-1", stops: 3 } };
    expect(await sendWebhookEvent({ secrets: [SECRET], fetch, userAgent: AGENT, now: () => AT }, event)).toEqual({ ok: true, receipt: { status: "204" }, accepted: AT });
    const call = calls[0]!;
    expect(await verifyWebhook(incoming(call), [SECRET], AT)).toEqual({ ok: true, id: "a".repeat(32), timestampMs: AT });
    expect(JSON.parse(call.body)).toEqual({ type: "runtime.restarts", timestamp: new Date(AT).toISOString(), data: { copy: "copy-a-1", stops: 3 } });
  });

  it("sends nothing with no secret, to a plain URL of another host or with a bad id", async () => {
    const { fetch, calls } = receiver();
    const event = { url: URL_OF, type: "runtime.ready", id: "a".repeat(32), data: {} };
    expect(await sendWebhookEvent({ secrets: [], fetch, now: () => AT }, event)).toMatchObject({ ok: false, kind: "auth" });
    expect(await sendWebhookEvent({ secrets: [SECRET], fetch, now: () => AT }, { ...event, url: "http://hooks.example.test/x" })).toMatchObject({ ok: false, kind: "refused" });
    expect(await sendWebhookEvent({ secrets: [SECRET], fetch, now: () => AT }, { ...event, id: "an id" })).toMatchObject({ ok: false, kind: "refused" });
    expect(calls).toHaveLength(0);
  });
});

describe("parseWebhookSecrets", () => {
  it("reads one secret or more, split at spaces, and tells the place of a bad secret with no value", () => {
    const one = webhookSecretText(new Uint8Array(32).fill(7));
    const two = webhookSecretText(new Uint8Array(32).fill(9));
    const both = parseWebhookSecrets(` ${one}  ${two}\n`);
    expect(both.ok && both.secrets.length).toBe(2);
    expect(parseWebhookSecrets("")).toEqual({ ok: false, problem: "The list has no secret." });
    const bad = parseWebhookSecrets(`${one} not-a-secret-value`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problem).toMatch(/^Secret 2 of 2: /u);
      expect(bad.problem).not.toContain("not-a-secret-value");
    }
  });
});

describe("webhookAlertOf", () => {
  it("puts no field that the message does not have", () => {
    expect(Object.keys(webhookAlertOf(message("digest")))).toEqual(["key", "person", "level", "title", "body", "incident", "quiet"]);
  });
});
