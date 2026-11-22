/**
 * The Twilio voice call channel and the Twilio text channel of the alert system. They give the procedures of the channel
 * contract of `@mark1russell7/alerts`: `describe`, `send`, `status`, `cancel` and `probe`. The package also reads the balance of the
 * account. The requests of the Twilio API come from `@procedures/notify/twilio`.
 */

import { COPY_ID, type ChannelProcedures, type Instant, type SendOutcome } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import {
  callTwilio,
  extractTwilioBalance,
  extractTwilioCall,
  TWILIO_ACCOUNT_SID,
  twilioBalanceRequest,
  twilioCallRequest,
  twilioCallStatusRequest,
  twilioEndCallRequest,
  type TwilioCallRead,
  type TwilioCredentials,
  type TwilioFailure,
  type TwilioFetch,
  type TwilioRequest,
} from "@procedures/notify/twilio";
import { twilioCallServices } from "./carrier.ts";
import { TWILIO_PHONE_PATTERN, twilioCallDescriptor } from "./descriptor.ts";
import { probeTwilioAccount } from "./probe.ts";
import { callFailureOf, callStatusOf, twilioCallOf, type TwilioCallMapOptions } from "./map.ts";
import { takeSpend, type TwilioSpendGates } from "./spend.ts";

export {
  CHANNEL_ID,
  TEXT_CHANNEL_ID,
  TWILIO_CALL_ADDRESS,
  TWILIO_CALL_COST_USD,
  TWILIO_CALL_MAX_IN_FLIGHT,
  TWILIO_PHONE_PATTERN,
  TWILIO_TEXT_ADDRESS,
  TWILIO_TEXT_COST_USD,
  TWILIO_TEXT_LIMIT,
  twilioCallDescriptor,
  twilioTextDescriptor,
} from "./descriptor.ts";
export { CALL_LAST_SENTENCE, CALL_REPEATS, CALL_SAY_LIMIT, callFailureOf, callStatusOf, messageTextOf, spokenTextOf, twilioCallOf } from "./map.ts";
export type { Refusal, TwilioCallMapOptions } from "./map.ts";
export type { TwilioSpendGates } from "./spend.ts";
export * from "./carrier.ts";
export * from "./text.ts";
export * from "./probe.ts";
export * from "./replies.ts";
export * from "./usage.ts";
export type { TwilioCredentials, TwilioFetch } from "@procedures/notify/twilio";

/** The time limit of one request to Twilio. */
export const TWILIO_CALL_TIMEOUT_MS = 10_000;

// The whole number that calls, in the form of a number of a person.
const FROM_NUMBER = new RegExp(`^(?:${TWILIO_PHONE_PATTERN})$`, "u");

/**
 * This function gives the problems of the setup of the channels: the credentials, the number that calls and the number
 * that texts. It makes no request. A problem names the field, and no value.
 */
export function twilioSetupProblems(credentials: TwilioCredentials, from: string, textFrom?: string): string[] {
  const problems: string[] = [];
  try {
    // The builder of each request checks the form of the credentials. This request goes nowhere.
    twilioBalanceRequest(credentials);
  } catch (error) {
    problems.push(errorMessage(error));
  }
  if (!FROM_NUMBER.test(from)) problems.push("The number that calls is not a phone number in E.164 form.");
  if (textFrom !== undefined && !FROM_NUMBER.test(textFrom)) problems.push("The number that texts is not a phone number in E.164 form.");
  return problems;
}

/** The options of the Twilio call channel. */
export interface TwilioCallChannelOptions extends TwilioCallMapOptions {
  /** The credentials of the Twilio account. The private configuration gives them at run time. */
  readonly credentials: TwilioCredentials;
  /** The fetch of each request. */
  readonly fetch: TwilioFetch;
  /** The time limit of one request. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
  /** The cap of the spend. Without it, the channel makes each call. */
  readonly spend?: TwilioSpendGates | undefined;
}

/**
 * This function makes the procedures of the Twilio call channel.
 *
 * - `send` does not throw. A call that Twilio accepted gives the receipt `{ call: <the call SID> }`.
 * - `send` takes the units of the call from the gate of its level before the call. A full cap gives `rate-limited`, and a cap in its reserve gives `reserved`.
 * - A call that Twilio refused, did not authorize or limited gives its units back. A call with no answer keeps them, because it can have started.
 * - `status` does not throw. A receipt that the channel cannot read keeps the state `accepted`.
 * - `cancel` ends the call of a receipt in each state. It is idempotent: Twilio refuses the end of a call that it does not know, and the cancel ends with no error.
 * - `cancel({ copy })` does nothing. A call does not repeat, and Twilio keeps no tag on a call.
 * - `cancel` of a receipt with no valid call SID does nothing.
 * - `cancel` throws for each other failure, thus the caller can try again.
 * - `services` gives the carrier region of the phone of an address (`twilioCallServices`).
 */
export function createTwilioCallChannel(options: TwilioCallChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TWILIO_CALL_TIMEOUT_MS;
  const descriptor = twilioCallDescriptor();
  const spend = options.spend;
  if (spend !== undefined && !(Number.isInteger(spend.units) && spend.units > 0)) throw new Error("The units of one call in the cap of the spend are not a whole count above 0.");

  /** One request. */
  const call = (request: TwilioRequest): Promise<TwilioCallRead | TwilioFailure> => callTwilio(options.fetch, request, extractTwilioCall, { timeoutMs });

  return {
    describe: () => descriptor,

    services: ({ address }) => twilioCallServices(address),

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that the path of a stop cannot have.` };
      const at = now();
      if (!TWILIO_ACCOUNT_SID.test(options.credentials.accountSid)) return { ok: false, kind: "auth", message: "The account SID is not AC and 32 hexadecimal digits." };
      const mapped = twilioCallOf(message, address, at, options);
      if ("refused" in mapped) return { ok: false, kind: mapped.kind ?? "refused", message: mapped.refused };
      let request: TwilioRequest;
      try {
        request = twilioCallRequest(options.credentials, mapped);
      } catch (error) {
        return { ok: false, kind: "refused", message: `The call breaks a rule of the Twilio API: ${errorMessage(error)}` };
      }
      const taken = takeSpend(spend, message.level, at);
      if (!taken.ok) return taken.refusal;
      const result = await call(request);
      // Twilio makes no call for these answers. A network fault, a time-out and a server error can come after the start of a call.
      const notStarted = !result.ok && (result.kind === "auth" || result.kind === "refused" || result.kind === "rate-limited");
      if (notStarted) taken.giveBack();
      if (!result.ok) return callFailureOf(result, [mapped.to, mapped.from]);
      return { ok: true, receipt: { call: result.sid }, accepted: at };
    },

    async status({ receipt }) {
      const at = now();
      const sid = receipt["call"];
      if (sid === undefined) return { state: "accepted", at, reason: "The receipt has no call SID." };
      let request: TwilioRequest;
      try {
        request = twilioCallStatusRequest(options.credentials, sid);
      } catch (error) {
        return { state: "accepted", at, reason: `The receipt is not valid: ${errorMessage(error)}` };
      }
      const result = await call(request);
      if (!result.ok) return { state: "accepted", at, reason: `The call was not read: ${result.errors.join(" ")}` };
      return callStatusOf(result, at);
    },

    async cancel(target) {
      if ("copy" in target) return;
      const sid = target.receipt["call"];
      if (sid === undefined) return;
      let request: TwilioRequest;
      try {
        request = twilioEndCallRequest(options.credentials, sid);
      } catch {
        // A receipt with no valid call SID has no call to end. Another try gives the same error.
        return;
      }
      const result = await call(request);
      if (!result.ok && result.kind !== "refused") throw new Error(`Twilio did not end the call (${result.kind}): ${result.errors.join(" ")}`);
    },

    // The read of the balance sends nothing and costs nothing (AL-65).
    probe: () => probeTwilioAccount({ credentials: options.credentials, fetch: options.fetch, timeoutMs, now }),
  };
}

export * from "./outage.ts";
export * from "./list.ts";
export * from "./deploy.ts";
// The file of the bundles. The module imports no esbuild (AL-112).
export * from "./bundle-file.ts";
export * from "./function.ts";
export * from "./twilio-runtime.ts";

/** The answer of a read of the balance of the account. */
export type TwilioBalanceReading = { readonly ok: true; readonly balance: number; readonly currency: string } | { readonly ok: false; readonly message: string };

/** The options of a read of the balance. */
export interface TwilioBalanceOptions {
  /** The credentials of the Twilio account. */
  readonly credentials: TwilioCredentials;
  /** The fetch of the request. */
  readonly fetch: TwilioFetch;
  /** The time limit of the request. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
}

/**
 * This function reads the balance of the Twilio account, in the currency of the account. It gives each
 * failure as a value. It throws only the reason of `signal`, at its abort.
 */
export async function readTwilioBalance(options: TwilioBalanceOptions, signal?: AbortSignal): Promise<TwilioBalanceReading> {
  let request: TwilioRequest;
  try {
    request = twilioBalanceRequest(options.credentials);
  } catch (error) {
    return { ok: false, message: `The credentials of the account are not valid: ${errorMessage(error)}` };
  }
  const timeoutMs = options.timeoutMs ?? TWILIO_CALL_TIMEOUT_MS;
  const result = await callTwilio(options.fetch, request, extractTwilioBalance, signal === undefined ? { timeoutMs } : { timeoutMs, signal });
  if (!result.ok) return { ok: false, message: `Twilio did not give the balance (${result.kind}): ${result.errors.join(" ")}` };
  return { ok: true, balance: result.balance, currency: result.currency };
}
