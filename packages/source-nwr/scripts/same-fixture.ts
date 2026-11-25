/**
 * This script makes the SAME audio of a weekly test, and examines what the decoder `multimon-ng` hears in it. The CI
 * job of the decoder (`.github/workflows/nwr.yml`) uses it. The dongle is not part of the job.
 *
 * Usage:
 * - `node scripts/same-fixture.ts wav --out <file> --at <instant> [--seed <n>]` writes a WAV file, and writes the header to the standard output.
 * - `node scripts/same-fixture.ts check --lines <file> --at <instant>` examines the lines of the decoder in the file.
 * - `node scripts/same-fixture.ts raw --at <instant> [--seed <n>]` writes the raw samples to the standard output, in the place of `rtl_fm`.
 * - `node scripts/same-fixture.ts receive --at <instant>` starts the receiver with the real decoder, and `raw` in the place of the tuner.
 *
 * The instant is a time in ISO 8601, for example `2026-11-25T17:00:00Z`. A failed check writes an `::error::` line and sets the exit code 1.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { random } from "@mark1russell7/rigor-generators";
import { checkDecodedLines, checkFeed, type DecodeCheck } from "../src/decode-check.test-helpers.ts";
import { createLineFeed } from "../src/feed.ts";
import { spawnProgram } from "@procedures/shell/command";
import { createReceiver, DECODER, TUNER } from "../src/receiver.ts";
import { encodeSameMessage, rawPcm, wavFile, weeklyTestHeader } from "../src/same-audio.test-helpers.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, lines: { type: "string" }, at: { type: "string" }, seed: { type: "string", default: "185" } },
});
const mode = positionals[0];
const at = Date.parse(values.at ?? "");
if (Number.isNaN(at)) throw new Error("The option --at must be an instant in ISO 8601.");
const header = weeklyTestHeader(at);
// The noise is 5 percent of the full scale, from a seeded generator. Thus each run makes the same audio.
const audio = (): Int16Array => encodeSameMessage(header, { noise: { level: 0.05, next: random(Number(values.seed)).next } });

const report = (title: string, check: DecodeCheck): void => {
  const lines = [`### ${title}`, "", `Header: \`${header}\``, "", `Observations: ${check.bodies.map((body) => `\`${body}\``).join(", ") || "none"}`, ""];
  lines.push(check.pass ? "The check passed." : `The check failed: ${check.failures.join(". ")}.`, "");
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary.length > 0) appendFileSync(summary, `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!check.pass) {
    process.stdout.write(`::error title=${title}::${check.failures.join(". ")}\n`);
    process.exitCode = 1;
  }
};

if (mode === "wav") {
  if (values.out === undefined) throw new Error("The mode wav needs the option --out.");
  writeFileSync(values.out, wavFile(audio()));
  process.stdout.write(`${header}\n`);
} else if (mode === "raw") {
  process.stdout.write(rawPcm(audio()));
} else if (mode === "check") {
  if (values.lines === undefined) throw new Error("The mode check needs the option --lines.");
  const lines = readFileSync(values.lines, "utf8").split(/\r?\n/);
  report("The decoder of the WAV file", await checkDecodedLines(lines, { header, now: at + 60_000 }));
} else if (mode === "receive") {
  // The receiver starts this script in the place of the tuner. The decoder is the real multimon-ng.
  const script = fileURLToPath(import.meta.url);
  const feed = createLineFeed(1000);
  const clock = fakeWallClock(at);
  let started = false;
  const ended = new Promise<void>((resolve) => {
    const receiver = createReceiver({
      feed,
      clock,
      tuner: { frequency: 162_550_000 },
      start: (command, args) => {
        const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
        const child = command === TUNER ? spawnProgram(process.execPath, [script, "raw", "--at", values.at ?? "", "--seed", values.seed], { stdio }) : spawnProgram(command, args, { stdio });
        if (command === DECODER) {
          started = true;
          // The event close comes after the last output of the decoder. The fake clock starts no restart.
          child.on("close", () => void receiver.close().then(resolve));
        }
        return child;
      },
      onLog: (log) => process.stdout.write(`${log.program}: ${log.line}\n`),
    });
    receiver.start();
  });
  // The fake clock starts no timer of the receiver. Thus a real timer stops a decoder that does not end at the end of its input.
  let limit: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    limit = setTimeout(() => resolve("late"), 120_000);
  });
  if ((await Promise.race([ended, late])) === "late") {
    process.stdout.write("::error title=The receiver with the decoder::The decoder did not end in 120 s after the start.\n");
    process.exit(1);
  }
  clearTimeout(limit);
  if (!started) throw new Error("The receiver did not start the decoder.");
  const lines = feed.read(0).lines.map((line) => line.text);
  process.stdout.write(`The decoder wrote ${String(lines.length)} lines:\n${lines.join("\n")}\n`);
  report("The receiver with the decoder", await checkFeed(feed, { header, now: at + 60_000 }));
} else {
  throw new Error("The mode is wav, raw, check or receive.");
}
