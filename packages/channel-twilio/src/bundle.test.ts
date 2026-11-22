import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFunction, createContext, runInContext } from "node:vm";
import type { ChannelId, PersonId } from "@mark1russell7/alerts";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleBuild, bundleFunctions, withoutStoreFolders } from "./bundle.ts";
import { bundleFileOf, bundleFileText, checkBundleFile, type BundleBuild, type FunctionBundle } from "./bundle-file.ts";
import { CHANNEL_ID } from "./descriptor.ts";
import { OUTAGE_PATHS, OUTAGE_TEXTS, type OutageList } from "./outage.ts";
import { OUTAGE_LIST_ASSET, type RuntimeCallOptions, type RuntimeCalls, type RuntimeContext, type RuntimeHandler } from "./twilio-runtime.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
const steps = (count: number): ChannelId[] => Array.from({ length: count }, () => CHANNEL_ID);
const LIST: OutageList = {
  version: "v1",
  message: "The alert system is down.",
  people: [{ person: "person-1" as PersonId, to: "+15555550123", chain: { steps: steps(2) } }],
  repeats: 2,
  ringSeconds: 45,
  maxCalls: 10,
  capWindow: 3_600_000,
  month: { maxCalls: 250, timeZone: "America/Chicago" },
};

interface Loaded {
  readonly handler: RuntimeHandler;
  /** The modules that the bundle loads with `require`. */
  readonly required: string[];
  readonly lines: string[];
}

class FakeResponse {
  status = 0;
  headers: [string, string][] = [];
  body = "";
  setStatusCode(code: number): void {
    this.status = code;
  }
  appendHeader(name: string, value: string): void {
    this.headers.push([name, value]);
  }
  setBody(body: string): void {
    this.body = body;
  }
}

// The Node globals of the Functions runtime that a bundle can read.
const NODE_GLOBALS = ["process", "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "setTimeout", "clearTimeout", "queueMicrotask", "structuredClone", "crypto", "performance"];

/**
 * How the test gives `Runtime` and `Twilio` to a bundle.
 * - `globals`: as globals of the context, as the dev runtime of Twilio does.
 * - `wrapper`: as parameters of a wrapper of the file. The context has no such global, as on the server of Twilio.
 */
type Scope = "globals" | "wrapper";

// This function runs a bundle as the Functions runtime does: with the Node globals, `Runtime` and `Twilio`.
// The `require` of the context gives only the Node built-ins.
function load(bundle: FunctionBundle, scope: Scope = "globals"): Loaded {
  const required: string[] = [];
  const lines: string[] = [];
  const builtins = new Set(builtinModules);
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string): unknown => {
    required.push(name);
    const bare = name.startsWith("node:") ? name.slice("node:".length) : name;
    if (!builtins.has(bare)) throw new Error(`The bundle requires ${name}, and the runtime of Twilio does not give it.`);
    return process.getBuiltinModule(name);
  };
  const runtime = { getAssets: () => ({ [OUTAGE_LIST_ASSET]: { open: () => JSON.stringify(LIST) } }) };
  const twilio = { Response: FakeResponse };
  const base = {
    console: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
    ...Object.fromEntries(NODE_GLOBALS.map((name) => [name, Reflect.get(globalThis, name)])),
  };
  if (scope === "globals") {
    runInContext(bundle.code, createContext({ ...base, module, exports: module.exports, require, Runtime: runtime, Twilio: twilio }), { filename: `${bundle.path}.js` });
  } else {
    const wrapper = compileFunction(bundle.code, ["exports", "require", "module", "Runtime", "Twilio"], { parsingContext: createContext(base), filename: `${bundle.path}.js` });
    Reflect.apply(wrapper, undefined, [module.exports, require, module, runtime, twilio]);
  }
  const handler = module.exports["handler"];
  if (typeof handler !== "function") throw new Error(`The bundle of ${bundle.path} has no handler.`);
  return { handler: (context, event, callback) => Reflect.apply(handler, undefined, [context, event, callback]), required, lines };
}

function fakeCalls(created: RuntimeCallOptions[]): RuntimeCalls {
  return Object.assign((_sid: string) => ({ update: async () => ({}) }), {
    create: async (options: RuntimeCallOptions) => {
      created.push(options);
      return { sid: "CA0000" };
    },
    list: async () => [],
  });
}

async function invoke(loaded: Loaded, event: Record<string, unknown>, created: RuntimeCallOptions[] = []): Promise<FakeResponse> {
  const context: RuntimeContext = { DOMAIN_NAME: "outage-0000.twil.io", OUTAGE_TOKEN: "token-0000", OUTAGE_FROM: "+15555550100", getTwilioClient: () => ({ calls: fakeCalls(created), messages: { create: async () => ({ sid: "SM0000" }), list: async () => [] } }) };
  return new Promise((resolve, reject) => {
    loaded.handler(context, event, (error, response) => (error === null && response instanceof FakeResponse ? resolve(response) : reject(error)));
  });
}

describe("withoutStoreFolders", () => {
  it("removes the folder of the store from each module path, with a short and a long name of the folder", () => {
    const code = [
      `// ../../node_modules/.pnpm/twilio@5.0.0/node_modules/twilio/lib/index.js`,
      `var require_index = __commonJS({ "../../node_modules/.pnpm/@scope+name@1.2.3_@_0123456789abcdef0123456789abcdef/node_modules/@scope/name/x.js"(exports) {} });`,
      `// src/functions/outage.ts`,
    ].join("\n");
    expect(withoutStoreFolders(code)).toBe(
      [
        `// ../../node_modules/twilio/lib/index.js`,
        `var require_index = __commonJS({ "../../node_modules/@scope/name/x.js"(exports) {} });`,
        `// src/functions/outage.ts`,
      ].join("\n"),
    );
  });

  it("gives the same text for the names of a store on two hosts", () => {
    const windows = `// ../../node_modules/.pnpm/@scope+name@1.2.3_@_0123456789abcdef/node_modules/@scope/name/x.js`;
    const linux = `// ../../node_modules/.pnpm/@scope+name@1.2.3_@scope+peer@4.5.6_other@7.8.9/node_modules/@scope/name/x.js`;
    expect(withoutStoreFolders(windows)).toBe(withoutStoreFolders(linux));
  });

  it("keeps a text with no folder of the store", () => {
    for (const text of ["", "// src/functions/outage.ts", "node_modules/twilio/x.js", "a .pnpm b"]) expect(withoutStoreFolders(text)).toBe(text);
  });
});

describe("bundleFunctions", () => {
  let bundles: FunctionBundle[] = [];
  let build: BundleBuild = { bundles: [], inputs: [] };
  beforeAll(async () => {
    build = await bundleBuild();
    bundles = [...build.bundles];
  }, 60_000);

  it("gives the module files that esbuild read: the source of each Function, the core and the packages of the store (AL-112)", () => {
    expect(build.inputs).toEqual(expect.arrayContaining(["src/functions/outage.ts", "src/functions/press.ts", "src/functions/ended.ts", "src/outage.ts"]));
    expect(build.inputs.some((input) => input.startsWith("../core/src/"))).toBe(true);
    expect(build.inputs.some((input) => input.startsWith("../../node_modules/"))).toBe(true);
    expect(build.inputs.filter((input) => input.includes("\\") || /^(?:[a-z]:)?\//iu.test(input))).toEqual([]);
  });

  it("gives a file of the bundles that the check of a deploy passes, and the same code for the same sources (AL-112)", async () => {
    const file = await bundleFileOf(build);
    expect(Object.keys(file.inputs)).toEqual(expect.arrayContaining([...build.inputs, "../../pnpm-lock.yaml", "../core/package.json"]));
    expect(await checkBundleFile(bundleFileText(file))).toEqual({ ok: true, bundles });
    expect((await bundleFunctions()).map((bundle) => bundle.code)).toEqual(bundles.map((bundle) => bundle.code));
  }, 60_000);

  it("gives one bundle for each path: a public entry and two protected Functions", () => {
    expect(bundles.map((bundle) => [bundle.path, bundle.visibility])).toEqual([
      [OUTAGE_PATHS.entry, "public"],
      [OUTAGE_PATHS.press, "protected"],
      [OUTAGE_PATHS.ended, "protected"],
    ]);
  });

  it("gives the same code from each start folder, with each module path relative to the package", async () => {
    // esbuild reads the start folder when it loads. Thus a second process starts in another folder and makes the bundles.
    const hash = (code: string) => createHash("sha256").update(code).digest("hex");
    const script = `const { bundleFunctions } = await import(process.env.BUNDLE_MODULE); const { createHash } = await import("node:crypto");
      console.log(JSON.stringify((await bundleFunctions()).map((bundle) => createHash("sha256").update(bundle.code).digest("hex"))));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd() === tmpdir() ? join(tmpdir(), "..") : tmpdir(),
      env: { ...process.env, BUNDLE_MODULE: new URL("./bundle.ts", import.meta.url).href },
      encoding: "utf8",
    });
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual(bundles.map((bundle) => hash(bundle.code)));
    // The comment of each module gives its path from the package. A start folder or an absolute path is not in the code.
    for (const bundle of bundles) {
      const paths = [...bundle.code.matchAll(/^\/\/ (.+)$/gmu)].map((match) => match[1]!);
      expect(paths, bundle.path).toContain(`src/functions/${bundle.path.slice(1)}.ts`);
      expect(paths.filter((path) => /^(?:[a-z]:)?[\\/]|\\/iu.test(path)), bundle.path).toEqual([]);
    }
  }, 60_000);

  it("gives code with no folder of the store of pnpm, thus each host gives the same version for one commit", () => {
    for (const bundle of bundles) {
      expect(bundle.code, bundle.path).not.toContain("node_modules/.pnpm/");
      expect(bundle.code, bundle.path).toMatch(/^\/\/ \.\.\/\.\.\/node_modules\/[^.]/mu);
    }
  });

  it("gives bundles that require only the Node built-ins, and that hold no send code of the channel", () => {
    for (const bundle of bundles) {
      load(bundle);
      const named = [...bundle.code.matchAll(/\brequire\("([^"]+)"\)/gu)].map((match) => match[1]!.replace(/^node:/u, ""));
      expect(named.filter((name) => !builtinModules.includes(name))).toEqual([]);
      expect(bundle.code).not.toContain("polite-crawler");
    }
  });

  it("starts the calls in the bundle of the entry", async () => {
    const created: RuntimeCallOptions[] = [];
    const response = await invoke(load(bundles[0]!), { token: "token-0000", status: "down" }, created);
    expect(response.status).toBe(200);
    expect(response.body).toBe(JSON.stringify({ calls: 1 }));
    expect(created.map((call) => [call.to, call.from])).toEqual([["+15555550123", "+15555550100"]]);
    expect(created[0]!.twiml).toContain("<Gather");
  });

  it("starts the calls and says the confirmed text when Runtime and Twilio are only names of a wrapper", async () => {
    const created: RuntimeCallOptions[] = [];
    const entry = await invoke(load(bundles[0]!, "wrapper"), { token: "token-0000", status: "down" }, created);
    expect(entry.status).toBe(200);
    expect(created.map((call) => call.to)).toEqual(["+15555550123"]);
    const event = { outage: "60000000", person: "0", step: "0", round: "0", list: "v1", Digits: "1", CallSid: "CA0001" };
    expect((await invoke(load(bundles[1]!, "wrapper"), event)).body).toContain(`<Say>${OUTAGE_TEXTS.confirmed}</Say>`);
  });

  it("refuses a wrong token in the bundle of the entry", async () => {
    expect((await invoke(load(bundles[0]!), { token: "token-0001" })).status).toBe(403);
  });

  it("says the confirmed text in the bundle of the press Function", async () => {
    const event = { outage: "60000000", person: "0", step: "0", round: "0", list: "v1", Digits: "1", CallSid: "CA0001" };
    const response = await invoke(load(bundles[1]!), event);
    expect(response.headers).toEqual([["Content-Type", "text/xml"]]);
    expect(response.body).toContain(`<Say>${OUTAGE_TEXTS.confirmed}</Say>`);
  });

  it("starts the next call in the bundle of the end Function", async () => {
    const created: RuntimeCallOptions[] = [];
    const event = { outage: "60000000", person: "0", step: "0", round: "0", list: "v1", CallStatus: "busy" };
    const response = await invoke(load(bundles[2]!), event, created);
    expect(response.body).toBe(JSON.stringify({ calls: 1 }));
    expect(new URL(created[0]!.statusCallback).searchParams.get("step")).toBe("1");
  });
});
