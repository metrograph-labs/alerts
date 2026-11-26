/**
 * The fake of the channels in the lab of the capacity models (AL-131). The lab starts it in place of the services of the
 * channels of the runtime. It answers the requests of the Pushover API as Pushover does, and it sends nothing.
 *
 * - A message gets the status 1 and a request id. A message with the priority 2 (emergency) also gets a receipt.
 * - A receipt stays not acknowledged until it expires. Thus the escalation of the runtime does each of its steps.
 * - Each answer of a message has the headers of the monthly limit of the app.
 *
 * The fake counts the messages, the emergency messages, the reads of receipts and the cancels.
 */
import { randomUUID } from "node:crypto";
import { UNKNOWN, type FakeHandler, type FakeReply, type FakeRequest } from "./fake-server.ts";

/** The host of the Pushover API. */
export const PUSHOVER_HOST = "api.pushover.net";
/** The monthly limit of the messages of the app at the fake. */
export const FAKE_PUSHOVER_LIMIT = 10_000;
/** The life of a receipt with no `expire` field, in seconds: the longest life that Pushover accepts. */
const DEFAULT_EXPIRE_S = 10_800;

/** The counts of the fake of the channels. */
export interface FakeChannelsCounts {
  readonly messages: number;
  /** The messages with the priority 2. */
  readonly emergencies: number;
  /** The reads of the state of a receipt. */
  readonly receipts: number;
  readonly cancels: number;
}

/** A fake of the channels. */
export interface FakeChannels {
  readonly handler: FakeHandler;
  readonly counts: () => FakeChannelsCounts;
}

/** One receipt of an emergency message, in seconds since the epoch. */
interface Receipt {
  readonly sentAt: number;
  readonly expiresAt: number;
  /** The tags of the message: the field `tags`, split at each comma. */
  readonly tags: readonly string[];
}

const json = (status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): FakeReply => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

/** This function gives the start of the next month in UTC, in seconds: the reset of the monthly limit. */
function monthEnd(now: number): number {
  const date = new Date(now);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

/** This function gives a new receipt: 30 letters and digits, as a Pushover key. */
const receiptId = (): string => `${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 30);

/** This function makes a fake of the channels. */
export function createFakeChannels(): FakeChannels {
  const receipts = new Map<string, Receipt>();
  let messages = 0;
  let emergencies = 0;
  let reads = 0;
  let cancels = 0;

  const send = (request: FakeRequest): FakeReply => {
    const form = new URLSearchParams(request.body);
    messages += 1;
    const limits = {
      "x-limit-app-limit": String(FAKE_PUSHOVER_LIMIT),
      "x-limit-app-remaining": String(Math.max(0, FAKE_PUSHOVER_LIMIT - messages)),
      "x-limit-app-reset": String(monthEnd(request.now)),
    };
    if (form.get("priority") !== "2") return json(200, { status: 1, request: randomUUID() }, limits);
    emergencies += 1;
    const receipt = receiptId();
    const sentAt = Math.floor(request.now / 1000);
    const expire = Number(form.get("expire"));
    const tags = (form.get("tags") ?? "").split(",").filter((tag) => tag !== "");
    receipts.set(receipt, { sentAt, expiresAt: sentAt + (Number.isFinite(expire) && expire > 0 ? expire : DEFAULT_EXPIRE_S), tags });
    return json(200, { status: 1, request: randomUUID(), receipt }, limits);
  };
  const read = (id: string, now: number): FakeReply => {
    const receipt = receipts.get(id);
    if (receipt === undefined) return json(400, { status: 0, request: randomUUID(), errors: ["receipt not found"] });
    reads += 1;
    return json(200, {
      status: 1,
      request: randomUUID(),
      acknowledged: 0,
      acknowledged_at: 0,
      acknowledged_by: "",
      acknowledged_by_device: "",
      last_delivered_at: receipt.sentAt,
      expired: Math.floor(now / 1000) >= receipt.expiresAt ? 1 : 0,
      expires_at: receipt.expiresAt,
      called_back: 0,
      called_back_at: 0,
    });
  };
  const cancel = (ids: readonly string[]): FakeReply => {
    cancels += 1;
    for (const id of ids) receipts.delete(id);
    return json(200, { status: 1, request: randomUUID(), canceled: ids.length });
  };

  const handler: FakeHandler = (request) => {
    if (request.path === "/robots.txt") return { status: 404, headers: { "content-type": "text/plain" }, body: "No robots.txt." };
    if (request.host !== PUSHOVER_HOST) return UNKNOWN;
    const { method, path } = request;
    if (method === "POST" && path === "/1/messages.json") return send(request);
    if (method === "POST" && path === "/1/users/validate.json") return json(200, { status: 1, request: randomUUID(), devices: [], licenses: [] });
    if (method === "GET" && path === "/1/apps/limits.json") {
      return json(200, { status: 1, request: randomUUID(), limit: FAKE_PUSHOVER_LIMIT, remaining: Math.max(0, FAKE_PUSHOVER_LIMIT - messages), reset: monthEnd(request.now) });
    }
    const byTag = /^\/1\/receipts\/cancel_by_tag\/([^/]+)\.json$/u.exec(path);
    if (method === "POST" && byTag !== null) {
      const tag = decodeURIComponent(byTag[1]!);
      return cancel([...receipts].filter(([, each]) => each.tags.includes(tag)).map(([id]) => id));
    }
    const cancelOne = /^\/1\/receipts\/([A-Za-z0-9]+)\/cancel\.json$/u.exec(path);
    if (method === "POST" && cancelOne !== null) return cancel(receipts.has(cancelOne[1]!) ? [cancelOne[1]!] : []);
    const receipt = /^\/1\/receipts\/([A-Za-z0-9]+)\.json$/u.exec(path);
    if (method === "GET" && receipt !== null) return read(receipt[1]!, request.now);
    return UNKNOWN;
  };
  return { handler, counts: () => ({ messages, emergencies, receipts: reads, cancels }) };
}
