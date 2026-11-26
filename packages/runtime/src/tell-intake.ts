/**
 * This module holds the intake of the messages of the operator in the runtime (AL-92, `tell-message.ts`). A client
 * gives a message to the procedure `alerts.tell` on the loopback address. The message goes into a buffer, and the
 * source `tell` gives it to the pipeline at its next fetch. Thus a message is an event of the log, as each alert is.
 *
 * - The one procedures host of the runtime (`procedures-host.ts`, AL-95) checks the token of each call. The token is in the file `tell.token` of the home.
 * - The listener of the intake is on the loopback address only. The entry `tell` of `config.json` gives its port.
 * - The intake takes `dailyCap` messages in 24 hours or fewer. It keeps the count in memory, thus a restart clears it.
 * - A message with no person, with a person that the configuration does not have, or with a link that a phone cannot open is refused.
 * - A refusal has the code `BAD_REQUEST`, and a message after the cap has the code `TOO_MANY_REQUESTS`.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, createProcedure, HttpTransport, pathToMethod, type AnyProcedure } from "@procedures/client";
import {
  checkWith,
  DEFAULT_TELL_DAILY_CAP,
  observationId,
  reportSchema,
  TELL_KIND,
  type Instant,
  type MapProblem,
  type MapResult,
  type Observation,
  type Recipient,
  type Report,
  type SourceDescriptor,
  type SourceProcedures,
  type TellConfig,
} from "@mark1russell7/alerts";
import * as z from "zod";
import { POSITION_PATH, type PositionIntake } from "./position-intake.ts";
import { siteLink, TELL_LIFE, TELL_SOURCE, tellEventSchema, tellLines, tellPersons, tellStep, type TellDraft, type TellEvent, type TellReport } from "./tell-message.ts";

/** The path of the procedure that takes a message. */
export const TELL_PATH: readonly string[] = Object.freeze(["alerts", "tell"]);

/** The name of the procedure that takes a message. */
export const TELL_KEY = "alerts.tell";

/** The path of the procedure on the listener of the intake. */
export const TELL_BASE_PATH = "/tell";

/** The file of the token of the intake, in the home of the runtime. */
export const TELL_TOKEN_FILE = "tell.token";

/** The fewest characters of the token of the intake. */
export const TELL_TOKEN_LENGTH = 32;

/** The format of the body of an observation of the source `tell`. */
export const TELL_FORMAT = "alerts-tell/1";

/** The time limit of one call of the intake, in milliseconds. */
export const TELL_CALL_LIMIT = 5_000;

/**
 * The source of the messages of the operator. A fetch reads the buffer of the intake, thus a short interval costs no
 * request. The source covers no area: its reports go to the persons of their addresses.
 */
export const TELL_DESCRIPTOR: SourceDescriptor = {
  id: TELL_SOURCE,
  title: "The messages of the operator",
  origins: ["alerts"],
  dependsOn: [],
  uses: ["power"],
  kinds: [TELL_KIND],
  coverage: "global",
  transport: "push",
  interval: 15_000,
  slowAfter: 5_000,
  auth: "key",
};

/** The code of a refused message. */
export type TellRefusalCode = "BAD_REQUEST" | "TOO_MANY_REQUESTS";

/** The error of a refused message. The procedures host gives its code and its message to the client. The message names no person. */
export class TellRefusal extends Error {
  readonly code: TellRefusalCode;

  constructor(code: TellRefusalCode, message: string) {
    super(message);
    this.name = "TellRefusal";
    this.code = code;
  }
}

/** The answer of the intake to a message that it took. It names no person. */
export interface TellReceipt {
  /** The count of the persons of the message. */
  readonly persons: number;
  /** The link of the message: none, the same link, or the phone form of a link of the local site. */
  readonly link: "none" | "same" | "phone";
}

/** The options of `createTellIntake`. */
export interface TellIntakeOptions {
  /** The entry `tell` of the configuration. */
  readonly config: TellConfig;
  /** The persons of the configuration. */
  readonly recipients: readonly Recipient[];
  /** The time of the wall clock. */
  readonly now: () => Instant;
}

/** The intake of the messages of the operator: the buffer of the messages that it took, and the count of the day. */
export interface TellIntake {
  /**
   * This function takes one message. It gives the receipt, or it throws a `TellRefusal`.
   * @throws TellRefusal for a message with a problem, or after the daily cap.
   */
  take(event: TellEvent): TellReceipt;
  /** This function gives the messages that the intake took since the last call, in their order, and clears the buffer. */
  drain(): readonly TellDraft[];
}

/** This function gives an intake with an empty buffer and a count of 0. */
export function createTellIntake(options: TellIntakeOptions): TellIntake {
  const cap = options.config.dailyCap ?? DEFAULT_TELL_DAILY_CAP;
  let buffer: TellDraft[] = [];
  let taken: Instant[] = [];
  let last = Number.NEGATIVE_INFINITY;
  return {
    take(event) {
      const now = options.now();
      taken = taken.filter((at) => at > now - TELL_LIFE);
      if (taken.length >= cap) throw new TellRefusal("TOO_MANY_REQUESTS", `The intake took ${cap} messages in the last 24 hours. It takes no more now.`);
      const persons = tellPersons(event.to, options.recipients);
      if (persons.tag === "err") throw new TellRefusal("BAD_REQUEST", persons.error);
      const link = siteLink(event.url, options.config.site);
      if ("refused" in link) throw new TellRefusal("BAD_REQUEST", link.refused);
      // Each message gets a later time than the message before it. Thus each report of the intake has its own key.
      const received = Math.max(now, last + 1);
      last = received;
      taken.push(now);
      buffer.push({
        class: event.class,
        urgent: event.urgent === true,
        item: event.item,
        ...(event.title === undefined ? {} : { title: event.title }),
        text: event.text,
        ...(link.url === undefined ? {} : { url: link.url }),
        persons: persons.value,
        received,
      });
      return { persons: persons.value.length, link: link.url === undefined ? "none" : link.url === event.url ? "same" : "phone" };
    },
    drain() {
      const drained = buffer;
      buffer = [];
      return drained;
    },
  };
}

/**
 * This function gives the source `tell` of an intake. A fetch folds the messages of the buffer into the open lines.
 * The lines come from `reports`: the reports of the merge state of each copy at the time of the fetch.
 * Each message with a report gives one observation, and its body holds the reports. Thus the map needs no state.
 */
export function tellSource(intake: TellIntake, reports: () => readonly Report[], now: () => Instant): SourceProcedures {
  return {
    describe: () => TELL_DESCRIPTOR,
    fetch: async () => {
      const at = now();
      let lines = tellLines(reports(), at);
      const observations: Observation[] = [];
      for (const draft of intake.drain()) {
        const step = tellStep(lines, draft);
        lines = step.lines;
        if (step.reports.length > 0) observations.push(tellObservation(step.reports, at));
      }
      return { ok: true, observations, complete: true };
    },
    map: ({ observation }) => mapTell(observation),
  };
}

/** This function gives the observation of the reports of one message. */
export function tellObservation(reports: readonly TellReport[], at: Instant): Observation {
  const contentType = "application/json";
  const body = JSON.stringify({ format: TELL_FORMAT, reports });
  return { id: observationId({ source: TELL_SOURCE, contentType, body }), source: TELL_SOURCE, fetched: at, contentType, body, transport: { latency: 0 } };
}

/** This function gives the reports of an observation of the source `tell`. A report that the schema of the core refuses gives a fatal problem. */
export function mapTell(observation: Observation): MapResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "The body is not JSON.", fatal: true }] };
  }
  const body = z.strictObject({ format: z.literal(TELL_FORMAT), reports: z.array(z.unknown()) }).safeParse(parsed);
  if (!body.success) return { reports: [], problems: [{ path: "", message: `The body is not of the format ${TELL_FORMAT}.`, fatal: true }] };
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  body.data.reports.forEach((value, index) => {
    const checked = checkWith(reportSchema, typeof value === "object" && value !== null ? { ...value, observation: observation.id } : value);
    if (checked.tag === "ok") reports.push(checked.value);
    else problems.push({ path: `reports[${index}]`, message: checked.error.join(" "), fatal: true });
  });
  return { reports, problems };
}

/** This function gives the procedures of the intake: `alerts.tell`, and `alerts.position` with the intake of the fixes of the moving places (AL-40). */
export function tellProcedures(intake: TellIntake, position?: PositionIntake): AnyProcedure[] {
  return [
    createProcedure()
      .path([...TELL_PATH])
      .input(tellEventSchema)
      .output(z.unknown())
      .meta({ description: "Takes one message of the operator. The runtime routes it as a private report.", effects: { reads: ["alerts.config"], writes: ["alerts.log"] } })
      .handler(async (input): Promise<unknown> => intake.take(input))
      .build(),
    ...(position === undefined
      ? []
      : [
          createProcedure()
            .path([...POSITION_PATH])
            .input(z.unknown())
            .output(z.unknown())
            .meta({ description: "Takes one message of the phone app of a moving place. A location gives the fix of the place.", effects: { reads: ["alerts.config"], writes: ["alerts.fixes"] } })
            .handler(async (input): Promise<unknown> => position.take(input))
            .build(),
        ]),
  ];
}

/** The options of `tellCall`. */
export interface TellCallOptions {
  /** The port of the intake on the loopback address. */
  readonly port: number;
  /** The token of the intake. */
  readonly token: string;
  /** The fetch of the requests. The default is the global fetch at the time of each call. */
  readonly fetch?: typeof fetch;
}

/** This function gives the call of the procedure `alerts.tell` over HTTP, with the token in the header `Authorization`. */
export function tellCall(options: TellCallOptions): (event: TellEvent, signal?: AbortSignal) => Promise<unknown> {
  const transport = new HttpTransport({
    baseUrl: `http://127.0.0.1:${options.port}${TELL_BASE_PATH}`,
    defaultHeaders: { Authorization: `Bearer ${options.token}` },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const client = new Client(transport);
  const method = pathToMethod(TELL_PATH);
  return (event, signal) => client.call<TellEvent, unknown>(method, event, signal === undefined ? {} : { signal });
}

/** This function reads the token of the intake from the home, or gives undefined when the file is absent. */
export async function readTellToken(home: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(home, TELL_TOKEN_FILE), "utf8")).trim();
    if (token.length < TELL_TOKEN_LENGTH) throw new Error(`The file ${TELL_TOKEN_FILE} has fewer than ${TELL_TOKEN_LENGTH} characters. Remove it, and start the runtime again.`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * This function gives the token of the intake. When the file `tell.token` is absent, it makes the file with a new token.
 * Only the user of the file can read it (mode 0600). The flag `wx` keeps a file that another process made first.
 */
export async function tellToken(home: string): Promise<string> {
  const known = await readTellToken(home);
  if (known !== undefined) return known;
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(join(home, TELL_TOKEN_FILE), `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const made = await readTellToken(home);
    if (made === undefined) throw new Error(`The file ${TELL_TOKEN_FILE} is absent after a write that found it.`);
    return made;
  }
}
