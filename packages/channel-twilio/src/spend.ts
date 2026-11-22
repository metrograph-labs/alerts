/**
 * The cap of the spend of the Twilio account. The call channel and the text channel take their units from the same gates.
 */

import type { Instant, Level, SendOutcome } from "@mark1russell7/alerts";
import { isQuotaError, type QuotaError, type QuotaGate, type QuotaState } from "polite-crawler/api";

/**
 * The cap of the spend of the account, as two gates of `polite-crawler/api`. The two gates have one store,
 * one key and one quota name, thus they count the same units.
 */
export interface TwilioSpendGates {
  /** The gate of each message below `life-safety`. Its quota keeps the reserve. */
  readonly gate: QuotaGate;
  /** The gate of a `life-safety` message: the same quota with no reserve. Thus only `life-safety` uses the reserve. */
  readonly lifeSafety: QuotaGate;
  /** The units of one send in the quota: for example 4 cents. */
  readonly units: number;
  /**
   * The gate of the own count. It counts each send of the channels, and it gets no read of the provider. Thus its count
   * is the cost of the sends of this copy alone. Without it, the channels keep no own count.
   */
  readonly own?: QuotaGate | undefined;
}

/** The result of a take: a refusal of the gate, or the function that gives the units back. */
export type SpendTake = { readonly ok: false; readonly refusal: Extract<SendOutcome, { readonly ok: false }> } | { readonly ok: true; readonly giveBack: () => void };

/**
 * This function takes the units of one send from the gate of its level, before the send.
 *
 * - A refusal of the gate stops the send. A full cap gives `rate-limited`, and a cap in its reserve gives `reserved`.
 * - A fault of the store of the gate does not stop the send. The send goes with no count.
 * - `giveBack` gives back the units of a send that did not start. With no cap or no count, it does nothing.
 * - The own gate also counts each send, and `giveBack` gives its units back. Its fault or refusal changes no outcome.
 */
export function takeSpend(spend: TwilioSpendGates | undefined, level: Level, at: Instant): SpendTake {
  if (spend === undefined) return { ok: true, giveBack: () => undefined };
  const gate = level === "life-safety" ? spend.lifeSafety : spend.gate;
  let taken: QuotaState | undefined;
  try {
    taken = gate.take(spend.units);
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, refusal: spendRefusal(gate, error, spend, at) };
  }
  const takenAt = taken?.at;
  const { own } = spend;
  const ownAt = own === undefined ? undefined : takeOwn(own, spend.units);
  return {
    ok: true,
    giveBack: () => {
      if (takenAt !== undefined) giveBack(gate, spend.units, takenAt);
      if (own !== undefined && ownAt !== undefined) giveBack(own, spend.units, ownAt);
    },
  };
}

/** This function counts one send in the own gate, and gives the time of its units. A fault or a refusal gives no time. */
function takeOwn(own: QuotaGate, units: number): number | undefined {
  try {
    return own.take(units).at;
  } catch {
    // The own count misses this send. The cap counts it.
    return undefined;
  }
}

/**
 * This function gives the refusal of a gate of the spend. The gate of `life-safety` has no reserve, thus
 * its refusal is a full cap. The other gate refuses a send that only `life-safety` can still make.
 */
function spendRefusal(gate: QuotaGate, error: QuotaError, spend: TwilioSpendGates, at: Instant): Extract<SendOutcome, { readonly ok: false }> {
  const state = gate.state();
  const full = gate === spend.lifeSafety || state.blockedUntil !== undefined || state.used + spend.units > gate.quota.limit;
  return { ok: false, kind: full ? "rate-limited" : "reserved", message: error.message, retryAfter: Math.max(0, error.resetAt - at) };
}

/** This function gives back the units of a send that did not start. A failed write changes no outcome of the send. */
function giveBack(gate: QuotaGate, units: number, at: number): void {
  try {
    gate.giveBack?.(units, at);
  } catch {
    // The count stays high by one send until the end of the window. Thus the cap can stop one send too early, never too late.
  }
}
