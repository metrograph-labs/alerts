/**
 * This module holds the one procedures host of the runtime (AL-95, direction 40). One host serves the exchange of the
 * copies (`exchange-http.ts`) and the intake of the operator (`tell-intake.ts`), with one check of the tokens.
 *
 * - The host has a listener for each part: the exchange on the address `listen` of `copy.json`, the intake on the
 *   loopback address. Each listener has one face, with its base path, its procedures and its rules.
 * - Each token is good only on the listener of its part. The token of the exchange gets no call of the intake, and the
 *   token of the intake gets no call of the exchange. The message of a refusal holds no token.
 * - The face of the exchange changes nothing (`effects.writes` is empty), as the host of the exchange before.
 * - The base paths and the tokens did not change. Thus the other copies and the clients of the intake need no change.
 */
import { timingSafeEqual } from "node:crypto";
import { createRegistry, hostPolicy, ms, type Credentials, type RequestIdentity } from "@procedures/client";
import { createProcedureHost, httpFace, LOCAL_LISTENER_KNOBS, type HostListener, type ProcedureHost, type ProcedureHostFaces } from "@procedures/peer";
import type { CopyListen } from "@mark1russell7/alerts";
import type { ConfigFiles } from "./config-sync.ts";
import { EXCHANGE_LIMIT } from "./copy.ts";
import { CONFIG_FILES_KEY, ENTRIES_KEY, EXCHANGE_BASE_PATH, EXCHANGE_TOKEN_LENGTH, entriesProcedures } from "./exchange-http.ts";
import type { EntriesSource } from "./peers.ts";
import { basicPrincipal, POSITION_KEY, type PositionIntake } from "./position-intake.ts";
import { TELL_BASE_PATH, TELL_CALL_LIMIT, TELL_KEY, TELL_TOKEN_LENGTH, tellProcedures, type TellIntake } from "./tell-intake.ts";

/** The name of the host. Its listeners are the parts `procedures.listen.exchange` and `procedures.listen.tell` of the service. */
export const PROCEDURES_HOST = "procedures";

/** The part of the exchange of the host. */
export interface ExchangePart {
  /** The parts of the runtime that serve the procedure `alerts.log.entries`. */
  readonly source: EntriesSource;
  /** The token of the exchange, the key `COPY_TOKEN` of `secrets.env`. Each copy has the same token. */
  readonly token: string;
  /** The address and the port of the listener: the field `listen` of `copy.json`. The function `parseCopySettings` of the core checks it. */
  readonly listen: CopyListen;
  /** The answer of the procedure `alerts.config.files`. Without it, the host does not serve the procedure. */
  readonly configFiles?: ConfigFiles;
}

/** The part of the intake of the operator of the host. */
export interface TellPart {
  readonly intake: TellIntake;
  /** The token of the intake: the text of the file `tell.token`. */
  readonly token: string;
  /** The port on the loopback address: the field `port` of the entry `tell`. The port 0 takes a free port. */
  readonly port: number;
  /** The intake of the fixes of the moving places (AL-40). With it, the face of the intake also takes the procedure `alerts.position`. */
  readonly position?: PositionIntake;
}

/** The options of `runtimeHost`. The host has one part or the two parts. */
export interface RuntimeHostOptions {
  readonly exchange?: ExchangePart;
  readonly tell?: TellPart;
}

// One face of the host: its listener, its base path, its token and its rules.
interface Face {
  readonly name: "exchange" | "tell";
  readonly basePath: string;
  readonly token: string;
  readonly listener: HostListener;
  readonly expose: readonly string[];
  readonly readOnly: boolean;
  // The phone app of the intake sends the token as the password of HTTP Basic auth (AL-40).
  readonly basic: boolean;
}

/**
 * This function gives the one procedures host of the runtime. It starts nothing: the service of the process declares its
 * parts (`host.declare(svc)`). Each call needs the token of the listener that takes it.
 *
 * @throws Error when the options have no part, or when a token is shorter than its least length. The message holds no token.
 */
export function runtimeHost(options: RuntimeHostOptions): ProcedureHost {
  const { exchange, tell } = options;
  if (exchange === undefined && tell === undefined) throw new Error("The procedures host needs the part exchange, the part tell, or the two parts.");
  if (exchange !== undefined && exchange.token.length < EXCHANGE_TOKEN_LENGTH) throw new Error(`The token of the exchange has fewer than ${EXCHANGE_TOKEN_LENGTH} characters.`);
  if (tell !== undefined && tell.token.length < TELL_TOKEN_LENGTH) throw new Error(`The token of the intake has fewer than ${TELL_TOKEN_LENGTH} characters.`);
  const faces: Face[] = [
    ...(exchange === undefined
      ? []
      : [
          {
            name: "exchange" as const,
            basePath: EXCHANGE_BASE_PATH,
            token: exchange.token,
            listener: { name: "exchange", host: exchange.listen.host, port: exchange.listen.port, faces: ["exchange"], knobs: LOCAL_LISTENER_KNOBS },
            expose: exchange.configFiles === undefined ? [ENTRIES_KEY] : [ENTRIES_KEY, CONFIG_FILES_KEY],
            readOnly: true,
            basic: false,
          },
        ]),
    ...(tell === undefined
      ? []
      : [
          {
            name: "tell" as const,
            basePath: TELL_BASE_PATH,
            token: tell.token,
            listener: { name: "tell", host: "127.0.0.1", port: tell.port, faces: ["tell"], knobs: LOCAL_LISTENER_KNOBS },
            expose: tell.position === undefined ? [TELL_KEY] : [TELL_KEY, POSITION_KEY],
            readOnly: false,
            basic: true,
          },
        ]),
  ];
  const procedures = [
    ...(exchange === undefined ? [] : entriesProcedures(exchange.source, exchange.configFiles)),
    ...(tell === undefined ? [] : tellProcedures(tell.intake, tell.position)),
  ];
  // The check of the tokens reads the endpoints of the host at each request. A listener has its port only after its start.
  let host: ProcedureHost | undefined;
  const faceOf = (credentials: Credentials): Face | undefined => faceOfRequest(faces, host?.info.endpoints() ?? [], credentials);
  const facesOption: ProcedureHostFaces = Object.fromEntries(
    // A face with a name that is not `http` needs its factory. Each face is an HTTP face on the listener of its part.
    faces.map((face) => [face.name, httpFace({ basePath: face.basePath, expose: [...face.expose], ...(face.readOnly ? { narrowing: { effects: { writes: [] } } } : {}) })]),
  );
  host = createProcedureHost({
    name: PROCEDURES_HOST,
    registry: createRegistry({ name: "alerts-procedures", procedures }),
    policy: hostPolicy({
      principalOf: (credentials) => identityOf(faceOf(credentials), credentials),
      // A caller with the token of its listener is a part of the system: it can set the baggage of the traces.
      trustBaggage: (request) => request.principal?.via === "token",
      strictCalls: true,
      expose: faces.flatMap((face) => face.expose),
      // The reader of the exchange stops its call at EXCHANGE_LIMIT. Thus the larger limit of the host does not hold it longer.
      timeout: ms(Math.max(EXCHANGE_LIMIT, TELL_CALL_LIMIT)),
    }),
    faces: facesOption,
    listen: faces.map((face) => face.listener),
    // The probes of the service are on the probe port of the loopback. The listeners of the host give no probe.
    probes: false,
  });
  return host;
}

/**
 * This function gives the face of the listener that took a request, from the local port and the local address of its
 * socket and the endpoints of the host. With no match, or with two matches, it gives undefined. Then the request is refused.
 */
export function faceOfRequest<F extends { readonly basePath: string }>(faces: readonly F[], endpoints: readonly { readonly type: string; readonly address: string }[], credentials: Credentials): F | undefined {
  const port = credentials.connection?.localPort;
  if (port === undefined) return undefined;
  // An endpoint address is `http://<host>:<port><base path>`. An IPv6 host has no brackets, thus the port is after the last colon.
  const served = endpoints.flatMap((endpoint) => {
    const match = endpoint.type === "http" ? /^http:\/\/(.+):(\d+)(\/[^:]*)$/u.exec(endpoint.address) : null;
    return match === null ? [] : [{ host: match[1]!, port: Number(match[2]), path: match[3]! }];
  });
  const onPort = served.filter((item) => item.port === port);
  const local = credentials.connection?.localAddress?.replace(/^::ffff:/u, "");
  const picked = onPort.length === 1 ? onPort : onPort.filter((item) => item.host === local);
  if (picked.length !== 1) return undefined;
  return faces.find((face) => face.basePath === picked[0]!.path);
}

// The identity of a request with the token of its face, or undefined, which refuses the request.
function identityOf(face: Face | undefined, credentials: Credentials): RequestIdentity | undefined {
  if (face === undefined) return undefined;
  const sent = face.basic ? (basicPrincipal(credentials).bearer ?? credentials.bearer) : credentials.bearer;
  if (sent === undefined || !sameToken(sent, face.token)) return undefined;
  return { principal: { id: face.name === "exchange" ? "copy" : "operator", via: "token" } };
}

// The comparison of two tokens in a time that does not depend on the first different character.
function sameToken(sent: string, token: string): boolean {
  const a = Buffer.from(sent, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
