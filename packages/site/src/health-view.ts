/**
 * The panel of the sources of the local page. It tells if each source reads well, and if a quota, a balance or another
 * copy stops a message. The data functions are pure: the page gives the health, the time and the text of a clock time.
 * The draw functions make the elements of the panel from that data.
 */

import { DOWN_STATES, balanceFloorsBelow, kindLabel, type BalanceHealth, type ChannelHealth, type CopyHealth, type HealthPayload, type HealthState, type QuotaHealth, type ReadHealth, type SourceHealthView } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { countOf, listOf } from "@mark1russell7/text/english";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { toneChip, toneSign } from "./draw.ts";
import { HEALTH_LOOKS, STATE_ORDER, type Tone } from "./health-look.ts";
import type { HealthRead } from "./health-read.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The largest number of kinds in the text of the coverage of a source. The text counts the other kinds. */
export const MOST_KINDS = 4;

/** This type is the text of a clock time for a reader at the present. A time of a different day has its day. */
export type Clock = (at: number, present: number) => string;

/**
 * This function gives the text of a length of time, in one unit. The unit is the minute below 1 hour, the hour below
 * 2 days, and then the day. The function rounds down, and a length below 1 minute gives `less than 1 minute`.
 */
export function ageText(length: number): string {
  if (!(length >= MINUTE_MS)) return "less than 1 minute";
  if (length < HOUR_MS) return countOf(Math.floor(length / MINUTE_MS), "minute");
  if (length < 2 * DAY_MS) return countOf(Math.floor(length / HOUR_MS), "hour");
  return countOf(Math.floor(length / DAY_MS), "day");
}

/** One sentence of the panel, with its tone. */
export interface Verdict {
  readonly tone: Tone;
  readonly text: string;
}

/** One source of the panel. */
export interface SourceRow {
  /** The id of the source. The health has no other name of a source. */
  readonly source: string;
  readonly state: HealthState;
  /** This value is true when the source did not carry the reports of a different source in time. */
  readonly late: boolean;
  /** The time since the last good read, as a sentence. */
  readonly read: string;
  /** The clock time of the last good read, or `undefined` with no good read. */
  readonly readAt: string | undefined;
  /** The sentences that tell why the source needs attention. A healthy source that is not late has none. */
  readonly why: readonly string[];
  /** The kinds that the source covers at the watched places, or `undefined` when the health names none. */
  readonly covers: string | undefined;
}

type FailureKind = NonNullable<SourceHealthView["lastFailure"]>["kind"];

const FAILURE_WORDS: Readonly<Record<FailureKind, string>> = {
  network: "a network failure",
  timeout: "a time-out",
  server: "a server failure",
  "rate-limited": "a rate limit",
  auth: "a refused key",
  refused: "a refused request",
};

/** This function tells if a source needs the attention of a person: the source is down, or it is late. */
export function needsAttention(row: Pick<SourceRow, "state" | "late">): boolean {
  return row.late || DOWN_STATES.includes(row.state);
}

/** This function gives the position of a source in the panel. A late source that is up comes after the sources that are down. */
function rank(row: SourceRow): number {
  const index = STATE_ORDER.indexOf(row.state);
  if (index < DOWN_STATES.length) return index;
  return row.late ? DOWN_STATES.length : index + 1;
}

/**
 * This function gives the text of the kinds that a source covers. The kinds are in the sequence of their names.
 * A text has `MOST_KINDS` names at most, and then the count of the other kinds.
 */
export function coversText(kinds: readonly string[]): string | undefined {
  const names = [...new Set(kinds.map(kindLabel))].sort(compareCodeUnits);
  if (names.length === 0) return undefined;
  const more = names.length - MOST_KINDS;
  return `Covers: ${more > 0 ? `${names.slice(0, MOST_KINDS).join(", ")} and ${countOf(more, "more kind")}` : names.join(", ")}`;
}

/**
 * This function gives one row for each source of the health, with the worst state first. The sources of one state
 * are in the sequence of their ids. `at` is the time of the reader, and each age counts back from it.
 *
 * The coverage of the health names only the sources that are up. Thus a source that is down has no text of its kinds.
 */
export function sourceRows(payload: HealthPayload, at: number, clock: Clock): SourceRow[] {
  const rows = payload.sources.map((entry): SourceRow => {
    const late = [...new Set(payload.lateness.filter((one) => one.state === "late" && one.to === entry.source).map((one) => one.from))].sort(compareCodeUnits);
    const why: string[] = [];
    if (entry.state !== "healthy") {
      why.push(entry.reason);
      if (entry.lastFailure !== undefined) why.push(`The last failure was ${FAILURE_WORDS[entry.lastFailure.kind]}, ${ageText(at - entry.lastFailure.at)} ago.`);
    }
    for (const from of late) why.push(`It did not carry the reports of ${from} in time.`);
    return {
      source: entry.source,
      state: entry.state,
      late: late.length > 0,
      read: entry.lastSuccess === undefined ? "No good read yet." : `Last good read ${ageText(at - entry.lastSuccess)} ago.`,
      readAt: entry.lastSuccess === undefined ? undefined : clock(entry.lastSuccess, at),
      why,
      covers: coversText(payload.coverage.filter((one) => one.sources.includes(entry.source)).map((one) => one.kind)),
    };
  });
  return rows.sort((a, b) => rank(a) - rank(b) || compareCodeUnits(a.source, b.source));
}

/** This function gives a count of the sources as the subject of a sentence, for example `2 of 5 sources`. */
function partOf(count: number, total: number): string {
  return `${String(count)} of ${countOf(total, "source")}`;
}

/**
 * This function gives the sentence that sums the sources. A source that needs attention comes first, then a source
 * with no read, then a slow source. `passed` tells if the runtime made a pass.
 */
export function sourcesVerdict(rows: readonly SourceRow[], passed: boolean): Verdict {
  const total = rows.length;
  if (total === 0) return { tone: "quiet", text: "The runtime has no source." };
  const one = total === 1;
  const attention = rows.filter(needsAttention).length;
  if (attention > 0) return { tone: "bad", text: one ? "The source needs attention." : `${partOf(attention, total)} ${attention === 1 ? "needs" : "need"} attention.` };
  const unknown = rows.filter((row) => row.state === "unknown").length;
  if (unknown > 0 && !passed) return { tone: "quiet", text: "The runtime made no pass yet." };
  if (unknown > 0) return { tone: "quiet", text: one ? "The source has no good read yet." : `${partOf(unknown, total)} ${unknown === 1 ? "has" : "have"} no good read yet.` };
  const slow = rows.filter((row) => row.state === "slow").length;
  if (slow > 0) return { tone: "warn", text: one ? "The source reads, but it is slow." : `Each source reads. ${partOf(slow, total)} ${slow === 1 ? "is" : "are"} slow.` };
  return { tone: "good", text: one ? "The source reads well." : `Each of the ${String(total)} sources reads well.` };
}

/** One fact that stops or limits a message: a quota, a balance or a copy with a stage, a failed read or a failed channel. */
export interface DeliveryFact {
  /** The part of the delivery that the fact is about. */
  readonly part: "quota" | "balance" | "copy" | "read" | "channel";
  /** The name of the part: the id of a channel or of a copy, the name of a provider, or the words of a read. */
  readonly name: string;
  readonly tone: Tone;
  /** The word of the worst stage. */
  readonly word: string;
  readonly text: string;
  /** The channels that send no message because of this fact. */
  readonly stopped: readonly string[];
  /** The channels that send only life-safety messages because of this fact. */
  readonly limited: readonly string[];
}

/** The label of each part of the delivery in the panel. */
export const PART_WORDS: Readonly<Record<DeliveryFact["part"], string>> = { quota: "Quota of the channel", balance: "Balance of the provider", copy: "Other copy", read: "Read on a schedule", channel: "Channel" };

const groups = new Intl.NumberFormat("en-US");

/** This function gives the channels as the subject or the object of a sentence, for example `the channels sms and voice`. */
function channelsText(channels: readonly string[]): string {
  return channels.length === 1 ? `the channel ${channels[0] ?? ""}` : `the channels ${listOf(channels)}`;
}

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function quotaFact({ quota, stages }: QuotaHealth, at: number, clock: Clock): DeliveryFact | undefined {
  const base = { part: "quota", name: quota.channel } as const;
  const left = Math.max(0, quota.limit - quota.used);
  const leftText = `${groups.format(left)} of ${groups.format(quota.limit)} ${quota.unit ?? "units"} ${left === 1 ? "is" : "are"} left.`;
  const end = quota.resetAt === undefined ? "" : ` The window ends at ${clock(quota.resetAt, at)}.`;
  if (stages.includes("spent")) {
    const until = quota.blockedUntil === undefined ? "" : ` until ${clock(quota.blockedUntil, at)}`;
    const text = `The provider refuses each message${until}, also a life-safety message.${quota.blockedUntil === undefined ? end : ""}`;
    return { ...base, tone: "bad", word: "Spent", text, stopped: [quota.channel], limited: [] };
  }
  if (stages.includes("reserve")) return { ...base, tone: "warn", word: "Reserve", text: `${leftText} The channel sends only life-safety messages.${end}`, stopped: [], limited: [quota.channel] };
  if (stages.includes("low")) return { ...base, tone: "warn", word: "Low", text: `${leftText}${end}`, stopped: [], limited: [] };
  return undefined;
}

function balanceFact({ balance, stages }: BalanceHealth, at: number): DeliveryFact | undefined {
  const base = { part: "balance", name: balance.title === "" ? balance.provider : balance.title, limited: [] } as const;
  const read = balance.read;
  const money = (value: number): string => `${value.toFixed(2)} ${read?.currency ?? ""}`.trim();
  const unread = !stages.includes("unread") ? "" : read === undefined ? "No read of the balance passed yet. The runtime cannot see a low balance." : `The last read of the balance was ${ageText(at - read.at)} ago. The runtime cannot see a low balance.`;
  const join = (text: string): string => (unread === "" ? text : `${text} ${unread}`);
  if (stages.includes("empty") && read !== undefined) {
    const paid = balance.channels.length === 0 ? "" : ` on ${channelsText(balance.channels)}`;
    return { ...base, tone: "bad", word: "Empty", text: join(`The balance is ${money(read.balance)}. The provider refuses each paid message${paid}.`), stopped: balance.channels };
  }
  // The text gives the lowest floor that the balance is below: the last floor that gave an alert.
  const below = balanceFloorsBelow(balance);
  if (stages.includes("low") && read !== undefined && below.length > 0) {
    return { ...base, tone: "warn", word: "Low", text: join(`The balance is ${money(read.balance)}, and the floor is ${money(Math.min(...below))}.`), stopped: [] };
  }
  return unread === "" ? undefined : { ...base, tone: "warn", word: "Not read", text: unread, stopped: [] };
}

function copyFact({ copy, stages, read }: CopyHealth, at: number): DeliveryFact | undefined {
  const parts: { readonly word: string; readonly text: string }[] = [];
  if (stages.includes("unsteady")) parts.push({ word: "Not steady", text: "The copy starts again and again, and it sends no alert. This copy is the only copy that sends." });
  if (stages.includes("unread")) {
    const last = read === undefined ? "No read of the copy passed yet." : `The last read of the copy was ${ageText(at - read.at)} ago.`;
    parts.push({ word: "Not read", text: `${last} The two copies can both send an alert.` });
  }
  if (stages.includes("config")) parts.push({ word: "Different configuration", text: "The copy has a different configuration. The two copies can route an alert in two ways." });
  if (stages.includes("skew") && read !== undefined) {
    const size = Math.abs(read.skew);
    const length = size < MINUTE_MS ? countOf(Math.round(size / 1000), "second") : ageText(size);
    parts.push({ word: "Clock skew", text: `The clock of the copy is ${length} ${read.skew < 0 ? "behind" : "ahead"}.` });
  }
  const first = parts[0];
  if (first === undefined) return undefined;
  return { part: "copy", name: copy, tone: "warn", word: first.word, text: parts.map((one) => one.text).join(" "), stopped: [], limited: [] };
}

/** A failed read gives a fact. The runtime keeps the last read that passed, and it reads again after its retry time. */
function readFact({ what, at: passed, failed, next }: ReadHealth, at: number, clock: Clock): DeliveryFact | undefined {
  if (!failed) return undefined;
  const last = passed === null ? `No read of the ${what} passed yet.` : `The last read of the ${what} failed. The last read that passed was ${ageText(at - passed)} ago.`;
  const then = next === null ? "" : ` The next read is at ${clock(next, at)}.`;
  return { part: "read", name: what, tone: "warn", word: "Read failed", text: `${last}${then}`, stopped: [], limited: [] };
}

/**
 * A channel with a run of failed calls gives a fact (AL-65). A down channel stops each message on it until a good call: an
 * accepted send or a probe that passes. A run that does not open a line gives a warning.
 */
function channelFact({ channel, run, down }: ChannelHealth, at: number, clock: Clock): DeliveryFact | undefined {
  if (run === undefined) return undefined;
  const calls = `${countOf(run.failures, "call")} failed since ${clock(run.first, at)}. The last failure was at ${clock(run.last, at)}, of the kind ${run.kind}.`;
  if (down) return { part: "channel", name: channel, tone: "bad", word: "Down", text: `${calls} The run opens the line of a down channel.`, stopped: [channel], limited: [] };
  return { part: "channel", name: channel, tone: "warn", word: "Failed calls", text: calls, stopped: [], limited: [] };
}

const PARTS: readonly DeliveryFact["part"][] = ["quota", "balance", "copy", "read", "channel"];

/**
 * This function gives the facts of the health that stop or limit a message. A quota, a balance or a copy with no
 * stage gives no fact, because a person does not need it. A fact that stops a message is first.
 */
export function deliveryFacts(payload: HealthPayload, at: number, clock: Clock): DeliveryFact[] {
  const facts = [...payload.quotas.map((one) => quotaFact(one, at, clock)), ...payload.balances.map((one) => balanceFact(one, at)), ...payload.copies.map((one) => copyFact(one, at)), ...payload.reads.map((one) => readFact(one, at, clock)), ...payload.channels.map((one) => channelFact(one, at, clock))].filter((fact) => fact !== undefined);
  const order = (fact: DeliveryFact): number => (fact.tone === "bad" ? 0 : 1);
  return facts.sort((a, b) => order(a) - order(b) || PARTS.indexOf(a.part) - PARTS.indexOf(b.part) || compareCodeUnits(a.name, b.name));
}

/**
 * This function gives the sentence that tells if a message can go out. The health tells only the quotas and the
 * balances that the runtime watches. Thus the best sentence tells that none of them stops a message.
 */
export function deliveryVerdict(payload: HealthPayload, facts: readonly DeliveryFact[]): Verdict {
  const channels = (pick: (fact: DeliveryFact) => readonly string[]): string[] => [...new Set(facts.flatMap(pick))].sort(compareCodeUnits);
  const stopped = channels((fact) => fact.stopped);
  if (stopped.length > 0) return { tone: "bad", text: `${sentence(channelsText(stopped))} cannot send a message.` };
  if (facts.some((fact) => fact.tone === "bad")) return { tone: "bad", text: "A balance is empty. The provider refuses each paid message." };
  const limited = channels((fact) => fact.limited);
  if (limited.length > 0) return { tone: "warn", text: `${sentence(channelsText(limited))} ${limited.length === 1 ? "sends" : "send"} only life-safety messages.` };
  if (facts.length > 0) return { tone: "warn", text: `No quota and no balance stops a message. ${countOf(facts.length, "fact")} below ${facts.length === 1 ? "needs" : "need"} attention.` };
  if (payload.quotas.length + payload.balances.length === 0) return { tone: "quiet", text: "The runtime watches no quota and no balance." };
  return { tone: "good", text: "No quota and no balance stops a message." };
}

/** The health that the page keeps between two reads. */
export interface KeptHealth {
  /** The last good health, or `undefined` with no good read. */
  readonly payload: HealthPayload | undefined;
  /** The time of the page at the last good read. */
  readonly readAt: number | undefined;
  /** This value is true when the last read gave the health. */
  readonly fresh: boolean;
  /** This value is true when the runtime has no health route. */
  readonly absent: boolean;
  /** The words of the failure of the last read of the health, when that read failed. */
  readonly text: string | undefined;
}

/** The kept health of a page before its first read. */
export const NO_HEALTH: KeptHealth = { payload: undefined, readAt: undefined, fresh: false, absent: false, text: undefined };

/**
 * This function gives the kept health after a read at the time `at` of the page. With no result, the runtime did not
 * answer the read of the map, and the page did not ask for the health.
 *
 * A failed read keeps the last good health, and the panel tells its time. A runtime with no health route drops it.
 */
export function keepHealth(kept: KeptHealth, result: HealthRead | undefined, at: number): KeptHealth {
  if (result === undefined) return { ...kept, fresh: false, text: undefined };
  if (result.ok) return { payload: result.payload, readAt: at, fresh: true, absent: false, text: undefined };
  if (result.absent) return { ...NO_HEALTH, absent: true };
  return { ...kept, fresh: false, absent: false, text: result.text };
}

/** The words and the rows of the panel at one time. */
export interface HealthPanel {
  /** The sentences that sum the panel: the sources, then the way out of a message. */
  readonly verdicts: readonly Verdict[];
  /** The words of the failure of the last read of the health. */
  readonly problem: string | undefined;
  readonly rows: readonly SourceRow[];
  readonly facts: readonly DeliveryFact[];
}

/** The sentence of a panel with no health, because the runtime has no health route. */
export const ABSENT_TEXT = "This runtime gives no health of its sources.";

/** The sentence of a panel with no health, because no read passed. */
export const NONE_TEXT = "The page has no health of the sources yet.";

/**
 * This function gives the panel of a kept health at the time `at` of the page. A fresh health gives one sentence for
 * the sources and one sentence for the way out of a message. Its ages count back from the time of the read.
 *
 * A health from an older read gives one sentence that tells its time, and no sentence of a state. Thus the panel does
 * not tell an old state as the present state. Its rows stay, and their ages count back from `at`.
 */
export function healthPanel(kept: KeptHealth, at: number, clock: Clock): HealthPanel {
  const payload = kept.payload;
  if (payload === undefined) return { verdicts: [{ tone: "quiet", text: kept.absent ? ABSENT_TEXT : NONE_TEXT }], problem: kept.text, rows: [], facts: [] };
  const present = kept.fresh ? payload.now : at;
  const rows = sourceRows(payload, present, clock);
  const facts = deliveryFacts(payload, present, clock);
  if (!kept.fresh) return { verdicts: [{ tone: "warn", text: `The page has no new health. The panel shows the read of ${clock(kept.readAt ?? payload.now, at)}.` }], problem: kept.text, rows, facts };
  return { verdicts: [sourcesVerdict(rows, payload.at !== null), deliveryVerdict(payload, facts)], problem: kept.text, rows, facts };
}

/**
 * This function draws the sentences that sum the panel. Each sentence has the sign of its tone before its text.
 * `tag` is the element of a sentence: a paragraph in the panel, and a span in the link at the top of the page.
 */
export function drawVerdicts(verdicts: readonly Verdict[], tag: "p" | "span"): HTMLElement[] {
  return verdicts.map((one) => h(tag, { class: "verdict", "data-tone": one.tone }, toneSign(one.tone), h("span", {}, one.text)));
}

function drawRow(row: SourceRow): HTMLElement {
  const look = HEALTH_LOOKS[row.state];
  return h(
    "li",
    { class: "source-row", "data-source": row.source, "data-state": row.state },
    h("strong", { class: "source-name" }, row.source),
    h("span", { class: "source-state" }, toneChip(look.tone, look.word), row.late ? toneChip("bad", "Late") : null),
    h("span", { class: "source-read", title: row.readAt }, row.read),
    h("div", { class: "source-more" }, ...row.why.map((text) => h("p", {}, text)), row.covers === undefined ? null : h("p", { class: "covers" }, row.covers)),
  );
}

function drawFact(fact: DeliveryFact): HTMLElement {
  return h(
    "li",
    { class: "source-row", "data-part": fact.part },
    h("strong", { class: "source-name" }, fact.name),
    h("span", { class: "source-state" }, toneChip(fact.tone, fact.word)),
    h("span", { class: "source-read" }, PART_WORDS[fact.part]),
    h("div", { class: "source-more" }, h("p", {}, fact.text)),
  );
}

/**
 * This function draws the rows of the panel: one row for each source, and one row for each fact that stops or limits
 * a message. A panel with no fact has no second list.
 */
export function drawHealth(panel: HealthPanel): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (panel.rows.length > 0) parts.push(h("ul", { class: "source-list", "aria-label": "The health of each source" }, ...panel.rows.map(drawRow)));
  if (panel.facts.length > 0) {
    parts.push(h("h3", { class: "delivery-h" }, "Quotas, balances, copies, reads and channels"));
    parts.push(h("ul", { class: "source-list", "aria-label": "The facts that stop or limit a message" }, ...panel.facts.map(drawFact)));
  }
  return parts;
}
