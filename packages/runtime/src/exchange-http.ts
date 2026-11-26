/**
 * This module holds the HTTP transport of the exchange of the copies (AL-16). It has the procedure `alerts.log.entries`
 * on the one procedures host of the runtime (`procedures-host.ts`), and the call of the procedure from the reader. The design is in the
 * section "The exchange" of `docs/CONTRACTS.md`.
 *
 * - The host checks the token of each request. The runtime has no route and no token check of its own.
 * - The host serves only the procedures `alerts.log.entries` and `alerts.config.files`, and they change nothing.
 * - The procedure `alerts.config.files` gives the texts of `config.json` and of the parts for the sync of the
 *   configuration (AL-17). It gives no text of `secrets.env` and no text of `copy.json`.
 * - The listener is on the address `listen` of `copy.json`: the tailnet address of the computer.
 */
import { Client, createProcedure, createRegistry, HttpTransport, pathToMethod, type AnyProcedure, type ProcedureRegistry } from "@procedures/client";
import type { CopyPeer } from "@mark1russell7/alerts";
import * as z from "zod";
import type { ConfigFiles, ConfigFilesCall } from "./config-sync.ts";
import { EXCHANGE_PAGE } from "./exchange.ts";
import { serveEntries, type EntriesInput, type EntriesSource, type ExchangeCall } from "./peers.ts";

/** The path of the procedure that gives the shared events of the log. */
export const ENTRIES_PATH: readonly string[] = Object.freeze(["alerts", "log", "entries"]);

/** The name of the procedure that gives the shared events of the log. */
export const ENTRIES_KEY = "alerts.log.entries";

/** The path of the procedure that gives the texts of the configuration of the copy. */
export const CONFIG_FILES_PATH: readonly string[] = Object.freeze(["alerts", "config", "files"]);

/** The name of the procedure that gives the texts of the configuration of the copy. */
export const CONFIG_FILES_KEY = "alerts.config.files";

/** The path of the procedures on the listener of the exchange. The reader adds it to the URL of each other copy. */
export const EXCHANGE_BASE_PATH = "/exchange";

/** The fewest characters of the token of the exchange. A shorter token stops the start. */
export const EXCHANGE_TOKEN_LENGTH = 32;

/** The input of the procedure, as the host checks it before the handler. */
const entriesInput = z.strictObject({
  after: z.int().nonnegative(),
  limit: z.int().min(1).max(EXCHANGE_PAGE).optional(),
});

/**
 * This function gives the registry of the exchange: the procedure `alerts.log.entries` on the parts of one runtime. With
 * `configFiles`, the registry also has the procedure `alerts.config.files`, which gives that answer.
 */
export function entriesRegistry(source: EntriesSource, configFiles?: ConfigFiles): ProcedureRegistry {
  return createRegistry({ name: "alerts-exchange", procedures: entriesProcedures(source, configFiles) });
}

/** This function gives the procedures of the exchange, for `entriesRegistry` and for the one procedures host of the runtime (AL-95). */
export function entriesProcedures(source: EntriesSource, configFiles?: ConfigFiles): AnyProcedure[] {
  const files =
    configFiles === undefined
      ? []
      : [
          createProcedure()
            .path([...CONFIG_FILES_PATH])
            .input(z.strictObject({}))
            .output(z.unknown())
            .meta({ description: "The texts of config.json and of the parts of the copy, for the sync of the configuration.", effects: { reads: ["alerts.config"], writes: [] } })
            .handler(async (): Promise<unknown> => configFiles)
            .build(),
        ];
  return [
    ...files,
    createProcedure()
      .path([...ENTRIES_PATH])
      .input(entriesInput)
      .output(z.unknown())
      .meta({ description: "The shared events of the log after a position, the time of the copy and the hash of its configuration.", effects: { reads: ["alerts.log"], writes: [] } })
      .handler(async (input): Promise<unknown> => {
        const given: EntriesInput = input.limit === undefined ? { after: input.after } : { after: input.after, limit: input.limit };
        return serveEntries(source, given);
      })
      .build(),
  ];
}

/** The options of `exchangeCall`. */
export interface ExchangeCallOptions {
  /** The token of the exchange, the key `COPY_TOKEN` of `secrets.env`. */
  readonly token: string;
  /** The fetch of the requests. The default is the global fetch at the time of each call. */
  readonly fetch?: typeof fetch;
}

/** The character code of the slash. */
const SLASH = 0x2f;

/** This function gives the base URL of the procedures of another copy: its URL and `EXCHANGE_BASE_PATH`. */
export function exchangeBaseUrl(peer: CopyPeer): string {
  // A loop, not a regular expression, removes the slashes at the end: its time is linear in the length of the URL.
  let end = peer.url.length;
  while (end > 0 && peer.url.charCodeAt(end - 1) === SLASH) end -= 1;
  return `${peer.url.slice(0, end)}${EXCHANGE_BASE_PATH}`;
}

/**
 * This function gives the call of the exchange over HTTP: one client of `@procedures/client` for each other copy, with
 * the token in the header `Authorization`. The worker of the exchange gives the time limit and the stop as the signal.
 */
export function exchangeCall(options: ExchangeCallOptions): ExchangeCall {
  const clientOf = exchangeClients(options);
  const method = pathToMethod(ENTRIES_PATH);
  return (peer, input, signal) => clientOf(peer).call<EntriesInput, unknown>(method, input, { signal });
}

/** This function gives the call of the procedure `alerts.config.files` over HTTP, as `exchangeCall` does for the log. */
export function configFilesCall(options: ExchangeCallOptions): ConfigFilesCall {
  const clientOf = exchangeClients(options);
  const method = pathToMethod(CONFIG_FILES_PATH);
  return (peer, signal) => clientOf(peer).call<Record<string, never>, unknown>(method, {}, { signal });
}

// One client of `@procedures/client` for each other copy, with the token in the header `Authorization`.
function exchangeClients(options: ExchangeCallOptions): (peer: CopyPeer) => Client {
  const clients = new Map<string, Client>();
  const headers = { Authorization: `Bearer ${options.token}` };
  return (peer) => {
    const known = clients.get(peer.id);
    if (known !== undefined) return known;
    const transport = new HttpTransport({ baseUrl: exchangeBaseUrl(peer), defaultHeaders: headers, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    const client = new Client(transport);
    clients.set(peer.id, client);
    return client;
  };
}
