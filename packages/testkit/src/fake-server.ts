/**
 * The listener of the fakes of the outside services in the lab of the capacity models (AL-131). A fake listens on
 * `127.0.0.1`. A measured start sends a request to `https://<host><path>` as `/<host><path>` to the fake, with the
 * instant of its wall clock in the header `MEASURE_NOW_HEADER`.
 *
 * The scripted server of `@mark1russell7/rigor-testkit/http` gives fixed replies. The answers of a fake change with the
 * instant of the request, thus a fake has its own listener on `node:http`.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MEASURE_NOW_HEADER } from "@mark1russell7/alerts-runtime";
import { errorMessage } from "@mark1russell7/text";

/** One request at a fake. */
export interface FakeRequest {
  readonly method: string;
  /** The host of the request of the app, for example `api.weather.gov`. */
  readonly host: string;
  /** The path of the request of the app, with no query, for example `/alerts/active`. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The query of the request as it came, with its `?`, or an empty text. */
  readonly search: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** The instant of the request: the header `MEASURE_NOW_HEADER`, or the time of the platform when the header is absent. */
  readonly now: number;
}

/** The reply of a fake. The body is one text, one byte array or the parts of a long text. */
export interface FakeReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | Iterable<string>;
}

/** The answer of a fake to one request. */
export type FakeHandler = (request: FakeRequest) => FakeReply;

/** A fake that listens. */
export interface FakeServer {
  /** The base URL of the fake, for example `http://127.0.0.1:4100`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** The reply to a request that the fake does not know. A source reads it as a failure of the service. */
export const UNKNOWN: FakeReply = { status: 503, headers: { "content-type": "text/plain" }, body: "The fake does not know this request." };

/** The line of the output of a fake when it serves. The contract of the app names this text as the ready signal. */
export function fakeReadyLine(service: string): string {
  return JSON.stringify({ ev: "fake-ready", service });
}

/** This function gives the instant of a request from the header `MEASURE_NOW_HEADER`. */
function nowOf(headers: IncomingHttpHeaders): number {
  const value = headers[MEASURE_NOW_HEADER];
  const now = Number(Array.isArray(value) ? value[0] : value);
  return value !== undefined && Number.isFinite(now) ? now : Date.now();
}

/**
 * This function starts a fake on `127.0.0.1`. Port `0` gives a free port. The body of a long reply goes out in parts, at
 * the pace of the client, thus the fake holds one part at a time.
 */
export async function startFake(handler: FakeHandler, port = 0): Promise<FakeServer> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://fake");
      const [, host = "", ...rest] = url.pathname.split("/");
      let reply: FakeReply;
      try {
        reply =
          host === ""
            ? UNKNOWN
            : handler({
                method: incoming.method ?? "GET",
                host,
                path: `/${rest.join("/")}`,
                query: url.searchParams,
                search: url.search,
                headers: incoming.headers,
                body: Buffer.concat(chunks).toString("utf8"),
                now: nowOf(incoming.headers),
              });
      } catch (error) {
        reply = { status: 500, headers: { "content-type": "text/plain" }, body: errorMessage(error) };
      }
      outgoing.writeHead(reply.status, reply.headers);
      if (typeof reply.body === "string" || reply.body instanceof Uint8Array) {
        outgoing.end(reply.body);
        return;
      }
      // A client that stops reading ends the pipeline. The fake keeps its listener.
      pipeline(Readable.from(reply.body), outgoing).catch(() => undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(bound)}`,
    port: bound,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
