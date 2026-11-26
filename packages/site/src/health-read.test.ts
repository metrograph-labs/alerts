import { healthPayloadSchema } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { HEALTH_PATH, OTHER_HEALTH_TEXT, readHealth } from "./health-read.ts";
import { FIRST_FIXTURE, HEALTH_FIXTURE, HEALTHY_FIXTURE } from "./health-view.fixture.ts";

const answer = (body: string, status = 200) => async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } });
const SOURCE = "The panel of the sources reads the health from the alert runtime on this computer.";
const fail = (text: string): unknown => ({ ok: false, absent: false, text: `${SOURCE} ${text}` });

describe("the read of the health", () => {
  it("reads only the path /health, with no host", async () => {
    const asked: string[] = [];
    const get = async (path: string): Promise<Response> => {
      asked.push(path);
      return answer(JSON.stringify(HEALTH_FIXTURE))();
    };
    expect(await readHealth(get)).toEqual({ ok: true, payload: HEALTH_FIXTURE });
    expect(HEALTH_PATH).toBe("/health");
    expect(asked).toEqual(["/health"]);
  });

  it("reads each made-up health, and the schema of the core passes each one", async () => {
    for (const fixture of [HEALTH_FIXTURE, HEALTHY_FIXTURE, FIRST_FIXTURE]) {
      expect(healthPayloadSchema.safeParse(fixture).success).toBe(true);
      expect(await readHealth(answer(JSON.stringify(fixture)))).toEqual({ ok: true, payload: fixture });
    }
  });

  it("tells that a runtime with no health function has no health route, with no words of a failure", async () => {
    expect(await readHealth(answer("", 404))).toEqual({ ok: false, absent: true });
  });

  it("says in plain words that the runtime does not answer, or answers with a status", async () => {
    const down = await readHealth(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(down).toEqual(fail("The runtime does not answer."));
    expect(await readHealth(answer("", 503))).toEqual(fail("The runtime answers with the status 503."));
    // The page tells only the status, also when the answer has a JSON body.
    expect(await readHealth(answer('{"problem":"The request has no good host."}', 403))).toEqual(fail("The runtime answers with the status 403."));
  });

  it("tells a health of a different format to start the runtime of the version of the page", async () => {
    const result = await readHealth(answer(JSON.stringify({ ...HEALTH_FIXTURE, format: "alerts-health/2" })));
    expect(result).toEqual({ ok: false, absent: false, text: OTHER_HEALTH_TEXT });
    expect(OTHER_HEALTH_TEXT).toBe(`${SOURCE} The runtime has a different version of the health. Start the runtime of the version of this page.`);
  });

  it("refuses an answer that is not JSON", async () => {
    expect(await readHealth(answer("<!doctype html><title>alerts</title>"))).toEqual(fail("The answer of the runtime is not JSON."));
  });

  it("refuses JSON that is not a health", async () => {
    const { sources, ...noSources } = HEALTH_FIXTURE;
    const first = sources[0];
    const bodies: unknown[] = [
      null,
      [],
      "alerts-health/1",
      {},
      // A format that is not a text.
      { ...HEALTH_FIXTURE, format: 1 },
      // No list of the sources.
      noSources,
      // A state that the page has no word for.
      { ...HEALTH_FIXTURE, sources: [{ ...first, state: "broken" }] },
      // A stage that the page has no word for.
      { ...HEALTH_FIXTURE, quotas: [{ ...HEALTH_FIXTURE.quotas[0], stages: ["empty"] }] },
      // The raw failure of a source: the payload holds only its time, its kind and its redacted message.
      { ...HEALTH_FIXTURE, sources: [{ ...first, lastFailure: { at: 1, failure: { kind: "timeout", message: "The fetch passed its time limit." } } }] },
      // A time that is not a number.
      { ...HEALTH_FIXTURE, now: "2026-11-15T21:00:00Z" },
    ];
    for (const body of bodies) expect(await readHealth(answer(JSON.stringify(body))), JSON.stringify(body).slice(0, 80)).toEqual(fail("The answer of the runtime is not a health."));
  });
});
