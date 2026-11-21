/**
 * AL-104: the delivery path of the seeded store. The dispatcher of the runtime (`createDispatcher`) writes the events
 * `escalation`, `escalation-end`, `hold`, `delivery`, `attempt`, `cancelled`, `refused` and `settled`, as in a live log.
 *
 * The people, the places and the channels are made-up records:
 *
 * - Each person watches one place. A place has `zones` forecast zones of the codes `ZZZ001` to `ZZZ120`.
 * - The channel `seed-push` repeats each message until a stop, and it has polls. It refuses a send at the chance `refusal`.
 * - The channels `seed-note` and `seed-text` have no acknowledgment. A notice goes to `seed-note`.
 * - Each person has a policy for the levels `notice`, `urgent` and `life-safety`. A digest starts no escalation.
 *
 * The clock of the steps is a fake wall clock. Each call of a channel ends at once, thus no call passes its limit.
 * A copy stays open only after a stop of the runtime in a step, at the chance `crash`. The next start settles it.
 */
import { fakeWallClock, type FakeWallClock } from "@mark1russell7/algebra/clock";
import type { ChannelId, ChannelProcedures, Duration, EscalationPolicy, Instant, PersonId, PlaceId, Recipient, SendLimits, WatchedPlace } from "@mark1russell7/alerts";
import { createDispatcher, type DeliveryOptions, type Dispatcher, type RuntimeEvent, type RuntimeState } from "@mark1russell7/alerts-runtime";
import type { Random } from "@mark1russell7/rigor-generators";
import { SEED_FORECAST_ZONES } from "./seed-files.ts";

/** The delivery path of a mix: the made-up people and the behavior of their channels. */
export interface DeliveryMix {
  /** The count of made-up people. Each person watches one place. */
  readonly people: number;
  /** The count of forecast zones in each place. */
  readonly zones: number;
  /** The chance that the channel `seed-push` refuses one send. */
  readonly refusal: number;
  /**
   * The least time between two steps. A live copy steps at each pass. A step reads each incident of the state, thus the
   * seed steps at most once in this time. The polls of the channels write no event, thus this gap changes few events.
   */
  readonly gap: Duration;
  /** The longest time between two steps. The ends of the incidents and of the escalations come at a step. */
  readonly every: Duration;
  /**
   * The send limit of each person. The holds of the live log came in one burst (AL-72), and the seeded incidents come
   * at a steady rate. A lower limit gives the share of the holds in a steady log.
   */
  readonly limits: SendLimits;
  /**
   * The chance that the runtime stops directly after it writes the `attempt` event of a copy. The step writes no more events, and
   * the next start comes at once. Its first step stops the open copy and writes a `settled` event, as after a live crash.
   */
  readonly crash: number;
}

/** The delivery stage of `seedStore`. */
export interface SeedDelivery {
  /** The time of the next step. */
  readonly due: Instant;
  /** This method makes a new dispatcher with the run id `run`, as a start of the runtime does. Its first step stops the open copies. */
  restart(run: string): void;
  /** This method brings the next step to `at`, or to the end of the gap after the last step. A fetch with new reports starts it. */
  wake(at: Instant): void;
  /** This method moves the clock to `at` and steps the dispatcher. It gives `true` when the runtime stopped in the step. */
  step(at: Instant): Promise<boolean>;
}

/** What the stage reads and writes in `seedStore`. */
export interface SeedDeliveryContext {
  /** The time of the first event of the log. */
  readonly start: Instant;
  /** The run id of the first start. */
  readonly run: string;
  state(): RuntimeState;
  /** This function folds the events and writes them to the log. */
  append(events: readonly RuntimeEvent[]): void;
}

// The ids of the three channels.
const SEED_PUSH = "seed-push" as ChannelId;
const SEED_NOTE = "seed-note" as ChannelId;
const SEED_TEXT = "seed-text" as ChannelId;

const MINUTE = 60_000;

// The policies of the people. A notice goes once to the channel that does not repeat. A life-safety message goes at once
// by push, and the text comes after a wait. The people of an odd number get an urgent message by push, and the others by
// note. Thus the log has the two policies of an urgent message.
const policiesOf = (urgent: ChannelId): readonly EscalationPolicy[] => [
  { level: "life-safety", steps: [{ channel: SEED_PUSH, at: 0 }, { channel: SEED_TEXT, at: 5 * MINUTE }], exhaustedAfter: 20 * MINUTE },
  { level: "urgent", steps: [{ channel: urgent, at: 0 }, { channel: SEED_TEXT, at: 15 * MINUTE }], exhaustedAfter: 30 * MINUTE },
  { level: "notice", steps: [{ channel: SEED_NOTE, at: 0 }], exhaustedAfter: 10 * MINUTE },
];
const POLICIES = [policiesOf(SEED_PUSH), policiesOf(SEED_NOTE)] as const;

// The times of the delivery options, as in the configuration of a live copy.
const TIMES = { pollEvery: MINUTE, retry: 30_000, callLimit: 10_000, flightLimit: 40_000 } as const;

/**
 * This function makes the delivery stage of `seedStore`. The draws of the places and of the refusals come from `r`.
 *
 * @throws Error when a count of `mix` is not an integer of 1 or more, or when a time is not above 0. It also throws when a
 * chance is less than 0, or 1 or more.
 */
export function seedDelivery(mix: DeliveryMix, r: Random, context: SeedDeliveryContext): SeedDelivery {
  for (const [name, count] of [["people", mix.people], ["zones", mix.zones]] as const) {
    if (!(Number.isInteger(count) && count >= 1)) throw new Error(`The delivery mix has ${name} ${String(count)}. It must be an integer of 1 or more.`);
  }
  if (!(mix.gap > 0 && mix.every >= mix.gap)) throw new Error(`The delivery mix has the gap ${String(mix.gap)} ms and the longest step time ${String(mix.every)} ms. The gap must be above 0, and not above the longest time.`);
  for (const [name, chance] of [["refusal", mix.refusal], ["crash", mix.crash]] as const) {
    if (!(chance >= 0 && chance < 1)) throw new Error(`The delivery mix has the chance ${name} ${String(chance)}. It must be 0 or more, and less than 1.`);
  }
  const zones = Math.min(mix.zones, SEED_FORECAST_ZONES);
  const places: WatchedPlace[] = Array.from({ length: mix.people }, (_, index) => ({
    id: `seed-place-${String(index + 1)}` as PlaceId,
    codes: r.sample(Array.from({ length: SEED_FORECAST_ZONES }, (_, zone) => zone + 1), zones).map((zone) => ({ system: "ugc", code: `ZZZ${String(zone).padStart(3, "0")}` })),
    bufferKm: 0,
  }));
  const recipients: Recipient[] = places.map((place, index) => ({
    watch: { person: `seed-person-${String(index + 1)}` as PersonId, places: [place.id], rules: [] },
    policies: POLICIES[index % 2]!,
    addresses: { [SEED_PUSH]: { user: `seed-user-${String(index + 1)}` }, [SEED_NOTE]: { topic: `seed-topic-${String(index + 1)}` }, [SEED_TEXT]: { to: `seed-to-${String(index + 1)}` } },
  }));
  const clock = fakeWallClock(context.start);
  const channels = [seedChannel(SEED_PUSH, "poll", clock, r, mix.refusal), seedChannel(SEED_NOTE, "none", clock, r, 0), seedChannel(SEED_TEXT, "none", clock, r, 0)];
  const options: DeliveryOptions = { recipients, channels, sendLimits: mix.limits, ...TIMES };
  // The JSON of each event of the delivery path. The log keeps the first event of an id, thus the stage writes an id once.
  const written = new Map<string, string>();
  // The runtime stopped in this step: the stage writes no more events of the step.
  let stopped = false;
  const append = (events: readonly RuntimeEvent[]): readonly string[] => {
    const fresh: RuntimeEvent[] = [];
    const conflicts: string[] = [];
    for (const event of events) {
      if (stopped) break;
      if (event.type === "attempt" && mix.crash > 0 && r.chance(mix.crash)) stopped = true;
      const json = JSON.stringify(event);
      const before = written.get(event.id);
      if (before === undefined) {
        written.set(event.id, json);
        fresh.push(event);
      } else if (before !== json) {
        conflicts.push(event.id);
      }
    }
    context.append(fresh);
    return conflicts;
  };
  const dispatcherOf = (run: string): Dispatcher => createDispatcher(options, { clock, run, places, state: () => context.state(), append });
  let dispatcher = dispatcherOf(context.run);
  let last = Number.NEGATIVE_INFINITY;
  let due = context.start + mix.every;
  return {
    get due() {
      return due;
    },
    restart(run) {
      dispatcher = dispatcherOf(run);
    },
    wake(at) {
      due = Math.min(due, Math.max(at, last + mix.gap));
    },
    async step(at) {
      if (at > clock.now()) await clock.advance(at - clock.now());
      stopped = false;
      const result = await dispatcher.step(at);
      if (result.conflicts.length > 0) throw new Error(`The seeded delivery wrote an event that is different from the event of the log with the same id: ${result.conflicts[0] ?? ""}.`);
      last = at;
      due = Math.max(at + mix.gap, Math.min(result.wakeAt ?? Number.POSITIVE_INFINITY, at + mix.every));
      return stopped;
    },
  };
}

// A made-up channel. Each call ends at once. A send of the push channel is refused at the chance `refusal`.
function seedChannel(id: ChannelId, ack: "poll" | "none", clock: FakeWallClock, r: Random, refusal: number): ChannelProcedures {
  let sends = 0;
  return {
    describe: () => ({ id, title: `Seed ${id}`, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 }),
    send: async () => {
      sends += 1;
      if (refusal > 0 && r.chance(refusal)) return { ok: false, kind: "rate-limited", message: "The seed channel refused the send." };
      return { ok: true, receipt: { receipt: `${id}-${String(sends)}` }, accepted: clock.now() };
    },
    status: async () => ({ state: "delivered", at: clock.now() }),
    cancel: async () => {},
  };
}
