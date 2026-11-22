/**
 * The webhook channel of the alert system. It sends each message as one signed JSON request to the URL of the address of
 * the person, by the Standard Webhooks spec. The calls come from `@procedures/notify/webhook`. The channel gives the
 * procedures of the channel contract of `@mark1russell7/alerts`: `describe`, `send`, `status` and `cancel`.
 *
 * - The receiver is a program, for example a hub that makes a notice of each message. Thus the channel has no silent
 *   mode, no repeats and no acknowledgment. The body tells the receiver if the message is quiet.
 * - The id of the request is the delivery key of the message. Two copies of the system send one key with one id. Thus a
 *   receiver that drops a repeated id makes one notice of the two requests.
 * - A URL with `http:` is only for the loopback host, because the body is not secret on the network.
 */

import { COPY_ID, WHY_LIMITS, type AddressField, type ChannelDescriptor, type ChannelId, type ChannelProcedures, type Instant, type Message, type SendOutcome } from "@mark1russell7/alerts";
import { parseWebhookSecret, sendWebhook, webhookBody, type WebhookFailure, type WebhookFetch, type WebhookSecret } from "@procedures/notify/webhook";

export type { WebhookFetch, WebhookSecret } from "@procedures/notify/webhook";

/** The id of the channel. */
export const WEBHOOK_CHANNEL = "webhook" as ChannelId;

/** The type of the event of each message, in the body of the request. */
export const WEBHOOK_EVENT = "alert.message";

/** The time limit of one request when the options give none, in milliseconds. */
export const WEBHOOK_SEND_TIMEOUT_MS = 10_000;

/** The most characters of the title and of the body of one message. A receiver with a smaller limit cuts the text. */
export const WEBHOOK_LIMITS = { title: 250, body: 4000 } as const;

/**
 * The form of the URL of a receiver: `https:` to each host, or `http:` to the loopback host only. The pattern has no
 * nested repeats, because the load of the configuration examines each address with it.
 */
export const WEBHOOK_URL: string = String.raw`(https://[^\s/?#]+|http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?)([/?#]\S*)?`;

// The pattern of the URL of a receiver, for one whole text.
const WEBHOOK_URL_EXACT = new RegExp(`^(?:${WEBHOOK_URL})$`, "u");

/** The fields of the address of a receiver on the channel: only its URL. */
export const WEBHOOK_ADDRESS: readonly AddressField[] = [{ name: "url", required: true, pattern: WEBHOOK_URL, form: "an https URL, or an http URL of the loopback host" }];

/** The data of the event of one message: the fields of the message that a receiver needs, and the copy id of the send. */
export type WebhookAlert = {
  readonly key: string;
  readonly person: string;
  readonly level: Message["level"];
  readonly title: string;
  readonly body: string;
  readonly incident: string;
  readonly quiet: boolean;
  readonly url?: string;
  readonly expires?: Instant;
  readonly why?: string;
  readonly copy?: string;
};

/** The options of the webhook channel. */
export interface WebhookChannelOptions {
  /** The secrets that sign each request. Each one adds a signature, thus a receiver can change its secret with no gap. */
  readonly secrets: readonly WebhookSecret[];
  /** The fetch of each request. */
  readonly fetch: WebhookFetch;
  /** The User-Agent of each request. Without it, the request has the User-Agent of the fetch. */
  readonly userAgent?: string | undefined;
  /** The time limit of one request. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
}

/** The secrets of a list, or the problem of the first bad secret. The problem tells the place of the secret in the list, and no value. */
export type WebhookSecretsResult = { readonly ok: true; readonly secrets: readonly WebhookSecret[] } | { readonly ok: false; readonly problem: string };

/**
 * This function reads a list of secrets in the `whsec_` form of Standard Webhooks. A space splits two secrets. An empty
 * list is a problem, because the channel cannot sign with no secret.
 */
export function parseWebhookSecrets(text: string): WebhookSecretsResult {
  const parts = text.split(/\s+/u).filter((part) => part !== "");
  if (parts.length === 0) return { ok: false, problem: "The list has no secret." };
  const secrets: WebhookSecret[] = [];
  for (const [index, part] of parts.entries()) {
    const parsed = parseWebhookSecret(part);
    if (!parsed.ok) return { ok: false, problem: `Secret ${String(index + 1)} of ${String(parts.length)}: ${parsed.problem}` };
    secrets.push(parsed.secret);
  }
  return { ok: true, secrets };
}

/** This function gives the descriptor of the channel. */
export function webhookDescriptor(): ChannelDescriptor {
  return {
    id: WEBHOOK_CHANNEL,
    title: "Webhook",
    // The receiver is in the address of the person. Thus the channel names no provider and no endpoint of its own.
    dependsOn: [],
    uses: ["internet", "dns", "power"],
    breaksThrough: false,
    repeats: false,
    ack: "none",
    maxTitle: WEBHOOK_LIMITS.title,
    maxBody: WEBHOOK_LIMITS.body,
    why: WHY_LIMITS.push,
    address: WEBHOOK_ADDRESS,
  };
}

/** This function gives the data of the event of a message. A field that the message does not have is not in the data. */
export function webhookAlertOf(message: Message, copy?: string): WebhookAlert {
  return {
    key: message.key,
    person: message.person,
    level: message.level,
    title: message.title,
    body: message.body,
    incident: message.incident,
    quiet: message.quiet,
    ...(message.url === undefined ? {} : { url: message.url }),
    ...(message.expires === undefined ? {} : { expires: message.expires }),
    ...(message.why === undefined ? {} : { why: message.why }),
    ...(copy === undefined ? {} : { copy }),
  };
}

/**
 * This function gives the outcome of a failed request. A receiver that refuses the key (401 or 403) gives `auth`. A
 * receiver that asks for no more requests (410) and a redirect give `refused`, because the request does not go again.
 */
export function webhookFailureOf(failure: WebhookFailure): Extract<SendOutcome, { readonly ok: false }> {
  const status = failure.status === undefined ? "" : ` (${String(failure.status)})`;
  const retryAfter = failure.retryAfterMs === undefined ? {} : { retryAfter: failure.retryAfterMs };
  switch (failure.kind) {
    case "network":
      return { ok: false, kind: "network", message: "The request did not reach the receiver." };
    case "timeout":
      return { ok: false, kind: "timeout", message: "The receiver gave no answer in the time limit.", ...retryAfter };
    case "throttled":
      return { ok: false, kind: "rate-limited", message: `The receiver asks for a wait${status}.`, ...retryAfter };
    case "server":
      return { ok: false, kind: "server", message: `The receiver had a fault${status}.`, ...retryAfter };
    case "gone":
      return { ok: false, kind: "refused", message: `The receiver asks for no more requests${status}.` };
    case "redirect":
      return { ok: false, kind: "refused", message: `The receiver gave a redirect${status}. The channel does not follow it.` };
    case "refused":
      return failure.status === 401 || failure.status === 403
        ? { ok: false, kind: "auth", message: `The receiver refused the signature${status}.` }
        : { ok: false, kind: "refused", message: `The receiver refused the request${status}.` };
  }
}

/** One event of Standard Webhooks for a receiver: its URL, its type, its id and its data. */
export interface WebhookEvent {
  /** The URL of the receiver: an https URL, or an http URL of the loopback host. */
  readonly url: string;
  /** The type of the event, for example `alert.message`. */
  readonly type: string;
  /** The id of the event. A send again of the same event has the same id, thus the receiver keeps one of them. */
  readonly id: string;
  /** The data of the event. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * This function sends one event as one signed request, and it does not throw. The webhook channel sends each alert
 * with it. The supervisor sends the events of the runtime with it.
 *
 * - A missing secret gives `auth`. A URL that is not https, and not http to the loopback host, gives `refused`.
 * - An id with a full stop or a space gives `refused`, because the spec does not permit it.
 * - The other failures come from `webhookFailureOf`.
 */
export async function sendWebhookEvent(options: WebhookChannelOptions, event: WebhookEvent): Promise<SendOutcome> {
  const now = options.now ?? Date.now;
  if (options.secrets.length === 0) return { ok: false, kind: "auth", message: "The channel has no secret to sign the request." };
  // The load of the configuration examines each address. This check keeps a plain request off the network.
  if (!WEBHOOK_URL_EXACT.test(event.url)) return { ok: false, kind: "refused", message: "The address has no https URL, and no http URL of the loopback host." };
  const at = now();
  const headers = options.userAgent === undefined ? undefined : { "user-agent": options.userAgent };
  const body = webhookBody(event.type, at, event.data);
  let result: Awaited<ReturnType<typeof sendWebhook>>;
  try {
    result = await sendWebhook(options.fetch, { url: event.url, id: event.id, timestampMs: at, body, headers }, options.secrets, { timeoutMs: options.timeoutMs ?? WEBHOOK_SEND_TIMEOUT_MS, now });
  } catch (error) {
    // The request builder throws only for a bad id.
    return { ok: false, kind: "refused", message: error instanceof Error ? error.message : "The request breaks a rule of the spec." };
  }
  if (!result.ok) return webhookFailureOf(result);
  return { ok: true, receipt: { status: String(result.status) }, accepted: at };
}

/**
 * This function makes the procedures of the webhook channel.
 *
 * - `send` does not throw. It sends one request, and the escalation of the core sends a failed key again.
 * - `send` sends no message after its time `expires`.
 * - `status` gives `accepted`, because a receiver tells nothing after its answer.
 * - `cancel` has nothing to stop, because the channel does not repeat a message.
 */
export function createWebhookChannel(options: WebhookChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const descriptor = webhookDescriptor();

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that the path of a stop cannot have.` };
      if (message.expires !== undefined && message.expires <= now()) return { ok: false, kind: "expired", message: "The message expired before the send." };
      // The id is the delivery key: it has no full stop and no space.
      return sendWebhookEvent(options, { url: address["url"] ?? "", type: WEBHOOK_EVENT, id: message.key, data: webhookAlertOf(message, copy) });
    },

    status: () => Promise.resolve({ state: "accepted", at: now(), reason: "A receiver of a webhook tells no state after its answer." }),

    cancel: () => Promise.resolve(),
  };
}
