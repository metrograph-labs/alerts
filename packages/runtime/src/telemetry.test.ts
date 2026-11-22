import { fakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import { startScriptedServer, type ScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { captureTelemetry, type TelemetryCapture } from "@mark1russell7/rigor-testkit/otel";
import { detachedLifecycle } from "@mark1russell7/service/testing";
import { SpanStatusCode } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { fetchTransport } from "polite-crawler/api";
import { afterEach, describe, expect, it } from "vitest";
import { createLoop, type LoopTimes } from "./loop.ts";
import { outputOf, timedLogger } from "./output.ts";
import type { Pass } from "./runtime.ts";
import { runtimeVersion, SERVICE_NAME, startTelemetry } from "./telemetry.ts";

const SECOND = 1000;
const T0 = Date.UTC(2026, 3, 1, 18);
const TIMES: LoopTimes = { passLimit: 20 * SECOND, retryBase: 15 * SECOND, retryCap: 60 * SECOND };
const AGENT = "alerts-runtime-test";

/** One line of the console: the text and the fields that the logger gives with it. */
interface Line {
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** This function starts the context of the traces with the exporter of a capture, and stops it after the test. */
function capturedContext(): TelemetryCapture {
  const capture = captureTelemetry({ sdk: "external" });
  const context = startTelemetry({ version: "0.0.0-test", copy: "copy-a", spanProcessors: [new SimpleSpanProcessor(capture.spanExporter)], env: {} });
  stops.push(() => context.shutdown());
  return capture;
}

/** This function gives the output of the runtime, with each line in a list. */
function capturedOutput(wall: WallClock) {
  const lines: Line[] = [];
  const write = (text: unknown, fields?: unknown): void => {
    lines.push({ text: String(text), fields: (fields ?? {}) as Line["fields"] });
  };
  const out = outputOf(timedLogger({ wall, console: { debug: write, info: write, warn: write, error: write } }));
  return { out, lines };
}

/** This function starts a loop whose passes do `work`, and gives a promise of the end of the first pass. */
async function startLoop(work: () => Promise<Pass>) {
  const clock = fakeClock(T0);
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  let ended: (value: unknown) => void = () => undefined;
  const firstPass = new Promise((resolve) => {
    ended = resolve;
  });
  const loop = createLoop({
    clock,
    wall,
    times: TIMES,
    random: () => 0,
    onError: () => undefined,
    pass: async () => {
      try {
        return await work();
      } finally {
        ended(undefined);
      }
    },
  });
  const signal = new AbortController().signal;
  await loop.worker.start(signal, detachedLifecycle(clock));
  stops.push(async () => {
    await loop.worker.stopIntake();
    await loop.worker.drain(clock.now() + TIMES.passLimit, signal);
    await loop.worker.close();
  });
  await clock.advance(0);
  // The span of the pass ends after the work of the pass. Thus the promise waits for the callbacks after the work.
  return { clock, wall, firstPass: firstPass.then(() => new Promise<void>((resolve) => setImmediate(resolve))) };
}

/** A pass of the test: only its time counts. */
const passAt = (at: number): Pass => ({ at, fetched: [], view: {} as Pass["view"], conflicts: [] });

describe("the context of the traces of the runtime", () => {
  it("makes each pass one span, gives its line the trace id of the span, and sends no traceparent to another server", async () => {
    const capture = capturedContext();
    const server: ScriptedServer = await startScriptedServer({ routes: [{ path: "/feed", replies: [{ body: "{}" }] }] });
    stops.push(() => server.close());
    const transport = fetchTransport({ userAgent: AGENT });
    const wall: WallClock = { time: "wall", now: () => T0, after: () => () => undefined };
    const { out, lines } = capturedOutput(wall);
    const { firstPass } = await startLoop(async () => {
      const reply = await transport({ method: "GET", url: `${server.url}/feed`, headers: {}, body: null }, undefined);
      out.log(`The feed gave ${String(reply.status)}.`);
      return passAt(T0);
    });
    await firstPass;

    const spans = await capture.spans();
    expect(spans.map((span) => span.name)).toEqual(["pass"]);
    const span = spans[0]!;
    expect(span.instrumentationScope.name).toBe(SERVICE_NAME);
    expect(span.resource.attributes).toMatchObject({ "service.name": SERVICE_NAME, "service.version": "0.0.0-test", "service.instance.id": "copy-a" });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);

    // The line of the pass has the trace id and the span id of the pass.
    const line = lines.find((each) => each.text.endsWith("The feed gave 200."));
    expect(line?.fields).toEqual({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });

    // The request went out with the User-Agent and with no header of a trace.
    expect(server.requests).toHaveLength(1);
    const fields = server.requests[0]!.fields;
    expect(fields["user-agent"]).toBe(AGENT);
    expect(fields).not.toHaveProperty("traceparent");
    expect(fields).not.toHaveProperty("tracestate");
    expect(fields).not.toHaveProperty("baggage");
  });

  it("gives a line out of a pass no trace id", async () => {
    capturedContext();
    const wall: WallClock = { time: "wall", now: () => T0, after: () => () => undefined };
    const { out, lines } = capturedOutput(wall);
    out.log("The runtime starts.");
    expect(lines).toEqual([{ text: `${new Date(T0).toISOString()} The runtime starts.`, fields: {} }]);
  });

  it("ends the span of a pass that throws with the status error and only the name of the error", async () => {
    const capture = capturedContext();
    const { firstPass } = await startLoop(() => Promise.reject(new TypeError("the value 1234 is not a feed")));
    await firstPass;
    const spans = await capture.spans();
    expect(spans.map((span) => span.name)).toEqual(["pass"]);
    expect(spans[0]!.status).toEqual({ code: SpanStatusCode.ERROR, message: "TypeError" });
  });

  it("gives the version of the runtime package", async () => {
    expect(await runtimeVersion()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
