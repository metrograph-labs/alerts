/**
 * The types of the part of `@xmpp/client` 0.14 that `session.ts` uses. The package has no types of its own. Only
 * `session.ts` imports the package, so a move to another XMPP library changes one file and this one.
 */
declare module "@xmpp/client" {
  /** One XML element of the stream, an element of `ltx`. */
  export interface XmlElement {
    readonly name: string;
    readonly attrs: Readonly<Record<string, string | undefined>>;
    readonly children: readonly (XmlElement | string)[];
    is(name: string, xmlns?: string): boolean;
    getChild(name: string, xmlns?: string): XmlElement | undefined;
    getChildren(name: string, xmlns?: string): XmlElement[];
    getText(): string;
  }

  /** The reconnect part of the client. */
  export interface Reconnect {
    stop(): void;
  }

  /** The client of one XMPP connection. */
  export interface XmppClient {
    on(event: "online", listener: () => void): this;
    /** The client tells `disconnect` when the socket closes. `clean` is false after an error of the socket. */
    on(event: "disconnect", listener: (detail: { readonly clean: boolean }) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    /** The client tells `close` at the end of the stream, before the socket closes. */
    on(event: "close", listener: () => void): this;
    on(event: "stanza", listener: (stanza: XmlElement) => void): this;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    send(element: XmlElement): Promise<void>;
    write(text: string): Promise<void>;
    isSecure(): boolean;
    readonly reconnect: Reconnect;
  }

  /** The part of the connection that a login function reads. */
  export interface Entity {
    isSecure(): boolean;
  }

  /** The user name and the password of a login. */
  export interface Login {
    readonly username: string;
    readonly password: string;
  }

  /** This function sends a login with one mechanism of the server. */
  export type Authenticate = (login: Login, mechanism: string) => Promise<void>;

  /**
   * This function does the login. The client gives it the mechanisms of the server that the client knows, in the
   * order of the server, and the connection.
   */
  export type Credentials = (authenticate: Authenticate, mechanisms: readonly string[], fast: unknown, entity: Entity) => Promise<void>;

  /** The options of a client. The user name sets the JID of the client. The function `credentials` does the login. */
  export interface ClientOptions {
    readonly service: string;
    readonly domain: string;
    readonly resource: string;
    readonly username: string;
    readonly credentials: Credentials;
    readonly timeout?: number;
  }

  export function client(options: ClientOptions): XmppClient;
  export function xml(name: string, attrs?: Readonly<Record<string, string>>, ...children: (XmlElement | string)[]): XmlElement;
}
