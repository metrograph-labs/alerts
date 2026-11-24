import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type PersonId, type PlaceId, type PositionFix } from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import { basicPrincipal, createPositionIntake, FIXES_FILE, FIXES_FORMAT, fixesText, fixReads, PositionRefusal, readFixes, writeFixes } from "./position-intake.ts";

const T0 = Date.UTC(2026, 10, 24, 18, 0);
const MOVING = "place-moving" as PlaceId;
const FIXED = "place-fixed" as PlaceId;
// Made-up positions of these tests. Each test looks for their digits in each text.
const LON = -98.551234;
const LAT = 28.301234;

const CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [
    { id: FIXED, label: "Fixed", at: [-97.5, 30.25], codes: [{ system: "state", code: "TX" }], bufferKm: 5 },
    { id: MOVING, label: "Phone", codes: [{ system: "state", code: "TX" }, { system: "iso3166", code: "US" }], bufferKm: 5, moving: { device: "ph", maxAgeMinutes: 30 } },
  ],
  people: [{ watch: { person: "person-1" as PersonId, places: [FIXED, MOVING], rules: [] } }],
  contacts: [],
  policies: [],
};

const location = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ _type: "location", lat: LAT, lon: LON, acc: 50, tst: Math.floor(T0 / 1000), tid: "ph", batt: 80, ...fields });

const refusalOf = (take: () => unknown): PositionRefusal => {
  try {
    take();
  } catch (error) {
    if (error instanceof PositionRefusal) return error;
    throw error;
  }
  throw new Error("The intake took the body.");
};

const holdsNoPosition = (text: string): void => {
  expect(text).not.toContain("98.55");
  expect(text).not.toContain("28.30");
};

describe("the intake of the fixes (AL-40)", () => {
  it("takes a location of OwnTracks as the fix of the moving place of its device, and answers an empty list", () => {
    const intake = createPositionIntake({ config: CONFIG });
    expect(intake.take(location())).toEqual([]);
    expect([...intake.fixes().values()]).toEqual([{ place: MOVING, at: [LON, LAT], accuracyKm: 0.05, observedAt: Math.floor(T0 / 1000) * 1000 }]);
    expect(intake.refusals().size).toBe(0);
  });

  it("ignores each other type of message, and refuses a bad body and an unknown device with a text with no position", () => {
    const intake = createPositionIntake({ config: CONFIG });
    expect(intake.take({ _type: "transition", event: "enter" })).toEqual([]);
    expect(intake.take({ _type: "waypoint", lat: LAT, lon: LON })).toEqual([]);
    expect(intake.fixes().size).toBe(0);
    for (const body of [null, "text", [], { lat: LAT }]) expect(refusalOf(() => intake.take(body)).code).toBe("BAD_REQUEST");
    const bad = refusalOf(() => intake.take(location({ acc: "far" })));
    expect(bad.message).toMatch(/no valid/u);
    const unknown = refusalOf(() => intake.take(location({ tid: "zz" })));
    expect(unknown.message).toBe("No moving place has this device.");
    for (const refusal of [bad, unknown]) holdsNoPosition(refusal.message);
  });

  it("keeps the last good fix after a fix with a big doubt, a bad position or an older time, and records the cause", () => {
    const intake = createPositionIntake({ config: CONFIG });
    intake.take(location());
    const kept = intake.fixes().get(MOVING);
    intake.take(location({ acc: 5_000, tst: Math.floor(T0 / 1000) + 60 }));
    expect(intake.refusals().get(MOVING)).toBe("accuracy");
    intake.take(location({ lat: 95, tst: Math.floor(T0 / 1000) + 60 }));
    expect(intake.refusals().get(MOVING)).toBe("problems");
    intake.take(location({ tst: Math.floor(T0 / 1000) - 60 }));
    expect(intake.refusals().get(MOVING)).toBe("older");
    expect(intake.fixes().get(MOVING)).toBe(kept);
    // A good fix clears the cause.
    intake.take(location({ tst: Math.floor(T0 / 1000) + 120 }));
    expect(intake.fixes().get(MOVING)?.observedAt).toBe(T0 + 120_000);
    expect(intake.refusals().size).toBe(0);
  });

  it("writes the fixes after each kept fix, one write after the other, and gives a failed write to the fault hook", async () => {
    const written: number[] = [];
    const faults: unknown[] = [];
    let fail = false;
    const intake = createPositionIntake({
      config: CONFIG,
      write: async (fixes) => {
        if (fail) throw new Error("disk full");
        written.push(fixes.get(MOVING)?.observedAt ?? 0);
      },
      onFault: (error) => faults.push(error),
    });
    intake.take(location());
    intake.take(location({ tst: Math.floor(T0 / 1000) + 60 }));
    // A refused fix writes nothing.
    intake.take(location({ acc: 5_000, tst: Math.floor(T0 / 1000) + 120 }));
    await intake.flush();
    expect(written).toEqual([T0, T0 + 60_000]);
    fail = true;
    intake.take(location({ tst: Math.floor(T0 / 1000) + 180 }));
    await intake.flush();
    expect(faults).toHaveLength(1);
    // The fix stays in memory after a failed write.
    expect(intake.fixes().get(MOVING)?.observedAt).toBe(T0 + 180_000);
  });

  it("tells the age of the last fix of each moving place, and no position", () => {
    const intake = createPositionIntake({ config: CONFIG });
    expect(fixReads(CONFIG, intake.fixes(), intake.refusals(), T0)).toEqual([{ what: `fixes of the moving place ${MOVING}`, at: null, failed: true, next: null }]);
    intake.take(location());
    expect(fixReads(CONFIG, intake.fixes(), intake.refusals(), T0 + 60_000)).toEqual([{ what: `fixes of the moving place ${MOVING}`, at: T0, failed: false, next: T0 + 30 * 60_000 }]);
    intake.take(location({ acc: 5_000, tst: Math.floor(T0 / 1000) + 60 }));
    const late = fixReads(CONFIG, intake.fixes(), intake.refusals(), T0 + 31 * 60_000);
    expect(late).toEqual([{ what: `fixes of the moving place ${MOVING} (last fix refused: accuracy)`, at: T0, failed: true, next: T0 + 30 * 60_000 }]);
    holdsNoPosition(JSON.stringify(late));
  });
});

describe("the file of the fixes (AL-40)", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });
  const home = async (): Promise<string> => {
    const made = await mkdtemp(join(tmpdir(), "alerts-fixes-"));
    homes.push(made);
    return made;
  };
  const fix: PositionFix = { place: MOVING, at: [LON, LAT], accuracyKm: 0.05, observedAt: T0 };

  it("writes the fixes with the mode 0600 and reads them again at the start", async () => {
    const folder = await home();
    expect((await readFixes(folder, CONFIG)).fixes.size).toBe(0);
    await writeFixes(folder, new Map([[MOVING, fix]]));
    // Only the user of the file can read it. Windows has no such mode bits.
    if (process.platform !== "win32") expect((await stat(join(folder, FIXES_FILE))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(folder, FIXES_FILE), "utf8"))).toEqual({ format: FIXES_FORMAT, fixes: [fix] });
    const read = await readFixes(folder, CONFIG);
    expect(read).toEqual({ fixes: new Map([[MOVING, fix]]) });
    // The intake starts with the fixes of the file.
    expect(createPositionIntake({ config: CONFIG, fixes: read.fixes }).fixes().get(MOVING)).toEqual(fix);
  });

  it("drops the fixes of a place that is not a moving place of the configuration", async () => {
    const folder = await home();
    await writeFile(join(folder, FIXES_FILE), fixesText(new Map([[MOVING, fix], [FIXED, { ...fix, place: FIXED }], ["place-gone" as PlaceId, { ...fix, place: "place-gone" as PlaceId }]])));
    expect([...(await readFixes(folder, CONFIG)).fixes.keys()]).toEqual([MOVING]);
  });

  it("starts with no fix and a problem with no position for a broken file", async () => {
    const folder = await home();
    await writeFile(join(folder, FIXES_FILE), `{"format":"${FIXES_FORMAT}","fixes":[{"place":"${MOVING}","at":[${LON}]}]}`);
    const wrong = await readFixes(folder, CONFIG);
    expect(wrong.fixes.size).toBe(0);
    expect(wrong.problem).toMatch(/not of the format/u);
    holdsNoPosition(wrong.problem ?? "");
    await writeFile(join(folder, FIXES_FILE), `{"at":[${LON},${LAT}]`);
    const broken = await readFixes(folder, CONFIG);
    expect(broken.problem).toMatch(/not JSON/u);
    holdsNoPosition(broken.problem ?? "");
  });
});

describe("the Basic auth of the intake (AL-40)", () => {
  const basic = (pair: string): { headers: Record<string, string> } => ({ headers: { authorization: `Basic ${Buffer.from(pair).toString("base64")}` } });

  it("gives the password of a Basic header as the token, and no change for a Bearer header or no header", () => {
    expect(basicPrincipal(basic("phone:the-token"))).toEqual({ bearer: "the-token" });
    // The password can hold a colon. Only the first colon ends the user.
    expect(basicPrincipal(basic("phone:a:b"))).toEqual({ bearer: "a:b" });
    expect(basicPrincipal(basic("no-colon"))).toEqual({ bearer: "" });
    expect(basicPrincipal({ headers: { authorization: "Bearer the-token" } })).toEqual({});
    expect(basicPrincipal({ headers: {} })).toEqual({});
    expect(basicPrincipal({})).toEqual({});
  });
});
