# @mark1russell7/alerts-source-nwr

The source adapter of the alert system for NOAA Weather Radio. A receiver of the host hears a transmitter, and a SAME decoder writes the headers that it hears. The source reads the lines of the decoder, so it needs no internet.

## The two entries

| Entry | What it has |
| --- | --- |
| `@mark1russell7/alerts-source-nwr` | The pure source: the feed of the lines, the read of a line, the assembler of the copies, the fetch, the map and the canary check. |
| `@mark1russell7/alerts-source-nwr/receiver` | The process of the receiver and the decoder, the host check, and the pure argument lists and line split. It needs Node.js. |

## What a host needs

- An SDR dongle that `rtl_fm` can tune, for example an RTL-SDR, with an antenna for 162 MHz.
- The program `rtl_fm` of the package `rtl-sdr`.
- The program `multimon-ng`.

Both programs must be on the `PATH`. On Debian or Ubuntu, `sudo apt-get install rtl-sdr multimon-ng` installs them. The function `checkHost` tells which programs the host has. A missing program gives a named result, not an error:

```ts
import { checkHost } from "@mark1russell7/alerts-source-nwr/receiver";

const host = await checkHost();
if (!host.ready) console.log(`The host does not have: ${host.missing.join(", ")}`);
```

## How a host starts the receiver

The receiver starts `rtl_fm -f <hertz> -M fm -s 22050 -E dc -p <ppm> -` and `multimon-ng -t raw -a EAS -v 1 -`. It starts each program with an argument list and no shell, through `spawnProgram` of `@procedures/shell`. A Node stream sends the samples of the tuner to the decoder. Each line of the decoder goes to the feed, and the source reads the feed.

```ts
import { createLineFeed, createNwrSource } from "@mark1russell7/alerts-source-nwr";
import { createReceiver } from "@mark1russell7/alerts-source-nwr/receiver";

const feed = createLineFeed(1000);
const receiver = createReceiver({ feed, tuner: { frequency: 162_550_000, ppm: 0 } });
const source = createNwrSource({ feed, clock: { now: () => Date.now() }, coverage: [] });
receiver.start();
```

- The frequency is one of the 7 channels, from 162.400 to 162.550 MHz. Find the channel of the nearest transmitter on the NOAA Weather Radio station list.
- The coverage is the list of the SAME codes of the counties that the transmitter serves. It is input data of the owner.
- When the tuner stops, the decoder reads the rest of the samples and stops. When the decoder stops, the receiver stops the tuner and the feed.
- After a stop, the receiver starts again after a backoff: 5 seconds, then twice as long each time, to at most 5 minutes. A run of 10 minutes or more starts the backoff again from 5 seconds.
- The option `start` replaces the start of the programs. A test gives a fake process with no real program.

## The tests

The unit tests use fake processes and the test clock of `@mark1russell7/algebra/clock`. They need no dongle and no decoder.

The test helper `src/same-audio.test-helpers.ts` makes the SAME audio of a message as 16-bit mono PCM, with seeded noise. The repository has no WAV file. The CI job `.github/workflows/nwr.yml` makes the audio of a weekly test, decodes it with the real `multimon-ng`, and gives the lines to the source. Then it starts the receiver with the real decoder and a script in the place of `rtl_fm`.

The dongle is not bought yet. The bench test with the real dongle and a real transmitter waits for it (AL-192).
