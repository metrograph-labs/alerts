/**
 * The tests of the one procedures host of the runtime (AL-95): the exchange and the intake on one host with two
 * listeners. Each token is good only on the listener of its part.
 */
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { CopyPeer } from "@mark1russell7/alerts";
import { embeddedProcess, service, type ServiceBuilder } from "@mark1russell7/service";
import { ms, seconds, type Credentials } from "@procedures/client";
import { describe, expect, it } from "vitest";
import { EXCHANGE_FORMAT, type ExchangePage } from "./exchange.ts";
import { EXCHANGE_BASE_PATH, EXCHANGE_TOKEN_LENGTH, exchangeCall } from "./exchange-http.ts";
import type { EntriesSource } from "./peers.ts";
import { faceOfRequest, PROCEDURES_HOST, runtimeHost } from "./procedures-host.ts";
import { TELL_BASE_PATH, TELL_TOKEN_LENGTH, tellCall, type TellIntake } from "./tell-intake.ts";
import type { TellEvent } from "./tell-message.ts";

const T0 = 1_775_066_400_000;
const EXCHANGE_TOKEN = "fake-exchange-token-".padEnd(EXCHANGE_TOKEN_LENGTH, "0");
const TELL_TOKEN = "fake-tell-token-".padEnd(TELL_TOKEN_LENGTH, "1");
const ASK: TellEvent = { class: "needs-you", item: "AL-95", text: "The host has one check of the tokens." };

const pageOf = (after: number): ExchangePage => ({ format: EXCHANGE_FORMAT, copy: "copy-b", log: "started:run-b", after, next: after, head: after, items: [] });

function serviceOf(name: string): ServiceBuilder {
  return service(name)
    .readiness({ type: "debounce", interval: seconds(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: seconds(45) })
    .startup(seconds(10))
    .phase("fail readiness", ms(10))
    .phase("stop intake", ms(500))
    .phase("drain", ms(1000))
    .phase("close transports", ms(500))
    .phase("stop the poller", ms(100))
    .phase("tear down dependencies", ms(500))
    .phase("close the health server", ms(100))
    .cooperativeWindow(ms(500))
    .onRepeatSignal("ignore");
}

interface Counts {
  reads: number;
  takes: number;
}

function partsOf(counts: Counts): { source: EntriesSource; intake: TellIntake } {
  const source: EntriesSource = {
    runtime: {
      share: (after) => {
        counts.reads += 1;
        return pageOf(after);
      },
    },
    clock: fakeWallClock(T0),
    configHash: "0".repeat(64),
  };
  const intake: TellIntake = {
    take: () => {
      counts.takes += 1;
      return { persons: 1, link: "none" };
    },
    drain: () => [],
  };
  return { source, intake };
}

const signal = (): AbortSignal => new AbortController().signal;

describe("the one procedures host of the runtime (AL-95)", () => {
  it("serves each part on its own listener, and refuses each token on the listener of the other part", async () => {
    const counts: Counts = { reads: 0, takes: 0 };
    const { source, intake } = partsOf(counts);
    const host = runtimeHost({ exchange: { source, token: EXCHANGE_TOKEN, listen: { host: "127.0.0.1", port: 0 } }, tell: { intake, token: TELL_TOKEN, port: 0 } });
    const life = await host.declare(serviceOf("one-host-test")).run({ process: embeddedProcess() });
    try {
      const addresses = host.info.endpoints().filter((endpoint) => endpoint.type === "http").map((endpoint) => endpoint.address);
      const exchangeAddress = addresses.find((address) => address.endsWith(EXCHANGE_BASE_PATH));
      const tellAddress = addresses.find((address) => address.endsWith(TELL_BASE_PATH));
      if (exchangeAddress === undefined || tellAddress === undefined) throw new Error("The host has no endpoint for a part.");
      const exchangePort = Number(new URL(exchangeAddress).port);
      const tellPort = Number(new URL(tellAddress).port);
      expect(exchangePort).not.toBe(tellPort);
      const peer: CopyPeer = { id: "copy-b", url: exchangeAddress.slice(0, exchangeAddress.length - EXCHANGE_BASE_PATH.length) };

      // Each token on its own listener.
      expect(await exchangeCall({ token: EXCHANGE_TOKEN })(peer, { after: 2 }, signal())).toMatchObject({ page: pageOf(2), time: T0 });
      expect(await tellCall({ port: tellPort, token: TELL_TOKEN })(ASK)).toEqual({ persons: 1, link: "none" });
      expect(counts).toEqual({ reads: 1, takes: 1 });

      // The token of the intake on the listener of the exchange, and the token of the exchange on the listener of the intake.
      await expect(exchangeCall({ token: TELL_TOKEN })(peer, { after: 0 }, signal())).rejects.toThrow();
      await expect(tellCall({ port: tellPort, token: EXCHANGE_TOKEN })(ASK)).rejects.toThrow();
      // The procedure of the intake on the listener of the exchange, with the token of the intake: the face of the exchange does not have it.
      const crossed = await fetch(`${exchangeAddress}/alerts/tell`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TELL_TOKEN}` }, body: JSON.stringify(ASK) });
      expect(crossed.ok).toBe(false);
      // The procedure of the exchange on the listener of the intake, with the token of the exchange.
      const reversed = await fetch(`http://127.0.0.1:${tellPort}${EXCHANGE_BASE_PATH}/alerts/log/entries`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${EXCHANGE_TOKEN}` }, body: JSON.stringify({ after: 0 }) });
      expect(reversed.ok).toBe(false);
      expect(counts).toEqual({ reads: 1, takes: 1 });
    } finally {
      await life.shutdown("the test ended");
      expect(await life.done).toBe(0);
    }
  });

  it("refuses options with no part, and a short token, with no token in the message", () => {
    const { source, intake } = partsOf({ reads: 0, takes: 0 });
    expect(() => runtimeHost({})).toThrow(/needs the part/u);
    expect(() => runtimeHost({ exchange: { source, token: "short-exchange", listen: { host: "127.0.0.1", port: 0 } } })).toThrow(/exchange has fewer than/u);
    expect(() => runtimeHost({ tell: { intake, token: "short-tell", port: 0 } })).toThrow(/intake has fewer than/u);
    try {
      runtimeHost({ tell: { intake, token: "short-tell", port: 0 } });
    } catch (error) {
      expect(String(error)).not.toContain("short-tell");
    }
    expect(PROCEDURES_HOST).toBe("procedures");
  });
});

describe("the face of a request (AL-95)", () => {
  const faces = [{ basePath: "/exchange" }, { basePath: "/tell" }];
  const endpoints = [
    { type: "http", address: "http://192.0.2.1:4752/exchange" },
    { type: "http", address: "http://127.0.0.1:4753/tell" },
    { type: "websocket", address: "ws://127.0.0.1:4754/tell" },
  ];
  const at = (localPort: number | undefined, localAddress?: string): Credentials => ({ connection: { ...(localPort === undefined ? {} : { localPort }), ...(localAddress === undefined ? {} : { localAddress }) } });

  it("gives the face of the local port of the socket", () => {
    expect(faceOfRequest(faces, endpoints, at(4752))).toBe(faces[0]);
    expect(faceOfRequest(faces, endpoints, at(4753, "::ffff:127.0.0.1"))).toBe(faces[1]);
  });

  it("gives no face for an unknown port, a socket with no port, or a port that is not an HTTP endpoint", () => {
    expect(faceOfRequest(faces, endpoints, at(9999))).toBeUndefined();
    expect(faceOfRequest(faces, endpoints, at(undefined))).toBeUndefined();
    expect(faceOfRequest(faces, endpoints, {})).toBeUndefined();
    expect(faceOfRequest(faces, endpoints, at(4754))).toBeUndefined();
    expect(faceOfRequest(faces, [], at(4752))).toBeUndefined();
  });

  it("picks the face by the local address when two listeners have one port on two addresses", () => {
    const shared = [
      { type: "http", address: "http://192.0.2.1:4752/exchange" },
      { type: "http", address: "http://127.0.0.1:4752/tell" },
    ];
    expect(faceOfRequest(faces, shared, at(4752, "127.0.0.1"))).toBe(faces[1]);
    expect(faceOfRequest(faces, shared, at(4752, "192.0.2.1"))).toBe(faces[0]);
    expect(faceOfRequest(faces, shared, at(4752))).toBeUndefined();
    expect(faceOfRequest(faces, shared, at(4752, "10.0.0.9"))).toBeUndefined();
  });
});
