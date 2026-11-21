import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { wallClock } from "@mark1russell7/algebra/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeHeld } from "./home-lock.ts";
import { openRuntimeLog } from "./log.ts";
import { openMeasuredRuntime, type MeasuredRuntime } from "./measured-start.ts";

const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;
const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

// A public point in McMullen County TX. No request leaves the measure, thus no request holds the point.
const config = (userKey = "PUSHOVER_USER_KEY"): AlertConfig => ({
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [-98.55, 28.3],
      codes: [
        { system: "state", code: "TX" },
        { system: "ugc", code: "TXC311" },
        { system: "same", code: "048311" },
        { system: "iso3166", code: "US" },
      ],
      bufferKm: 5,
    },
  ],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [{ person, channel: pushover, address: { user: { secret: userKey } } }],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
});

let home: string;
const opened: MeasuredRuntime[] = [];
// The global fetch counts each request. A measured start makes none.
const requests = vi.fn((): Promise<Response> => Promise.reject(new TypeError("This test has no network.")));

const open = async (): Promise<MeasuredRuntime> => {
  const measured = await openMeasuredRuntime(home);
  opened.push(measured);
  return measured;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alerts-measured-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config()));
  requests.mockClear();
  vi.stubGlobal("fetch", requests);
});

afterEach(async () => {
  for (const measured of opened.splice(0)) await measured.close();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

// Each test does a full start of the runtime. On a loaded computer a start takes more than the default limit of 5 s.
describe("openMeasuredRuntime", { timeout: 30_000 }, () => {
  it("resolves after the first pass, and no fetch or send leaves the process", async () => {
    const measured = await open();
    expect(measured.first.fetched.length).toBeGreaterThan(0);
    expect(measured.instance.runtime.skipped).toBe(0);
    // A pass after the start also starts the work of the stores. It has no network either.
    await measured.pass();
    await measured.close();
    expect(requests).not.toHaveBeenCalled();
    // The failed fetches of the passes are events of the log, as in a live start.
    const log = openRuntimeLog(join(home, "runtime.sqlite"));
    expect(log.count()).toBeGreaterThan(0);
    log.close();
  });

  it("stops when a runtime holds the home folder, and frees the lock at the close", async () => {
    const measured = await open();
    await expect(openMeasuredRuntime(home)).rejects.toBeInstanceOf(HomeHeld);
    await measured.close();
    // The second start rebuilds its state from the events of the first.
    const again = await open();
    expect(again.instance.runtime.skipped).toBe(0);
  });

  it("reads the instant of the wall clock of the caller", async () => {
    // A seeded log ends at a fixed instant. The measure starts its clock there.
    const start = Date.UTC(2020, 0, 1);
    const measured = await openMeasuredRuntime(home, { wall: wallClock({ start }) });
    opened.push(measured);
    const time = measured.instance.runtime.state().time;
    expect(time).toBeGreaterThanOrEqual(start);
    expect(time).toBeLessThan(start + MINUTE);
  });

  it("refuses private files that do not pass the check, and frees the lock", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify(config("NOT_A_MEASURE_KEY")));
    await expect(openMeasuredRuntime(home)).rejects.toThrow(/do not pass the check/);
    writeFileSync(join(home, "config.json"), JSON.stringify(config()));
    const measured = await open();
    expect(measured.first.fetched.length).toBeGreaterThan(0);
  });
});
