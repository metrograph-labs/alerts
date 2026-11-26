/**
 * AL-131: the fake of the channels in the lab of the capacity models. The script answers the requests of the Pushover API
 * on `127.0.0.1` at the port, and it sends nothing. `src/fake-channels.ts` tells the answers.
 *
 * The script writes the ready line of `capacity-app.json` when it serves. Then it writes one JSON line of its counts each
 * minute, until the lab stops the process.
 *
 * Usage: node scripts/fake-channels.ts <port>.
 */
import { createFakeChannels } from "../src/fake-channels.ts";
import { fakeReadyLine, startFake } from "../src/fake-server.ts";

const MINUTE = 60_000;
const [portText] = process.argv.slice(2);
const port = Number(portText);
if (portText === undefined || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Give the port.");
const channels = createFakeChannels();
const server = await startFake(channels.handler, port);
process.stdout.write(`${fakeReadyLine("channels")}\n`);
const timer = setInterval(() => {
  process.stdout.write(`${JSON.stringify({ ev: "fake-channels", ...channels.counts() })}\n`);
}, MINUTE);
const stop = (): void => {
  clearInterval(timer);
  void server.close().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
