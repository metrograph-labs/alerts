import type { ChannelId, PersonId } from "@mark1russell7/alerts";
import type { TwilioFetch } from "@procedures/notify/twilio";
import { describe, expect, it } from "vitest";
import { bundleFileOf, bundleFileText, type BundleFile, type FunctionBundle } from "./bundle-file.ts";
import { deployOutage, OUTAGE_ENVIRONMENT, OUTAGE_SERVICE, outageDeployPlan, outageEntryUrl, type OutageDeployInput } from "./deploy.ts";
import { CHANNEL_ID } from "./descriptor.ts";
import { OUTAGE_PATHS, type OutageList } from "./outage.ts";
import { OUTAGE_LIST_ASSET } from "./twilio-runtime.ts";

// Fake credentials, a fake token and fake numbers: the country code +999 has no country.
const CREDENTIALS = { accountSid: `AC${"0".repeat(32)}`, secret: "fake-secret" };
const TOKEN = "t".repeat(40);
const FROM = "+99900000001";
const LIST: OutageList = {
  version: "v1",
  message: "The alert system is down.",
  people: [{ person: "person-1" as PersonId, to: "+99900000002", chain: { steps: [CHANNEL_ID, CHANNEL_ID] as ChannelId[] } }],
  repeats: 2,
  ringSeconds: 45,
  maxCalls: 10,
  capWindow: 3_600_000,
  month: { maxCalls: 250, timeZone: "America/Chicago" },
};
const BUNDLES: FunctionBundle[] = [
  { path: OUTAGE_PATHS.entry, visibility: "public", code: "exports.handler = () => 'entry';" },
  { path: OUTAGE_PATHS.press, visibility: "protected", code: "exports.handler = () => 'press';" },
  { path: OUTAGE_PATHS.ended, visibility: "protected", code: "exports.handler = () => 'ended';" },
];
const BUILD = { runtime: "node24", dependencies: { "@twilio/runtime-handler": "2.1.2" } };
const INPUT: OutageDeployInput = { list: LIST, bundles: BUNDLES, build: BUILD, token: TOKEN, from: FROM };

describe("outageDeployPlan", () => {
  it("gives the three Functions, the list as a private asset, the build and the variables of one service", () => {
    const plan = outageDeployPlan(INPUT);
    expect(plan.service).toEqual(OUTAGE_SERVICE);
    expect(plan.environment).toEqual(OUTAGE_ENVIRONMENT);
    const sorted = [BUNDLES[2], BUNDLES[0], BUNDLES[1]] as FunctionBundle[];
    expect(plan.functions).toEqual(sorted.map((bundle) => ({ path: bundle.path, visibility: bundle.visibility, content: bundle.code, contentType: "application/javascript" })));
    expect(plan.assets).toEqual([{ path: OUTAGE_LIST_ASSET, visibility: "private", content: JSON.stringify(LIST), contentType: "application/json" }]);
    expect(plan.build).toEqual(BUILD);
    expect(plan.variables).toEqual({ OUTAGE_TOKEN: TOKEN, OUTAGE_FROM: FROM });
    expect(plan.version).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("gives the same version for the same files and build in each order, and a copy of the dependencies", () => {
    const plan = outageDeployPlan(INPUT);
    expect(outageDeployPlan(INPUT).version).toBe(plan.version);
    expect(outageDeployPlan({ ...INPUT, bundles: [...BUNDLES].reverse() })).toEqual(plan);
    expect(plan.build?.dependencies).not.toBe(BUILD.dependencies);
  });

  it("gives a new version for a new list, a new bundle or a new build", () => {
    const { version } = outageDeployPlan(INPUT);
    const versions = [
      outageDeployPlan({ ...INPUT, list: { ...LIST, version: "v2" } }).version,
      outageDeployPlan({ ...INPUT, bundles: BUNDLES.map((bundle, index) => (index === 0 ? { ...bundle, code: `${bundle.code}\n` } : bundle)) }).version,
      outageDeployPlan({ ...INPUT, build: { ...BUILD, runtime: "node22" } }).version,
      outageDeployPlan({ ...INPUT, build: { ...BUILD, dependencies: { "@twilio/runtime-handler": "2.1.3" } } }).version,
    ];
    expect(new Set([version, ...versions]).size).toBe(5);
  });

  it("keeps the version for a new token or a new number: only the variables change", () => {
    const plan = outageDeployPlan(INPUT);
    const next = outageDeployPlan({ ...INPUT, token: "u".repeat(40), from: "+99900000003" });
    expect(next.version).toBe(plan.version);
    expect(next.variables).toEqual({ OUTAGE_TOKEN: "u".repeat(40), OUTAGE_FROM: "+99900000003" });
  });

  it("sets the variable OUTAGE_TEXT_FROM only for an input with a sender of texts, and keeps the version", () => {
    const plan = outageDeployPlan(INPUT);
    const texts = outageDeployPlan({ ...INPUT, textFrom: "+99900000004" });
    expect(texts.variables).toEqual({ OUTAGE_TOKEN: TOKEN, OUTAGE_FROM: FROM, OUTAGE_TEXT_FROM: "+99900000004" });
    expect(texts.version).toBe(plan.version);
  });

  it("throws unless the bundles have each path of the outage call one time", () => {
    expect(() => outageDeployPlan({ ...INPUT, bundles: BUNDLES.slice(0, 2) })).toThrow(/need/u);
    expect(() => outageDeployPlan({ ...INPUT, bundles: [...BUNDLES, BUNDLES[0] as FunctionBundle] })).toThrow(/each one time/u);
    expect(() => outageDeployPlan({ ...INPUT, bundles: [BUNDLES[0] as FunctionBundle, BUNDLES[0] as FunctionBundle, BUNDLES[1] as FunctionBundle] })).toThrow(/each one time/u);
  });
});

describe("outageEntryUrl", () => {
  it("gives the address of the entry on the domain of the environment", () => {
    expect(outageEntryUrl("alerts-outage-1234-prod.twil.io")).toBe(`https://alerts-outage-1234-prod.twil.io${OUTAGE_PATHS.entry}`);
  });
});

describe("deployOutage", () => {
  it("makes the bundles and sends the plan: a refusal of the first request stops the deploy at the stage service", async () => {
    const urls: string[] = [];
    const fetch: TwilioFetch = async (url) => {
      urls.push(url);
      return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate", status: 401 }), headers: { get: () => null } };
    };
    const result = await deployOutage({ fetch, now: () => 0, sleep: async () => undefined }, CREDENTIALS, { list: LIST, token: TOKEN, from: FROM });
    expect(result).toMatchObject({ ok: false, stage: "service" });
    expect(urls).toEqual([`https://serverless.twilio.com/v1/Services/${OUTAGE_SERVICE.uniqueName}`]);
  }, 30_000);

  it("takes the bundles from a good file of the store and makes no bundle (AL-112)", async () => {
    const file = await bundleFileOf({ bundles: BUNDLES, inputs: ["src/functions/outage.ts", "src/functions/press.ts", "src/functions/ended.ts"] });
    const writes: string[] = [];
    const store = { read: async () => bundleFileText(file), write: async (text: string) => void writes.push(text) };
    const make = async (): Promise<BundleFile> => {
      throw new Error("The deploy made the bundles.");
    };
    const urls: string[] = [];
    const fetch: TwilioFetch = async (url) => {
      urls.push(url);
      return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Authenticate", status: 401 }), headers: { get: () => null } };
    };
    const result = await deployOutage({ fetch, now: () => 0, sleep: async () => undefined }, CREDENTIALS, { list: LIST, token: TOKEN, from: FROM }, { store, make });
    expect(result).toMatchObject({ ok: false, stage: "service" });
    expect(urls).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});
