/**
 * The frames of the mesh channel. A frame is one text message of a LoRa mesh (Meshtastic) between the home node and the
 * bed node. Each frame is data with a version, and its text fits one Meshtastic text payload.
 *
 * - `alarm`: the home tells the bed node to sound the siren for an alarm id, until an ack, a stop or `expires`.
 * - `stop`: the home tells the bed node to stop the siren for an alarm id.
 * - `ack`: the bed node tells the home that a person pushed the button for an alarm id.
 * - `beat`: the bed node tells the home that it is alive, one time in each heartbeat period.
 *
 * The text of a frame is fields with one space between two. The first field is `M` and the version, and the second field
 * is the letter of the kind. Each field has a fixed form, thus a frame needs no escape. An alarm frame ends with the
 * bell character, so a node with the setting `alert_bell` sounds only for an alarm.
 */

import { LEVELS, type Instant, type Level } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";

/** The version of the frames of this package. A decode refuses each other version. */
export const MESH_VERSION = 1;

/**
 * The most bytes of the text of one frame, in UTF-8. A Meshtastic text payload holds approximately 230 bytes. The limit
 * keeps a margin for a change of the firmware.
 */
export const MESH_FRAME_BYTES = 200;

/**
 * The form of an alarm id: letters, digits, `_` and `-`, 64 characters at most. The pattern has no nested repeats.
 */
export const MESH_ID: string = "[A-Za-z0-9_-]{1,64}";

/** The form of the name of a node: small letters, digits and hyphens, 32 characters at most. */
export const MESH_NODE: string = "[a-z0-9][a-z0-9-]{0,31}";

/** The bell character at the end of an alarm frame. */
export const MESH_BELL = "\u0007";

/** The largest whole number of a sequence field. */
export const MESH_SEQ_MAX: number = 2 ** 31 - 1;

const ID_EXACT = new RegExp(`^(?:${MESH_ID})$`, "u");
const NODE_EXACT = new RegExp(`^(?:${MESH_NODE})$`, "u");
// A whole number with no sign and no zero at the start, 16 digits at most.
const WHOLE = /^(?:0|[1-9][0-9]{0,15})$/u;
// The latest instant of a JavaScript date, in milliseconds.
const INSTANT_MAX = 8.64e15;

/** The frame that tells the bed node to sound the siren. */
export interface AlarmFrame {
  readonly v: typeof MESH_VERSION;
  readonly kind: "alarm";
  /** The alarm id. The bed node keeps one alarm for each id, thus a frame that comes again does nothing new. */
  readonly id: string;
  readonly level: Level;
  /** The count of the sends of this alarm before this frame, from 0. */
  readonly seq: number;
  /** The time after which the bed node stops the siren by itself. */
  readonly expires?: Instant;
}

/** The frame that tells the bed node to stop the siren of an alarm. */
export interface StopFrame {
  readonly v: typeof MESH_VERSION;
  readonly kind: "stop";
  readonly id: string;
}

/** The frame that tells the home that a person pushed the button for an alarm. */
export interface AckFrame {
  readonly v: typeof MESH_VERSION;
  readonly kind: "ack";
  readonly id: string;
  /** The name of the node of the button. */
  readonly by: string;
  /** The time of the push on the clock of the node. */
  readonly at: Instant;
}

/** The frame that tells the home that a node is alive. */
export interface BeatFrame {
  readonly v: typeof MESH_VERSION;
  readonly kind: "beat";
  readonly node: string;
  /** The count of the beats of the node since its start, from 0. */
  readonly seq: number;
  /** The time of the beat on the clock of the node. */
  readonly at: Instant;
}

/** One frame of the mesh channel. */
export type MeshFrame = AlarmFrame | StopFrame | AckFrame | BeatFrame;

/** The kind of a frame. */
export type MeshFrameKind = MeshFrame["kind"];

/**
 * The kind of a refused text:
 *
 * - `size`: the text has more than `MESH_FRAME_BYTES` bytes.
 * - `form`: the text is not a frame of the mesh channel.
 * - `version`: the frame has a version other than `MESH_VERSION`.
 * - `kind`: the frame has an unknown kind letter.
 * - `field`: a field of the frame is missing, has a bad form, or is one too many.
 */
export type FrameProblemKind = "size" | "form" | "version" | "kind" | "field";

/** The reason that a decode refused a text. The message holds no part of the text. */
export interface FrameProblem {
  readonly kind: FrameProblemKind;
  readonly message: string;
}

const KIND_LETTERS: Readonly<Record<MeshFrameKind, string>> = { alarm: "A", stop: "S", ack: "K", beat: "B" };
const LEVEL_LETTERS: Readonly<Record<Level, string>> = { "life-safety": "L", urgent: "U", notice: "N", digest: "D" };
const LETTER_KINDS = new Map(Object.entries(KIND_LETTERS).map(([kind, letter]) => [letter, kind as MeshFrameKind]));
const LETTER_LEVELS = new Map(LEVELS.map((level) => [LEVEL_LETTERS[level], level]));

/** This function tells if a text is an alarm id. */
export function isAlarmId(text: string): boolean {
  return ID_EXACT.test(text);
}

/** This function tells if a text is the name of a node. */
export function isNodeName(text: string): boolean {
  return NODE_EXACT.test(text);
}

const isSeq = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= MESH_SEQ_MAX;
const isInstant = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= INSTANT_MAX;

/** This function gives the problems of a frame. An empty list tells that `encodeFrame` can write the frame. */
export function frameProblems(frame: MeshFrame): string[] {
  const problems: string[] = [];
  if (frame.v !== MESH_VERSION) problems.push(`The version of the frame is not ${String(MESH_VERSION)}.`);
  if (frame.kind === "beat") {
    if (!isNodeName(frame.node)) problems.push("The node of the beat is not small letters, digits and hyphens.");
  } else if (!isAlarmId(frame.id)) problems.push("The alarm id is not letters, digits, underscores and hyphens.");
  if (frame.kind === "alarm") {
    if (!LEVELS.includes(frame.level)) problems.push("The level of the alarm is not a level of the alert system.");
    if (!isSeq(frame.seq)) problems.push("The sequence of the alarm is not a whole number from 0 to the limit.");
    if (frame.expires !== undefined && !isInstant(frame.expires)) problems.push("The time expires of the alarm is not a whole instant that is 0 or more.");
  }
  if (frame.kind === "ack") {
    if (!isNodeName(frame.by)) problems.push("The node of the ack is not small letters, digits and hyphens.");
    if (!isInstant(frame.at)) problems.push("The time of the ack is not a whole instant that is 0 or more.");
  }
  if (frame.kind === "beat") {
    if (!isSeq(frame.seq)) problems.push("The sequence of the beat is not a whole number from 0 to the limit.");
    if (!isInstant(frame.at)) problems.push("The time of the beat is not a whole instant that is 0 or more.");
  }
  return problems;
}

/** This function gives the count of the UTF-8 bytes of a text. */
export function frameBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * This function gives the text of a frame. The text of each valid frame has `MESH_FRAME_BYTES` bytes or fewer.
 *
 * @throws RangeError when the frame has a problem (`frameProblems`)
 */
export function encodeFrame(frame: MeshFrame): string {
  const problems = frameProblems(frame);
  if (problems.length > 0) throw new RangeError(problems.join(" "));
  const head = `M${String(frame.v)} ${KIND_LETTERS[frame.kind]}`;
  switch (frame.kind) {
    case "alarm":
      return `${head} ${frame.id} ${LEVEL_LETTERS[frame.level]} ${String(frame.seq)} ${frame.expires === undefined ? "-" : String(frame.expires)} ${MESH_BELL}`;
    case "stop":
      return `${head} ${frame.id}`;
    case "ack":
      return `${head} ${frame.id} ${frame.by} ${String(frame.at)}`;
    case "beat":
      return `${head} ${frame.node} ${String(frame.seq)} ${String(frame.at)}`;
  }
}

const problem = (kind: FrameProblemKind, message: string): Result<MeshFrame, FrameProblem> => err({ kind, message });

// A whole number of a field, or undefined for a bad form.
const wholeOf = (text: string | undefined, max: number): number | undefined => {
  if (text === undefined || !WHOLE.test(text)) return undefined;
  const value = Number(text);
  return value <= max ? value : undefined;
};

/**
 * This function reads the text of a frame. It does not throw: each refusal is a `FrameProblem`.
 *
 * - It refuses a text with more than `MESH_FRAME_BYTES` bytes before it reads a field.
 * - It refuses a text that does not start with `M` and a version, an unknown version and an unknown kind.
 * - It refuses a field with a bad form, a missing field, and a field that is one too many.
 * - It takes only the text that `encodeFrame` writes. Thus `encodeFrame` of the frame gives the same text again.
 */
export function decodeFrame(text: string): Result<MeshFrame, FrameProblem> {
  if (typeof text !== "string") return problem("form", "The frame is not a text.");
  if (frameBytes(text) > MESH_FRAME_BYTES) return problem("size", `The frame has more than ${String(MESH_FRAME_BYTES)} bytes.`);
  const fields = text.split(" ");
  const [mark, letter, ...rest] = fields;
  if (mark === undefined || !/^M[0-9]{1,4}$/u.test(mark)) return problem("form", "The text is not a frame of the mesh channel.");
  if (mark !== `M${String(MESH_VERSION)}`) return problem("version", `The frame has a version other than ${String(MESH_VERSION)}.`);
  const kind = letter === undefined ? undefined : LETTER_KINDS.get(letter);
  if (kind === undefined) return problem("kind", "The frame has an unknown kind.");
  const bad = (message: string): Result<MeshFrame, FrameProblem> => problem("field", message);
  switch (kind) {
    case "alarm": {
      if (rest.length !== 5) return bad("An alarm frame has 5 fields after its kind.");
      const [id = "", levelLetter = "", seqText, expiresText, bell] = rest;
      if (!isAlarmId(id)) return bad("The alarm id has a bad form.");
      const level = LETTER_LEVELS.get(levelLetter);
      if (level === undefined) return bad("The level of the alarm has a bad form.");
      const seq = wholeOf(seqText, MESH_SEQ_MAX);
      if (seq === undefined) return bad("The sequence of the alarm has a bad form.");
      const expires = expiresText === "-" ? undefined : wholeOf(expiresText, INSTANT_MAX);
      if (expiresText !== "-" && expires === undefined) return bad("The time expires of the alarm has a bad form.");
      if (bell !== MESH_BELL) return bad("The alarm frame does not end with the bell character.");
      return ok({ v: MESH_VERSION, kind, id, level, seq, ...(expires === undefined ? {} : { expires }) });
    }
    case "stop": {
      if (rest.length !== 1) return bad("A stop frame has 1 field after its kind.");
      const [id = ""] = rest;
      if (!isAlarmId(id)) return bad("The alarm id has a bad form.");
      return ok({ v: MESH_VERSION, kind, id });
    }
    case "ack": {
      if (rest.length !== 3) return bad("An ack frame has 3 fields after its kind.");
      const [id = "", by = "", atText] = rest;
      if (!isAlarmId(id)) return bad("The alarm id has a bad form.");
      if (!isNodeName(by)) return bad("The node of the ack has a bad form.");
      const at = wholeOf(atText, INSTANT_MAX);
      if (at === undefined) return bad("The time of the ack has a bad form.");
      return ok({ v: MESH_VERSION, kind, id, by, at });
    }
    case "beat": {
      if (rest.length !== 3) return bad("A beat frame has 3 fields after its kind.");
      const [node = "", seqText, atText] = rest;
      if (!isNodeName(node)) return bad("The node of the beat has a bad form.");
      const seq = wholeOf(seqText, MESH_SEQ_MAX);
      if (seq === undefined) return bad("The sequence of the beat has a bad form.");
      const at = wholeOf(atText, INSTANT_MAX);
      if (at === undefined) return bad("The time of the beat has a bad form.");
      return ok({ v: MESH_VERSION, kind, node, seq, at });
    }
  }
}
