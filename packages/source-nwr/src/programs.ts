/**
 * The argument lists of the two programs of the receiver. `rtl_fm` tunes an SDR dongle to one channel of NOAA Weather
 * Radio and writes the audio as raw samples. `multimon-ng` reads the samples and writes one line for each SAME header.
 * The functions are pure: they start no program.
 */

/** The name of the program of the tuner. */
export const TUNER = "rtl_fm";

/** The name of the program of the decoder. */
export const DECODER = "multimon-ng";

/** The seven channels of NOAA Weather Radio, in hertz. */
export const NWR_FREQUENCIES: readonly number[] = [162_400_000, 162_425_000, 162_450_000, 162_475_000, 162_500_000, 162_525_000, 162_550_000];

/** The sample rate that the demodulator `EAS` of `multimon-ng` reads from raw input, in samples each second. */
export const DECODER_SAMPLE_RATE = 22_050;

/** The options of the tuner. */
export interface TunerOptions {
  /** The frequency of the transmitter, in hertz. It is one of `NWR_FREQUENCIES`. */
  readonly frequency: number;
  /** The frequency error of the dongle, in parts per million. The default is 0. */
  readonly ppm?: number;
  /** The gain of the dongle, in decibels. With no gain, the dongle sets its gain itself. */
  readonly gain?: number;
  /** The index of the dongle when the host has more than one. The default is the first dongle. */
  readonly device?: number;
}

/**
 * This function gives the arguments of `rtl_fm` for one channel. The tuner demodulates FM, removes the DC offset and
 * writes 16-bit mono samples at `DECODER_SAMPLE_RATE` to its standard output. A wrong option throws a `RangeError`.
 */
export function tunerArgs(options: TunerOptions): string[] {
  if (!NWR_FREQUENCIES.includes(options.frequency)) {
    throw new RangeError(`The frequency ${String(options.frequency)} Hz is not a channel of NOAA Weather Radio (162.400 to 162.550 MHz, in steps of 25 kHz).`);
  }
  const ppm = options.ppm ?? 0;
  if (!Number.isInteger(ppm) || Math.abs(ppm) > 1000) throw new RangeError(`The frequency error ${String(ppm)} ppm is not an integer from -1000 to 1000.`);
  const args = ["-f", String(options.frequency), "-M", "fm", "-s", String(DECODER_SAMPLE_RATE), "-E", "dc", "-p", String(ppm)];
  if (options.gain !== undefined) {
    if (!Number.isFinite(options.gain) || options.gain < 0) throw new RangeError(`The gain ${String(options.gain)} is not a number of 0 or more.`);
    args.push("-g", String(options.gain));
  }
  if (options.device !== undefined) {
    if (!Number.isInteger(options.device) || options.device < 0) throw new RangeError(`The device ${String(options.device)} is not an index of 0 or more.`);
    args.push("-d", String(options.device));
  }
  // The last argument `-` sends the samples to the standard output.
  args.push("-");
  return args;
}

/**
 * This function gives the arguments of `multimon-ng`. The decoder reads raw samples from its standard input with the
 * demodulator `EAS` only. The level of detail 1 also writes each copy of a header (`EAS (part):`), so the assembler can vote.
 */
export function decoderArgs(): string[] {
  return ["-t", "raw", "-a", "EAS", "-v", "1", "-"];
}
