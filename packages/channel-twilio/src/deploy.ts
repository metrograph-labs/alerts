/**
 * The deploy of the outage call: the three Functions, the list as a private Asset, the build and the
 * variables, on one service of Twilio Serverless. `twilioServerlessDeploy` of
 * `@procedures/notify/twilio-serverless` sends the requests. A second deploy of the same plan reads
 * three lists and changes nothing.
 *
 * The bundles need esbuild. The stage of a slot writes them to a file (`bundle-file.ts`), and `deployOutage` reads the file.
 * Only a missing or old file loads the module `bundle.ts`, with a dynamic import. Thus the import of this module does not load esbuild.
 */

import { canonicalHash } from "@mark1russell7/rigor-generators";
import {
  twilioServerlessDeploy,
  type TwilioServerlessDeployPlan,
  type TwilioServerlessDeployPorts,
  type TwilioServerlessDeployResult,
  type TwilioServerlessFile,
} from "@procedures/notify/twilio-serverless";
import type { TwilioCredentials } from "@procedures/notify/twilio";
import { FUNCTION_DEPENDENCIES, FUNCTION_RUNTIME, outageBundles, type FunctionBundle, type OutageBundlesOptions } from "./bundle-file.ts";
import { OUTAGE_PATHS, type OutageList } from "./outage.ts";
import { OUTAGE_LIST_ASSET } from "./twilio-runtime.ts";

export type { TwilioServerlessDeployPorts, TwilioServerlessDeployResult } from "@procedures/notify/twilio-serverless";

/**
 * The service of the outage call. Its unique name is a part of its domain name. The Functions get the
 * credentials of the account (`includeCredentials`), so `context.getTwilioClient()` works with no key in a file.
 */
export const OUTAGE_SERVICE = { uniqueName: "alerts-outage", friendlyName: "The outage call of the alerts", includeCredentials: true } as const;

/** The environment of the outage call. */
export const OUTAGE_ENVIRONMENT = { uniqueName: "production", domainSuffix: "prod" } as const;

/** The count of the characters of the hash in the version of a plan. */
const VERSION_LENGTH = 16;

/** The build of the Functions: the runtime of Node and the npm packages. `bundle-file.ts` gives them. */
export interface OutageBuild {
  readonly runtime: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

/** The input of the plan. The list, the token and the number are private. */
export interface OutageDeployInput {
  readonly list: OutageList;
  readonly bundles: readonly FunctionBundle[];
  readonly build: OutageBuild;
  /** The token of the entry. The webhook of the outside check sends it as the parameter `token`. */
  readonly token: string;
  /** The Twilio number that makes the calls. */
  readonly from: string;
  /** The Twilio number that sends the texts. Without it, the plan sets no variable `OUTAGE_TEXT_FROM`. */
  readonly textFrom?: string | undefined;
}

/**
 * This function gives the deploy plan of the outage call.
 *
 * - The version is the start of the content hash of the files and of the build. A new list or a new bundle gives a new version.
 * - The variables are not in the version. A change of the token or of a number deploys the same build again.
 *
 * @throws Error when the bundles do not have each path of `OUTAGE_PATHS` one time.
 */
export function outageDeployPlan(input: OutageDeployInput): TwilioServerlessDeployPlan {
  const paths = input.bundles.map((bundle) => bundle.path).sort();
  const expected = Object.values(OUTAGE_PATHS).sort();
  if (paths.join(" ") !== expected.join(" ")) throw new Error(`The bundles have the paths ${paths.join(", ")}. The outage call needs ${expected.join(", ")}, each one time.`);
  // The functions go in the order of their paths. Thus the order of the bundles does not change the version.
  const functions: TwilioServerlessFile[] = [...input.bundles]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((bundle) => ({ path: bundle.path, visibility: bundle.visibility, content: bundle.code, contentType: "application/javascript" }));
  const assets: TwilioServerlessFile[] = [{ path: OUTAGE_LIST_ASSET, visibility: "private", content: JSON.stringify(input.list), contentType: "application/json" }];
  const build = { runtime: input.build.runtime, dependencies: { ...input.build.dependencies } };
  return {
    service: OUTAGE_SERVICE,
    environment: OUTAGE_ENVIRONMENT,
    functions,
    assets,
    build,
    variables: { OUTAGE_TOKEN: input.token, OUTAGE_FROM: input.from, ...(input.textFrom === undefined ? {} : { OUTAGE_TEXT_FROM: input.textFrom }) },
    version: canonicalHash({ functions, assets, build }, { form: "json" }).slice(0, VERSION_LENGTH),
  };
}

/** The private parts of a deploy: the list, the token and the numbers. */
export type OutageSecrets = Pick<OutageDeployInput, "list" | "token" | "from" | "textFrom">;

/**
 * This function gets the bundles of the Functions and deploys the plan. It gives the result of
 * `twilioServerlessDeploy`. It throws when the bundles fail, when the plan breaks a rule, and at the abort of `ports.signal`.
 *
 * - With `bundles.store`, a good file of the bundles gives them with no esbuild. A missing or old file makes them and writes the file.
 * - Without a store, the function makes the bundles with esbuild at each deploy.
 *
 * The address of the entry is `https://`, the domain name of the result and `OUTAGE_PATHS.entry`.
 */
export async function deployOutage(
  ports: TwilioServerlessDeployPorts,
  credentials: TwilioCredentials,
  secrets: OutageSecrets,
  bundleOptions: OutageBundlesOptions = {},
): Promise<TwilioServerlessDeployResult> {
  const bundles = await outageBundles(bundleOptions);
  const plan = outageDeployPlan({ ...secrets, bundles, build: { runtime: FUNCTION_RUNTIME, dependencies: FUNCTION_DEPENDENCIES } });
  return twilioServerlessDeploy(ports, credentials, plan);
}

/** This function gives the address of the entry of the outage call on a domain of Twilio. The webhook of the outside check calls it. */
export function outageEntryUrl(domainName: string): string {
  return `https://${domainName}${OUTAGE_PATHS.entry}`;
}
