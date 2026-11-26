/**
 * One session of NWWS-OI: one XMPP connection that joins the room of NWWS-OI and gives each product of the room. This
 * module is the only one that imports `@xmpp/client`. The session does not reconnect: the supervisor decides each new
 * session. The session sends no login on a link with no TLS, because the mechanism PLAIN of SASL sends the password.
 */

// The reference brings the types of the package into each program that compiles this module, also the program of a
// package that imports this package.
/// <reference path="./xmpp-client.d.ts" />

import { randomBytes } from "node:crypto";
import type { Cancel, WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { client, xml, type XmlElement, type XmppClient } from "@xmpp/client";
import { PRODUCT_NAMESPACE } from "./product.ts";

/** The XMPP service of NWWS-OI: the server and the port with STARTTLS. */
export const NWWS_SERVICE = "xmpp://nwws-oi.weather.gov:5222";
/** The XMPP domain of the accounts of NWWS-OI. */
export const NWWS_DOMAIN = "nwws-oi.weather.gov";
/** The room of NWWS-OI that sends each product. */
export const NWWS_ROOM = "nwws@conference.nwws-oi.weather.gov";

const MUC = "http://jabber.org/protocol/muc";
const MUC_USER = "http://jabber.org/protocol/muc#user";
const DELAY = "urn:xmpp:delay";

/** The history that a join asks for: the products after a time, and at most a count of products. */
export interface JoinHistory {
  /** The time of the oldest product to send again. Absent: the newest products, to the count. */
  readonly since?: number;
  /** The most products to send again. */
  readonly maxStanzas: number;
}

/** The options of one session. */
export interface SessionOptions {
  readonly service: string;
  readonly domain: string;
  readonly room: string;
  readonly username: string;
  readonly password: string;
  /** The name of the session in the room and the resource of the connection. It holds no personal data. */
  readonly nickname: string;
  readonly history: JoinHistory;
  /** The time between two whitespace keepalives of the connection. */
  readonly keepalive: number;
  /** The longest time of the connect and of the login. */
  readonly timeout: number;
  readonly clock: WallClock;
}

/** One product of the room, before the read of its attributes. */
export interface RoomProduct {
  readonly attributes: Readonly<Record<string, string | undefined>>;
  readonly text: string;
  /** True: the room sent the product again from its history. */
  readonly delayed: boolean;
}

/** The kind of the end of a session: the kind of the failure of a fetch while the source has no session. */
export type EndKind = "network" | "timeout" | "auth" | "refused";

/** The functions that a session tells its events to. */
export interface SessionHandlers {
  /** The session is in the room. */
  joined(): void;
  /** The room sent a product. */
  product(product: RoomProduct): void;
  /** The session ended, with the reason and its kind. The session tells this once, and tells no event after it. */
  ended(reason: string, kind: EndKind): void;
}

/** One running session. */
export interface Session {
  /** This method ends the session. The handlers then get no event. */
  close(): Promise<void>;
}

/** A function that opens one session. The supervisor takes it as a parameter, so that a test gives a fake session. */
export type OpenSession = (options: SessionOptions, handlers: SessionHandlers) => Session;

/** This function gives a name for a session. The name is random and holds no personal data. */
export function sessionNickname(): string {
  return `alerts-${randomBytes(4).toString("hex")}`;
}

/** This function reads one stanza of the room. A stanza with no product gives `undefined`. */
export function roomProduct(stanza: XmlElement, room: string): RoomProduct | undefined {
  if (!stanza.is("message") || stanza.attrs["type"] !== "groupchat") return undefined;
  if (bareJid(stanza.attrs["from"]) !== room) return undefined;
  const element = stanza.getChild("x", PRODUCT_NAMESPACE);
  if (element === undefined) return undefined;
  return { attributes: element.attrs, text: element.getText(), delayed: stanza.getChild("delay", DELAY) !== undefined };
}

/** This function opens one session of NWWS-OI on `@xmpp/client`. */
export const openXmppSession: OpenSession = (options, handlers) => {
  const nickname = options.nickname;
  const xmpp: XmppClient = client({
    service: options.service,
    domain: options.domain,
    resource: nickname,
    username: options.username,
    // The login goes only over TLS. On a link with no TLS, the session ends before it sends a mechanism or a password.
    credentials: async (authenticate, mechanisms, _fast, entity) => {
      if (!entity.isSecure()) throw new InsecureLinkError(NOT_SECURE);
      const mechanism = mechanisms[0];
      if (mechanism === undefined) throw new Error("the server offers no mechanism of the client");
      await authenticate({ username: options.username, password: options.password }, mechanism);
    },
    timeout: options.timeout,
  });
  // The supervisor decides each new session, so the client does not reconnect.
  xmpp.reconnect.stop();
  dropLateData(xmpp);
  let done = false;
  let joined = false;
  let keepalive: Cancel | undefined;
  let joinTimer: Cancel | undefined;
  // An error of the library can quote the account. The reason holds no user name and no password.
  const end = (reason: string, kind: EndKind = "network"): void => {
    if (done) return;
    done = true;
    keepalive?.();
    joinTimer?.();
    xmpp.stop().catch(() => undefined);
    handlers.ended(redactSecrets(reason, [options.username, options.password]), kind);
  };
  const beat = (): void => {
    keepalive = options.clock.after(options.keepalive, () => {
      xmpp.write(" ").then(beat, (error: unknown) => end(`the keepalive failed: ${errorMessage(error)}`));
    });
  };
  xmpp.on("error", (error) => end(`the connection failed: ${errorMessage(error)}`, failureKind(error)));
  // The client tells `disconnect` at each close of the socket, also at a close of TCP with no close of the stream.
  xmpp.on("disconnect", ({ clean }) => end(clean ? "the server closed the connection" : "the connection broke"));
  // The client tells `close` at the end of the stream. The client then has no parser, thus the session reads no more product.
  xmpp.on("close", () => end("the server closed the stream"));
  xmpp.on("stanza", (stanza) => {
    if (done) return;
    if (stanza.is("presence") && bareJid(stanza.attrs["from"]) === options.room) {
      if (stanza.attrs["type"] === "error") return end(`the room refused the join: ${errorCondition(stanza)}`, "refused");
      if (!joined && isSelfPresence(stanza, `${options.room}/${nickname}`)) {
        joined = true;
        joinTimer?.();
        handlers.joined();
      }
      return;
    }
    const product = roomProduct(stanza, options.room);
    if (product !== undefined) handlers.product(product);
  });
  xmpp.on("online", () => {
    if (done) return;
    if (!xmpp.isSecure()) return end(NOT_SECURE, "refused");
    const history: Record<string, string> = { maxstanzas: String(options.history.maxStanzas) };
    if (options.history.since !== undefined) history["since"] = new Date(options.history.since).toISOString();
    const join = xml("presence", { to: `${options.room}/${nickname}` }, xml("x", { xmlns: MUC }, xml("history", history)));
    xmpp.send(join).then(beat, (error: unknown) => end(`the join failed: ${errorMessage(error)}`));
  });
  // The limit covers the connect, the login and the join. A session that is not in the room by then ends.
  joinTimer = options.clock.after(options.timeout, () => end(`the session did not join the room in ${String(options.timeout / 1000)} s`, "timeout"));
  xmpp.start().catch((error: unknown) => end(`the login failed: ${errorMessage(error)}`, failureKind(error)));
  return {
    close: async () => {
      if (done) return;
      done = true;
      keepalive?.();
      joinTimer?.();
      await xmpp.stop().catch(() => undefined);
    },
  };
};

// The part of a connection of `@xmpp/connection` 0.14.0 that `dropLateData` changes.
interface DataHandler {
  parser: unknown;
  _onData(data: Buffer): void;
}

/**
 * This function makes the client drop the data of the socket after the parser is gone (AL-140). In `@xmpp/connection`
 * 0.14.0, the end of the stream and an error of the parser remove the parser before the socket closes. Then the next data
 * throws a TypeError out of the listener of the socket, and that error stops the process. The function changes the handler
 * before the first connect, because the connection binds the handler at its first socket.
 */
export function dropLateData(xmpp: XmppClient): void {
  const connection = xmpp as unknown as DataHandler;
  const onData = connection._onData;
  connection._onData = function (this: DataHandler, data: Buffer): void {
    if (this.parser !== null && this.parser !== undefined) onData.call(this, data);
  };
}

const NOT_SECURE = "the link is not secure: the server did not start TLS";

/** The error of a link with no TLS. The session sends no login on such a link. */
class InsecureLinkError extends Error {
  override name = "InsecureLinkError";
}

// A SASL error of the server is a refused login. The library names its errors.
function failureKind(error: unknown): EndKind {
  const name = error instanceof Error ? error.name : "";
  if (name === "InsecureLinkError") return "refused";
  if (name === "SASLError") return "auth";
  if (name === "TimeoutError") return "timeout";
  return "network";
}

function bareJid(address: string | undefined): string | undefined {
  return address?.split("/")[0];
}

// The room tells the join with the presence of the session, with the status code 110 or the full name of the session.
function isSelfPresence(stanza: XmlElement, self: string): boolean {
  const user = stanza.getChild("x", MUC_USER);
  const codes = user?.getChildren("status").map((status) => status.attrs["code"]) ?? [];
  return codes.includes("110") || stanza.attrs["from"] === self;
}

function errorCondition(stanza: XmlElement): string {
  const error = stanza.getChild("error");
  const condition = error?.children.find((child): child is XmlElement => typeof child !== "string" && child.name !== "text")?.name;
  return condition ?? error?.attrs["type"] ?? "no condition";
}
