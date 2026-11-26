/**
 * The tests of the HTTP transport of the exchange (AL-16): a real procedures host on the loopback, and the call of the
 * reader through `@procedures/client`. The source gives a fixed page and keeps the input of each read.
 */
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { CopyListen, CopyPeer } from "@mark1russell7/alerts";
import { embeddedProcess, service, type ServiceBuilder } from "@mark1russell7/service";
import { ms, seconds } from "@procedures/client";
import { describe, expect, it } from "vitest";
import { CONFIG_FILES_FORMAT, type ConfigFiles } from "./config-sync.ts";
import { EXCHANGE_FORMAT, EXCHANGE_PAGE, type ExchangePage } from "./exchange.ts";
import { configFilesCall, EXCHANGE_BASE_PATH, EXCHANGE_TOKEN_LENGTH, exchangeBaseUrl, exchangeCall } from "./exchange-http.ts";
import { runtimeHost } from "./procedures-host.ts";
import { parseEntries, type EntriesInput, type EntriesSource } from "./peers.ts";

const T0 = 1_775_066_400_000;
const TOKEN = "fake-exchange-token-".padEnd(EXCHANGE_TOKEN_LENGTH, "0");
const OTHER_TOKEN = "fake-other-token-".padEnd(EXCHANGE_TOKEN_LENGTH, "1");
const HASH = "0".repeat(64);
const LOOPBACK: CopyListen = { host: "127.0.0.1", port: 0 };

const pageOf = (after: number): ExchangePage => ({ format: EXCHANGE_FORMAT, copy: "copy-b", log: "started:run-b", after, next: after, head: after, items: [] });

/** A service with short stages, as in the contract test of the procedures host. */
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

interface Served {
  /** The base URL of the procedures on the listener. */
  readonly address: string;
  /** The other copy as the reader sees it: the URL of the listener with no base path. */
  readonly peer: CopyPeer;
  /** The input of each read of the source. */
  readonly reads: EntriesInput[];
  /** This function stops the service and gives its exit code. */
  stop(): Promise<number>;
}

const sourceOf = (reads: EntriesInput[]): EntriesSource => ({
  runtime: {
    share: (after, limit) => {
      reads.push(limit === undefined ? { after } : { after, limit });
      return pageOf(after);
    },
  },
  clock: fakeWallClock(T0),
  configHash: HASH,
});

async function serve(configFiles?: ConfigFiles): Promise<Served> {
  const reads: EntriesInput[] = [];
  const host = runtimeHost({ exchange: { source: sourceOf(reads), token: TOKEN, listen: LOOPBACK, ...(configFiles === undefined ? {} : { configFiles }) } });
  const life = await host.declare(serviceOf("exchange-test")).run({ process: embeddedProcess() });
  const address = host.info.endpoints().find((endpoint) => endpoint.type === "http")?.address;
  if (address === undefined) {
    await life.shutdown("the test has no address");
    throw new Error("The host has no HTTP endpoint.");
  }
  return {
    address,
    peer: { id: "copy-b", url: address.slice(0, address.length - EXCHANGE_BASE_PATH.length) },
    reads,
    stop: async () => {
      await life.shutdown("the test ended");
      return life.done;
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;

describe("the HTTP transport of the exchange", () => {
  it("serves the page of the source to a call with the token", async () => {
    const served = await serve();
    try {
      expect(served.address.endsWith(EXCHANGE_BASE_PATH)).toBe(true);
      expect(exchangeBaseUrl(served.peer)).toBe(served.address);
      const call = exchangeCall({ token: TOKEN });
      const value = await call(served.peer, { after: 3, limit: 10 }, signal());
      expect(value).toEqual({ page: pageOf(3), time: T0, configHash: HASH });
      expect(parseEntries(value).tag).toBe("ok");
      // A call with no limit gives no limit to the source.
      await call(served.peer, { after: 0 }, signal());
      expect(served.reads).toEqual([{ after: 3, limit: 10 }, { after: 0 }]);
    } finally {
      expect(await served.stop()).toBe(0);
    }
  });

  it("refuses a call with another token or with no token, and the source reads no page", async () => {
    const served = await serve();
    const statuses: number[] = [];
    // This fetch removes the header Authorization, and it keeps the status of each answer.
    const bare: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      const response = await fetch(input, { ...init, headers });
      statuses.push(response.status);
      return response;
    };
    try {
      await expect(exchangeCall({ token: OTHER_TOKEN })(served.peer, { after: 0 }, signal())).rejects.toThrow();
      await expect(exchangeCall({ token: TOKEN, fetch: bare })(served.peer, { after: 0 }, signal())).rejects.toThrow();
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((status) => status === 401)).toBe(true);
      expect(served.reads).toEqual([]);
    } finally {
      expect(await served.stop()).toBe(0);
    }
  });

  it("refuses an input with an unknown field or a limit above the page, before the source", async () => {
    const served = await serve();
    try {
      const call = exchangeCall({ token: TOKEN });
      await expect(call(served.peer, { after: 0, limit: EXCHANGE_PAGE + 1 }, signal())).rejects.toThrow();
      await expect(call(served.peer, { after: -1 }, signal())).rejects.toThrow();
      await expect(call(served.peer, { after: 0, copy: "copy-a" } as EntriesInput, signal())).rejects.toThrow();
      expect(served.reads).toEqual([]);
    } finally {
      expect(await served.stop()).toBe(0);
    }
  });

  it("serves the texts of the configuration to a call with the token, and only when the host has them", async () => {
    const files: ConfigFiles = { format: CONFIG_FILES_FORMAT, copy: "copy-b", configHash: HASH, files: { config: "{}", parts: [{ name: "extra", text: "{}" }] } };
    const served = await serve(files);
    try {
      expect(await configFilesCall({ token: TOKEN })(served.peer, signal())).toEqual(files);
      await expect(configFilesCall({ token: OTHER_TOKEN })(served.peer, signal())).rejects.toThrow();
      // The log stays on the same host.
      expect(await exchangeCall({ token: TOKEN })(served.peer, { after: 0 }, signal())).toEqual({ page: pageOf(0), time: T0, configHash: HASH });
    } finally {
      expect(await served.stop()).toBe(0);
    }
    const plain = await serve();
    try {
      await expect(configFilesCall({ token: TOKEN })(plain.peer, signal())).rejects.toThrow();
    } finally {
      expect(await plain.stop()).toBe(0);
    }
  });

  it("does not make a host with a short token, and the message holds no token", () => {
    const short = "fake-short-token";
    expect(() => runtimeHost({ exchange: { source: sourceOf([]), token: short, listen: LOOPBACK } })).toThrow(`fewer than ${EXCHANGE_TOKEN_LENGTH} characters`);
    try {
      runtimeHost({ exchange: { source: sourceOf([]), token: short, listen: LOOPBACK } });
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
  });
});

describe("the base URL of another copy", () => {
  it("adds the base path after the URL with no slash at its end", () => {
    expect(exchangeBaseUrl({ id: "copy-b", url: "http://copy-b.test:4751" })).toBe("http://copy-b.test:4751/exchange");
    expect(exchangeBaseUrl({ id: "copy-b", url: "http://copy-b.test:4751//" })).toBe("http://copy-b.test:4751/exchange");
    expect(exchangeBaseUrl({ id: "copy-b", url: "http://copy-b.test:4751/alerts/" })).toBe("http://copy-b.test:4751/alerts/exchange");
  });
});
