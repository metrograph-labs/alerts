import { createServer, type Server, type Socket } from "node:net";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { XmppClient } from "@xmpp/client";
import { afterEach, describe, expect, it } from "vitest";
import { dropLateData, openXmppSession, type EndKind } from "./session.ts";

const HEADER = "<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' id='s1' from='example.test' version='1.0'>";

// A server that opens the stream, ends it, and then sends more data on the same socket before it closes.
function lateDataServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
    socket.once("data", () => {
      socket.write(HEADER);
      setTimeout(() => {
        socket.write("</stream:stream>");
        setTimeout(() => socket.write("<late/>"), 20);
        setTimeout(() => socket.end(), 60);
      }, 20);
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}

let open: Server | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

describe("openXmppSession", () => {
  it("ends at the end of the stream and survives data after it (AL-140)", async () => {
    const { server, port } = await lateDataServer();
    open = server;
    const ended = await new Promise<{ reason: string; kind: EndKind }>((resolve) => {
      openXmppSession(
        {
          service: `xmpp://127.0.0.1:${String(port)}`,
          domain: "example.test",
          room: "room@conference.example.test",
          username: "user",
          password: "made-up-password",
          nickname: "alerts-test",
          history: { maxStanzas: 0 },
          keepalive: 60_000,
          timeout: 60_000,
          clock: fakeWallClock(0),
        },
        { joined: () => undefined, product: () => undefined, ended: (reason, kind) => resolve({ reason, kind }) },
      );
    });
    expect(ended.reason).toBe("the server closed the stream");
    // The late data comes after the end. An error of its handler stops the test process.
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
});

describe("dropLateData", () => {
  it("drops the data when the connection has no parser, and passes it on when it has one", () => {
    const seen: string[] = [];
    const connection = {
      parser: null as unknown,
      _onData(this: { parser: unknown }, data: Buffer): void {
        if (this.parser === null) throw new TypeError("Cannot read properties of null (reading 'write')");
        seen.push(data.toString("utf8"));
      },
    };
    dropLateData(connection as unknown as XmppClient);
    connection._onData(Buffer.from("<a/>"));
    connection.parser = {};
    connection._onData(Buffer.from("<b/>"));
    expect(seen).toEqual(["<b/>"]);
  });
});
