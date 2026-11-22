/**
 * This module holds the context of the traces of the runtime (AL-82). The runtime starts the entry `/node/context` of
 * `@mark1russell7/otel-ts`: the context of OpenTelemetry and a tracer provider with the resource of the service. That entry
 * loads no SDK of `@opentelemetry/sdk-node`, no exporter and no instrumentation. Thus a small machine pays only for the
 * context, and no span leaves the process.
 *
 * - Each pass is one span (`loop.ts`). Each line of the pass has the trace id and the span id of the pass (`output.ts`).
 * - A request to the API joins the trace of its `traceparent` header (`api.ts`).
 * - The context has no instrumentation of `fetch`. Thus a request to the server of another party gets no `traceparent`.
 * - The export of the spans waits for an endpoint (AL-134). A test gives a span processor with the exporter of its capture.
 */
import { readFile } from "node:fs/promises";
import { startNodeContext, type NodeContext, type NodeContextOptions } from "@mark1russell7/otel-ts/node/context";

/** The name of the service in the resource of each span, and the name of the tracer of the runtime. */
export const SERVICE_NAME = "alerts-runtime";

/** This function gives the version of the runtime package, from its `package.json`. */
export async function runtimeVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/** The options of `startTelemetry`. */
export interface TelemetryOptions {
  /** The version of the runtime package: the attribute `service.version` of the resource. */
  readonly version: string;
  /** The id of this copy of the system (`copy.json`): the attribute `service.instance.id` of the resource. */
  readonly copy: string;
  /** The span processors. The runtime gives none, thus no span leaves the process. A test gives the processor of its capture. */
  readonly spanProcessors?: NodeContextOptions["spanProcessors"];
  /** The environment of the resource detectors (`OTEL_NODE_RESOURCE_DETECTORS`). The default is `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * This function registers the context of the traces of the runtime, with the resource of the service. A second start
 * before the `shutdown()` of the first throws. The service calls `shutdown()` in its last stage, `flush the output`.
 */
export function startTelemetry(options: TelemetryOptions): NodeContext {
  return startNodeContext({
    serviceName: SERVICE_NAME,
    resourceAttributes: { "service.version": options.version, "service.instance.id": options.copy },
    ...(options.spanProcessors === undefined ? {} : { spanProcessors: options.spanProcessors }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
