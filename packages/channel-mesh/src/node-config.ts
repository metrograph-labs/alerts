/**
 * The settings of the bed node as data. The bed node is a Meshtastic node near the bed, with a siren and a button.
 *
 * - The External Notification module of Meshtastic sets the siren pin high for each text with the bell character. Only
 *   an alarm frame has the bell character (`MESH_BELL`).
 * - A MOSFET on the output pin switches the siren, because a pin cannot give the current of a siren.
 * - The button is the input of the ack.
 * - The settings hold the name of the channel of the mesh and the NAME of the key in the secrets file. They do not hold a key.
 */

import type { Duration } from "@mark1russell7/alerts";
import { isNodeName } from "./protocol.ts";

/** The heartbeat period of the bed node when the settings give none: 2 minutes. */
export const BED_BEAT_MS: Duration = 120_000;

/** The shortest heartbeat period, because each beat uses air time of the mesh. */
export const BED_BEAT_MIN_MS: Duration = 30_000;

/** The longest heartbeat period, because a long period makes a dead node visible late. */
export const BED_BEAT_MAX_MS: Duration = 3_600_000;

/** The highest pin number of the boards of Meshtastic (an ESP32-S3 has 48 pins, an nRF52840 has 48). */
export const BED_PIN_MAX = 48;

/** The most characters of the name of a Meshtastic channel. */
export const MESH_CHANNEL_NAME_MAX = 11;

/** The form of the name of a key in the secrets file: capital letters, digits and `_`, from a capital letter. */
export const SECRET_KEY_NAME: string = "[A-Z][A-Z0-9_]{0,63}";

const SECRET_KEY_EXACT = new RegExp(`^(?:${SECRET_KEY_NAME})$`, "u");
const CHANNEL_NAME_EXACT = /^[A-Za-z0-9_-]{1,11}$/u;

/** The siren of the bed node: the External Notification module on a MOSFET output pin. */
export interface SirenSettings {
  /** The output pin of the MOSFET of the siren. */
  readonly pin: number;
  /** True: the pin is high when the siren sounds. A MOSFET with an N channel on the low side needs true. */
  readonly activeHigh: boolean;
  /** The time of one sound of the siren, in milliseconds (`output_ms`). */
  readonly outputMs: Duration;
  /** The time that the siren sounds again and again with no push of the button, in seconds (`nag_timeout`). */
  readonly nagTimeoutS: number;
}

/** The button of the bed node: the input of the ack. */
export interface ButtonSettings {
  /** The input pin of the button. */
  readonly pin: number;
  /** True: the pin has a pull-up resistor, and a push sets it low. */
  readonly pullUp: boolean;
}

/** The channel of the mesh: its name and the name of its key in the secrets file. */
export interface MeshChannelSettings {
  /** The name of the channel in the mesh, 11 characters at most. */
  readonly name: string;
  /** The name of the key of the channel in the secrets file, for example `MESH_CHANNEL_KEY`. It is not the key. */
  readonly keyName: string;
}

/** The settings of the bed node. */
export interface BedNodeConfig {
  /** The name of the node in the frames, for example `bed-node`. */
  readonly node: string;
  readonly siren: SirenSettings;
  readonly button: ButtonSettings;
  readonly channel: MeshChannelSettings;
  /** The heartbeat period of the node. The default is `BED_BEAT_MS`. */
  readonly beatMs?: Duration | undefined;
}

const isPin = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= BED_PIN_MAX;

/**
 * This function gives the problems of the settings of a bed node. A problem names the field, and not its value. Thus a
 * problem holds no private value.
 *
 * - The node has the form of `MESH_NODE`, and each pin is a whole number from 0 to `BED_PIN_MAX`. The two pins are not the same.
 * - The times of the siren are whole numbers above 0. The heartbeat period is from `BED_BEAT_MIN_MS` to `BED_BEAT_MAX_MS`.
 * - The name of the channel has 1 to 11 letters, digits, `_` or `-`.
 * - The name of the key has the form of `SECRET_KEY_NAME`. A key value of Meshtastic is Base64, thus it does not have this form.
 */
export function nodeConfigProblems(config: BedNodeConfig): string[] {
  const problems: string[] = [];
  if (!isNodeName(config.node)) problems.push("The field node is not small letters, digits and hyphens.");
  if (!isPin(config.siren.pin)) problems.push(`The field siren.pin is not a whole number from 0 to ${String(BED_PIN_MAX)}.`);
  if (!isPin(config.button.pin)) problems.push(`The field button.pin is not a whole number from 0 to ${String(BED_PIN_MAX)}.`);
  if (config.siren.pin === config.button.pin) problems.push("The fields siren.pin and button.pin are the same pin.");
  if (!(Number.isInteger(config.siren.outputMs) && config.siren.outputMs > 0)) problems.push("The field siren.outputMs is not a whole number above 0.");
  if (!(Number.isInteger(config.siren.nagTimeoutS) && config.siren.nagTimeoutS > 0)) problems.push("The field siren.nagTimeoutS is not a whole number above 0.");
  const beat = config.beatMs ?? BED_BEAT_MS;
  if (!(Number.isInteger(beat) && beat >= BED_BEAT_MIN_MS && beat <= BED_BEAT_MAX_MS)) problems.push(`The field beatMs is not a whole number from ${String(BED_BEAT_MIN_MS)} to ${String(BED_BEAT_MAX_MS)}.`);
  if (!CHANNEL_NAME_EXACT.test(config.channel.name)) problems.push(`The field channel.name is not 1 to ${String(MESH_CHANNEL_NAME_MAX)} letters, digits, underscores or hyphens.`);
  if (!SECRET_KEY_EXACT.test(config.channel.keyName)) problems.push("The field channel.keyName is not the name of a key: capital letters, digits and underscores.");
  return problems;
}

/**
 * The fields of the External Notification module of Meshtastic for the siren, by their names in the module settings.
 * A person writes them to the node with the Meshtastic tools.
 */
export interface ExternalNotificationSettings {
  readonly enabled: true;
  readonly output: number;
  readonly active: boolean;
  readonly output_ms: number;
  readonly nag_timeout: number;
  /** True: the module sounds for a text with the bell character. */
  readonly alert_bell: true;
  /** False: the module does not sound for each text, because a beat is a text too. */
  readonly alert_message: false;
  /** False: a MOSFET needs a steady level, not a PWM signal. */
  readonly use_pwm: false;
}

/** This function gives the fields of the External Notification module for the siren of a bed node. */
export function externalNotificationOf(config: BedNodeConfig): ExternalNotificationSettings {
  return {
    enabled: true,
    output: config.siren.pin,
    active: config.siren.activeHigh,
    output_ms: config.siren.outputMs,
    nag_timeout: config.siren.nagTimeoutS,
    alert_bell: true,
    alert_message: false,
    use_pwm: false,
  };
}
