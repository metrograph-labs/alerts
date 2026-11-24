/**
 * AL-131: the fake of the feeds in the lab of the capacity models. The script reads the classes `event` and `update` of the
 * workload file. It serves the NWS alerts of the classes on `127.0.0.1` at the port. `src/fake-feeds.ts` tells the
 * answers.
 *
 * The script writes the ready line of `capacity-app.json` when it serves. Then it writes one JSON line of its counts each
 * minute, until the lab stops the process. A workload that the fake cannot read stops the script with the code 1, before
 * the ready line.
 *
 * Usage: node scripts/fake-feeds.ts <port> <workload file>.
 */
import { readFileSync } from "node:fs";
import { createFakeFeeds, readFeedWorkload } from "../src/fake-feeds.ts";
import { fakeReadyLine, startFake } from "../src/fake-server.ts";

const MINUTE = 60_000;
const [portText, file] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65_535 || file === undefined) throw new Error("Give the port and the workload file.");
// The fake gives the event files of GDELT. A start reads them only when its place shares its position with GDELT (AL-160).
const feeds = createFakeFeeds({ streams: readFeedWorkload(JSON.parse(readFileSync(file, "utf8"))), gdelt: {} });
const server = await startFake(feeds.handler, port);
process.stdout.write(`${fakeReadyLine("feeds")}\n`);
const timer = setInterval(() => {
  process.stdout.write(`${JSON.stringify({ ev: "fake-feeds", ...feeds.counts() })}\n`);
}, MINUTE);
const stop = (): void => {
  clearInterval(timer);
  void server.close().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
