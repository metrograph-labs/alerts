import { eventOf, keepEvent, LAST_UPDATE_PATH, nearPlaces, readEventFile, readLastUpdate } from "@mark1russell7/alerts-source-gdelt";
import { describe, expect, it } from "vitest";
import { createFakeGdelt, gdeltEventText, GDELT_ROWS, newestStamp } from "./fake-gdelt.ts";
import type { FakeRequest } from "./fake-server.ts";
import { MEASURE_PLACE } from "./seed-home.ts";

const NOW = Date.UTC(2026, 10, 23, 20, 7, 12);

function request(path: string, host = "data.gdeltproject.org"): FakeRequest {
  return { method: "GET", host, path, query: new URLSearchParams(), search: "", headers: {}, body: "", now: NOW };
}

describe("the fake of GDELT (AL-160)", () => {
  it("gives the newest file in lastupdate.txt, and the reader of the source reads the file with its size and digest", () => {
    const fake = createFakeGdelt({ near: 3 });
    const update = fake.handle(request(LAST_UPDATE_PATH))!;
    expect(update.status).toBe(200);
    const last = readLastUpdate(update.body as string);
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last.stamp).toBe("20261123200000");
    expect(newestStamp(NOW)).toBe(last.stamp);
    const file = fake.handle(request(`/gdeltv2/${last.stamp}.export.CSV.zip`))!;
    expect(file.status).toBe(200);
    const read = readEventFile(file.body as Uint8Array, last.stamp, last);
    expect(typeof read).not.toBe("string");
    expect(fake.files()).toBe(1);
  });

  it("gives lines of the real size, with a real share of kept lines and the near lines at the place", () => {
    const text = gdeltEventText("20261123200000", { near: 3 });
    expect(text.length).toBeGreaterThan(300_000);
    expect(text.length).toBeLessThan(600_000);
    const events = text.trim().split("\n").map(eventOf);
    expect(events.every((event) => event !== undefined)).toBe(true);
    expect(events).toHaveLength(GDELT_ROWS);
    const kept = events.filter((event) => event !== undefined && keepEvent(event));
    expect(kept.length).toBeGreaterThan(GDELT_ROWS * 0.03);
    expect(kept.length).toBeLessThan(GDELT_ROWS * 0.15);
    const near = kept.filter((event) => nearPlaces([MEASURE_PLACE])(event!));
    expect(near.length).toBeGreaterThanOrEqual(3);
    expect(gdeltEventText("20261123200000", { near: 3 })).toBe(text);
  });

  it("gives no file after the newest file, and no answer for another host", () => {
    const fake = createFakeGdelt();
    expect(fake.handle(request("/gdeltv2/20261123201500.export.CSV.zip"))!.status).toBe(404);
    expect(fake.handle(request(LAST_UPDATE_PATH, "api.weather.gov"))).toBeUndefined();
  });
});
